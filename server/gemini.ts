import { GoogleGenAI, type Content } from '@google/genai';

export type AssistantMode = 'erp-chat' | 'google-search' | 'google-maps';
export type AllowedModel = 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';

export interface ChatTurnInput {
  role: 'user' | 'model';
  text: string;
}

export interface GroundingWebSource {
  uri: string;
  title: string;
}

export interface GroundingMapReview {
  uri: string;
  title: string;
  text?: string;
}

export interface GroundingMapSource {
  uri: string;
  title: string;
  reviews?: GroundingMapReview[];
}

export interface AssistantRequestPayload {
  message: string;
  mode: AssistantMode;
  model?: AllowedModel;
  history?: ChatTurnInput[];
  erpContext?: string;
  location?: {
    latitude: number;
    longitude: number;
  };
}

export interface AssistantResponsePayload {
  reply: string;
  model: AllowedModel;
  mode: AssistantMode;
  webSources: GroundingWebSource[];
  mapSources: GroundingMapSource[];
}

const ALLOWED_MODELS: ReadonlySet<AllowedModel> = new Set([
  'gemini-4-hydrogen',
  'gemini-3.1-flash-lite',
]);

const MAX_MESSAGE_LENGTH = 4000;
const MAX_CONTEXT_LENGTH = 6000;
const MAX_HISTORY_TURNS = 16;

let cachedClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw Object.assign(
      new Error('Gemini API key is not configured on the server. Please check Settings > Secrets.'),
      { statusCode: 500 }
    );
  }

  if (!cachedClient) {
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedClient;
}

function sanitizeSafeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function buildSystemInstruction(mode: AssistantMode, erpContext?: string): string {
  const baseLines = [
    'You are the Transport Operations & Accounts Assistant for BAPASITARAM ENTERPRISE (an Indian commercial fleet, container/truck transport, and freight ERP).',
    'Give clear, practical, structured answers using concise Markdown (short headings, bullet points, INR currency formatting with ₹).',
    'Never fabricate historical trip records, party payments, or balances. Rely only on the provided ERP snapshot for internal company numbers.',
    'Keep Diesel Quantity (liters) and Diesel Amount (₹) strictly separate when discussing trips or expenses. Never include Karja or Interest calculations.',
  ];

  if (mode === 'google-search') {
    baseLines.push(
      'You are running with live Google Search grounding enabled. Prioritize verified, up-to-date Indian transport, diesel price, NHAI toll, port advisory, and GST/e-way bill facts.'
    );
  } else if (mode === 'google-maps') {
    baseLines.push(
      'You are running with live Google Maps grounding enabled. Provide accurate, grounded logistics locations (diesel pumps, weighbridges, transport hubs, port yards, repair workshops, highway stops) based strictly on Maps results.'
    );
  }

  if (erpContext && erpContext.trim()) {
    const trimmedContext = erpContext.trim().slice(0, MAX_CONTEXT_LENGTH);
    baseLines.push(
      '',
      'Read-only live ERP snapshot from the signed-in user workspace (do not mutate):',
      trimmedContext
    );
  }

  return baseLines.join('\n');
}

function extractGroundingSources(response: unknown): {
  webSources: GroundingWebSource[];
  mapSources: GroundingMapSource[];
} {
  const webSources: GroundingWebSource[] = [];
  const mapSources: GroundingMapSource[] = [];
  const seenWeb = new Set<string>();
  const seenMaps = new Set<string>();

  const candidates = (response as { candidates?: Array<{ groundingMetadata?: { groundingChunks?: unknown[] } }> })
    ?.candidates;
  const chunks = candidates?.[0]?.groundingMetadata?.groundingChunks;
  if (!Array.isArray(chunks)) {
    return { webSources, mapSources };
  }

  for (const rawChunk of chunks) {
    if (!rawChunk || typeof rawChunk !== 'object') continue;
    const chunk = rawChunk as {
      web?: { uri?: string; title?: string };
      maps?: {
        uri?: string;
        title?: string;
        placeAnswerSources?: {
          reviewSnippets?: Array<{
            googleMapsUri?: string;
            uri?: string;
            title?: string;
            text?: string;
          }>;
        };
      };
    };

    if (chunk.web?.uri) {
      const safeUri = sanitizeSafeHttpUrl(chunk.web.uri);
      if (safeUri && !seenWeb.has(safeUri)) {
        seenWeb.add(safeUri);
        webSources.push({
          uri: safeUri,
          title: (chunk.web.title || safeUri).slice(0, 160),
        });
      }
    }

    if (chunk.maps) {
      const safeUri = sanitizeSafeHttpUrl(chunk.maps.uri);
      const reviews: GroundingMapReview[] = [];
      const rawReviews = chunk.maps.placeAnswerSources?.reviewSnippets;
      if (Array.isArray(rawReviews)) {
        for (const rev of rawReviews) {
          const revUri = sanitizeSafeHttpUrl(rev.googleMapsUri || rev.uri);
          if (revUri) {
            reviews.push({
              uri: revUri,
              title: (rev.title || 'Google Maps Review').slice(0, 140),
              text: typeof rev.text === 'string' ? rev.text.slice(0, 260) : undefined,
            });
          }
        }
      }

      if (safeUri && !seenMaps.has(safeUri)) {
        seenMaps.add(safeUri);
        mapSources.push({
          uri: safeUri,
          title: (chunk.maps.title || 'View on Google Maps').slice(0, 160),
          reviews: reviews.length > 0 ? reviews : undefined,
        });
      } else if (!safeUri && reviews.length > 0) {
        const firstReviewUri = reviews[0].uri;
        if (!seenMaps.has(firstReviewUri)) {
          seenMaps.add(firstReviewUri);
          mapSources.push({
            uri: firstReviewUri,
            title: (chunk.maps.title || reviews[0].title).slice(0, 160),
            reviews,
          });
        }
      }
    }
  }

  return { webSources, mapSources };
}

export async function runErpAssistant(
  payload: AssistantRequestPayload
): Promise<AssistantResponsePayload> {
  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  if (!message) {
    throw Object.assign(new Error('Message cannot be empty.'), { statusCode: 400 });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw Object.assign(
      new Error(`Message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters.`),
      { statusCode: 400 }
    );
  }

  const mode: AssistantMode =
    payload.mode === 'google-search' || payload.mode === 'google-maps'
      ? payload.mode
      : 'erp-chat';

  // Grounding with Google Search & Google Maps runs on gemini-4-hydrogen
  const requestedModel: AllowedModel =
    payload.model && ALLOWED_MODELS.has(payload.model)
      ? payload.model
      : 'gemini-4-hydrogen';
  const model: AllowedModel = mode === 'erp-chat' ? requestedModel : 'gemini-4-hydrogen';

  const historyTurns = Array.isArray(payload.history)
    ? payload.history
        .filter(
          (item): item is ChatTurnInput =>
            Boolean(item) &&
            (item.role === 'user' || item.role === 'model') &&
            typeof item.text === 'string' &&
            item.text.trim().length > 0
        )
        .slice(-MAX_HISTORY_TURNS)
    : [];

  const contents: Content[] = [
    ...historyTurns.map((turn) => ({
      role: turn.role,
      parts: [{ text: turn.text.trim().slice(0, MAX_MESSAGE_LENGTH) }],
    })),
    {
      role: 'user',
      parts: [{ text: message }],
    },
  ];

  const systemInstruction = buildSystemInstruction(mode, payload.erpContext);
  const ai = getGeminiClient();

  const config: Record<string, unknown> = {
    systemInstruction,
  };

  if (mode === 'google-search') {
    config.tools = [{ googleSearch: {} }];
  } else if (mode === 'google-maps') {
    // Strictly do not combine googleMaps with googleSearch, responseMimeType, or responseSchema
    config.tools = [{ googleMaps: {} }];
    if (
      payload.location &&
      typeof payload.location.latitude === 'number' &&
      typeof payload.location.longitude === 'number' &&
      Number.isFinite(payload.location.latitude) &&
      Number.isFinite(payload.location.longitude) &&
      payload.location.latitude >= -90 &&
      payload.location.latitude <= 90 &&
      payload.location.longitude >= -180 &&
      payload.location.longitude <= 180
    ) {
      config.toolConfig = {
        retrievalConfig: {
          latLng: {
            latitude: payload.location.latitude,
            longitude: payload.location.longitude,
          },
        },
      };
    }
  }

  const response = await ai.models.generateContent({
    model,
    contents,
    config,
  });

  const reply = (response.text ?? '').trim();
  const { webSources, mapSources } = extractGroundingSources(response);

  return {
    reply: reply || 'No response text was returned by the model. Please try rephrasing your question.',
    model,
    mode,
    webSources,
    mapSources,
  };
}
