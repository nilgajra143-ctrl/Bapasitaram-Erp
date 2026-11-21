import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  Bot,
  ExternalLink,
  Globe,
  Loader2,
  MapPin,
  Navigation,
  Send,
  Sparkles,
  Trash2,
  User as UserIcon,
  Zap,
} from 'lucide-react';
import type {
  Bill,
  CompanySettings,
  Driver,
  Party,
  PartyPayment,
  Trip,
  Vehicle,
} from '../types/erp';
import { computePartyLedgerSummary } from '../utils/erpHelpers';
import { formatINR } from '../utils/formatters';

type AssistantMode = 'erp-chat' | 'google-search' | 'google-maps';
type AllowedModel = 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';

interface GroundingWebSource {
  uri: string;
  title: string;
}

interface GroundingMapReview {
  uri: string;
  title: string;
  text?: string;
}

interface GroundingMapSource {
  uri: string;
  title: string;
  reviews?: GroundingMapReview[];
}

interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  mode: AssistantMode;
  model?: AllowedModel;
  webSources?: GroundingWebSource[];
  mapSources?: GroundingMapSource[];
  timestamp: string;
}

interface ErpAssistantViewProps {
  user: User;
  vehicles: Vehicle[];
  parties: Party[];
  partyPayments: PartyPayment[];
  trips: Trip[];
  drivers: Driver[];
  bills: Bill[];
  companySettings: CompanySettings | null;
}

const MODE_OPTIONS: Array<{
  id: AssistantMode;
  label: string;
  shortDesc: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    id: 'erp-chat',
    label: 'ERP Assistant',
    shortDesc: 'Analyze live trips, party balances, fleet & expenses',
    icon: Sparkles,
  },
  {
    id: 'google-search',
    label: 'Google Search',
    shortDesc: 'Live diesel rates, GST/e-way bill rules & highway news',
    icon: Globe,
  },
  {
    id: 'google-maps',
    label: 'Google Maps',
    shortDesc: 'Find diesel pumps, weighbridges, port yards & workshops',
    icon: MapPin,
  },
];

const QUICK_PROMPTS: Record<AssistantMode, string[]> = {
  'erp-chat': [
    'Summarize our top 5 parties with the highest outstanding balances.',
    'Give an overview of total freight, diesel quantity, diesel amount, and net balance.',
    'Which vehicles have the most trips and highest diesel expenses?',
    'Draft a polite payment follow-up message for parties with overdue balances.',
  ],
  'google-search': [
    'What is the latest diesel price per liter in Gujarat (Rajkot / Ahmedabad / Gandhidham)?',
    'Summarize current Indian GST e-Way Bill rules and validity period for road freight.',
    'Check recent NHAI FASTag toll updates for commercial trucks in India.',
  ],
  'google-maps': [
    'Find 24-hour diesel fuel pumps and truck stops near Mundra Port, Gujarat.',
    'Locate heavy vehicle weighbridges (Dharam Kanta) near Gandhidham & Kandla highway.',
    'Find commercial truck repair workshops along NH-48 between Ahmedabad and Surat.',
  ],
};

function isSafeHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Pure React Markdown renderer (bold, inline code, links, headings, bullet/numbered lists)
 * without using dangerouslySetInnerHTML.
 */
function renderInlineMarkdown(text: string): React.ReactNode[] {
  const tokenRegex = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let keyIdx = 0;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      parts.push(
        <strong key={`b-${keyIdx++}`} className="font-semibold text-slate-900">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(
        <code
          key={`c-${keyIdx++}`}
          className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-800 font-mono text-xs"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token);
      if (linkMatch && isSafeHttpUrl(linkMatch[2])) {
        parts.push(
          <a
            key={`a-${keyIdx++}`}
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sky-700 underline hover:text-sky-900 break-all"
          >
            {linkMatch[1]}
          </a>
        );
      } else {
        parts.push(token);
      }
    }
    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}

function FormattedMarkdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let listItems: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let blockKey = 0;

  const flushList = () => {
    if (listItems.length === 0 || !listType) return;
    if (listType === 'ul') {
      blocks.push(
        <ul key={`ul-${blockKey++}`} className="list-disc pl-5 space-y-1 my-1.5">
          {listItems.map((item, idx) => (
            <li key={idx} className="leading-relaxed">
              {renderInlineMarkdown(item)}
            </li>
          ))}
        </ul>
      );
    } else {
      blocks.push(
        <ol key={`ol-${blockKey++}`} className="list-decimal pl-5 space-y-1 my-1.5">
          {listItems.map((item, idx) => (
            <li key={idx} className="leading-relaxed">
              {renderInlineMarkdown(item)}
            </li>
          ))}
        </ol>
      );
    }
    listItems = [];
    listType = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      flushList();
      continue;
    }

    const ulMatch = /^[-*•]\s+(.*)$/.exec(trimmed);
    const olMatch = /^\d+\.\s+(.*)$/.exec(trimmed);

    if (ulMatch) {
      if (listType === 'ol') flushList();
      listType = 'ul';
      listItems.push(ulMatch[1]);
      continue;
    }

    if (olMatch) {
      if (listType === 'ul') flushList();
      listType = 'ol';
      listItems.push(olMatch[1]);
      continue;
    }

    flushList();

    if (trimmed.startsWith('### ')) {
      blocks.push(
        <h4 key={`h4-${blockKey++}`} className="font-display text-sm font-semibold text-slate-900 mt-3 mb-1">
          {renderInlineMarkdown(trimmed.slice(4))}
        </h4>
      );
    } else if (trimmed.startsWith('## ')) {
      blocks.push(
        <h3 key={`h3-${blockKey++}`} className="font-display text-sm font-semibold text-slate-900 mt-3 mb-1">
          {renderInlineMarkdown(trimmed.slice(3))}
        </h3>
      );
    } else if (trimmed.startsWith('# ')) {
      blocks.push(
        <h3 key={`h2-${blockKey++}`} className="font-display text-base font-semibold text-slate-900 mt-3 mb-1">
          {renderInlineMarkdown(trimmed.slice(2))}
        </h3>
      );
    } else {
      blocks.push(
        <p key={`p-${blockKey++}`} className="leading-relaxed my-1">
          {renderInlineMarkdown(trimmed)}
        </p>
      );
    }
  }

  flushList();

  return <div className="text-sm text-slate-700 space-y-1">{blocks}</div>;
}

export const ErpAssistantView: React.FC<ErpAssistantViewProps> = ({
  user,
  vehicles,
  parties,
  partyPayments,
  trips,
  drivers,
  bills,
  companySettings,
}) => {
  const [mode, setMode] = useState<AssistantMode>('erp-chat');
  const [model, setModel] = useState<AllowedModel>('gemini-4-hydrogen');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userLocation, setUserLocation] = useState<{ latitude: number; longitude: number } | null>(
    null
  );
  const [locating, setLocating] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'model',
      mode: 'erp-chat',
      model: 'gemini-4-hydrogen',
      text:
        'Hello! I am the **BAPASITARAM ENTERPRISE Transport Assistant**.\n\n' +
        '- **ERP Assistant**: Ask questions about your live trips, party outstanding balances, fleet utilization, and separate Diesel Quantity vs Diesel Amount totals.\n' +
        '- **Google Search**: Look up live Indian diesel prices, NHAI toll updates, and GST / e-Way Bill transport rules with web citations.\n' +
        '- **Google Maps**: Find verified diesel pumps, weighbridges, transport hubs, and workshops with direct Google Maps links.',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  ]);

  const threadEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  // Build compact read-only live ERP snapshot for accurate internal answers
  const erpContextSnapshot = useMemo(() => {
    const activeTrips = trips.filter((t) => t.tripStatus !== 'Cancelled');
    const totalFreight = activeTrips.reduce((s, t) => s + (Number(t.freightAmount) || 0), 0);
    const totalAdvance = activeTrips.reduce((s, t) => s + (Number(t.advanceReceived) || 0), 0);
    const totalDieselQty = activeTrips.reduce((s, t) => s + (Number(t.dieselQuantity) || 0), 0);
    const totalDieselAmount = activeTrips.reduce((s, t) => s + (Number(t.dieselExpense) || 0), 0);
    const totalToll = activeTrips.reduce((s, t) => s + (Number(t.tollExpense) || 0), 0);
    const totalDriverAllowance = activeTrips.reduce((s, t) => s + (Number(t.driverAllowance) || 0), 0);
    const totalPartyPayments = partyPayments.reduce((s, p) => s + (Number(p.amount) || 0), 0);

    const partySummaries = parties
      .map((party) => {
        const ledger = computePartyLedgerSummary(party.id, trips, partyPayments);
        return {
          name: party.partyName,
          city: party.city,
          trips: ledger.tripCount,
          freight: ledger.totalFreight,
          payments: ledger.paymentsReceivedTotal,
          advances: ledger.tripAdvanceReceived + ledger.ledgerAdvancesTotal,
          outstanding: ledger.netOutstanding,
        };
      })
      .sort((a, b) => b.outstanding - a.outstanding)
      .slice(0, 12);

    const vehicleTripCounts = vehicles
      .map((v) => {
        const vTrips = activeTrips.filter(
          (t) =>
            t.vehicleId === v.id ||
            t.vehicleNumber.trim().toUpperCase() === v.registrationNumber.trim().toUpperCase()
        );
        const freight = vTrips.reduce((s, t) => s + (Number(t.freightAmount) || 0), 0);
        const dieselQty = vTrips.reduce((s, t) => s + (Number(t.dieselQuantity) || 0), 0);
        const dieselAmt = vTrips.reduce((s, t) => s + (Number(t.dieselExpense) || 0), 0);
        return {
          reg: v.registrationNumber,
          type: v.vehicleType,
          status: v.status,
          tripCount: vTrips.length,
          freight,
          dieselQty,
          dieselAmt,
        };
      })
      .sort((a, b) => b.tripCount - a.tripCount)
      .slice(0, 12);

    const recentTrips = activeTrips.slice(0, 10).map((t) => ({
      date: t.tripDate,
      lr: t.lrNumber,
      vehicle: t.vehicleNumber,
      party: t.partyName,
      route: `${t.origin || '-'} -> ${t.destination || '-'}`,
      freight: t.freightAmount,
      dieselQtyL: t.dieselQuantity ?? 0,
      dieselAmtINR: t.dieselExpense,
      status: t.tripStatus,
    }));

    return [
      `Company: ${companySettings?.companyName || 'BAPASITARAM ENTERPRISE'}`,
      `Counts: ${vehicles.length} vehicles, ${parties.length} parties, ${drivers.length} drivers, ${activeTrips.length} active trips (${trips.length} total), ${partyPayments.length} party payment entries, ${bills.length} bills.`,
      `Totals: Freight=${formatINR(totalFreight)}, Trip Advances=${formatINR(totalAdvance)}, Party Ledger Payments=${formatINR(totalPartyPayments)}, Diesel Quantity=${totalDieselQty.toFixed(2)} L, Diesel Amount=${formatINR(totalDieselAmount)}, Toll=${formatINR(totalToll)}, Driver Allowance=${formatINR(totalDriverAllowance)}, Default Diesel Rate=₹${companySettings?.defaultDieselRate ?? 98.34}/L.`,
      `Top Parties by Outstanding: ${JSON.stringify(partySummaries)}`,
      `Top Vehicles: ${JSON.stringify(vehicleTripCounts)}`,
      `Recent Trips: ${JSON.stringify(recentTrips)}`,
    ].join('\n');
  }, [vehicles, parties, partyPayments, trips, drivers, bills, companySettings]);

  const handleRequestLocation = () => {
    if (!('geolocation' in navigator)) {
      setError('Location services are not available in this browser.');
      return;
    }
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLocation({
          latitude: Number(pos.coords.latitude.toFixed(5)),
          longitude: Number(pos.coords.longitude.toFixed(5)),
        });
        setLocating(false);
      },
      () => {
        setError('Could not read browser location. You can still type any city, port, or highway.');
        setLocating(false);
      },
      { enableHighAccuracy: false, timeout: 8000 }
    );
  };

  const sendMessage = async (promptOverride?: string) => {
    const textToSend = (promptOverride ?? input).trim();
    if (!textToSend || sending) return;

    setError(null);
    const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      text: textToSend,
      mode,
      timestamp: nowTime,
    };

    const nextHistory = messages
      .filter((m) => m.id !== 'welcome')
      .map((m) => ({ role: m.role, text: m.text }));

    setMessages((prev) => [...prev, userMsg]);
    if (!promptOverride) {
      setInput('');
    }
    setSending(true);

    try {
      const idToken = await user.getIdToken();
      const response = await fetch('/api/gemini/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          message: textToSend,
          mode,
          model: mode === 'erp-chat' ? model : 'gemini-4-hydrogen',
          history: nextHistory,
          erpContext: mode === 'erp-chat' ? erpContextSnapshot : undefined,
          location: mode === 'google-maps' && userLocation ? userLocation : undefined,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || 'Assistant request failed. Please try again.');
      }

      const modelMsg: ChatMessage = {
        id: `m-${Date.now()}`,
        role: 'model',
        text: data.reply || 'No response received.',
        mode: data.mode || mode,
        model: data.model || model,
        webSources: Array.isArray(data.webSources) ? data.webSources : [],
        mapSources: Array.isArray(data.mapSources) ? data.mapSources : [],
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      setMessages((prev) => [...prev, modelMsg]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unable to contact AI assistant.';
      setError(msg);
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void sendMessage();
  };

  const handleClearChat = () => {
    setMessages((prev) => prev.slice(0, 1));
    setError(null);
  };

  const activeModeMeta = MODE_OPTIONS.find((m) => m.id === mode) ?? MODE_OPTIONS[0];

  return (
    <div className="space-y-5">
      {/* Header Controls Card */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900">
              Transport ERP AI Assistant
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Multi-turn assistant with read-only ERP ledger awareness, live Google Search data, and Google Maps place grounding.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {mode === 'erp-chat' && (
              <div className="inline-flex items-center bg-slate-100 rounded-lg p-1 border border-slate-200">
                <button
                  type="button"
                  onClick={() => setModel('gemini-4-hydrogen')}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                    model === 'gemini-4-hydrogen'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Standard</span>
                </button>
                <button
                  type="button"
                  onClick={() => setModel('gemini-3.1-flash-lite')}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                    model === 'gemini-3.1-flash-lite'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Zap className="w-3.5 h-3.5" />
                  <span>Fast</span>
                </button>
              </div>
            )}

            {mode === 'google-maps' && (
              <button
                type="button"
                onClick={handleRequestLocation}
                disabled={locating}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 cursor-pointer disabled:opacity-60"
              >
                <Navigation className="w-3.5 h-3.5 text-sky-700" />
                <span>
                  {locating
                    ? 'Locating...'
                    : userLocation
                      ? `Location Bias (${userLocation.latitude.toFixed(2)}, ${userLocation.longitude.toFixed(2)})`
                      : 'Use My Location'}
                </span>
              </button>
            )}

            <button
              type="button"
              onClick={handleClearChat}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear Thread</span>
            </button>
          </div>
        </div>

        {/* Mode Selector Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {MODE_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const selected = mode === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setMode(opt.id)}
                className={`text-left p-3.5 rounded-xl border transition-colors cursor-pointer ${
                  selected
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-slate-50/70 text-slate-700 border-slate-200 hover:bg-slate-100/80'
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{opt.label}</span>
                </div>
                <p
                  className={`text-xs mt-1 leading-snug ${
                    selected ? 'text-slate-300' : 'text-slate-500'
                  }`}
                >
                  {opt.shortDesc}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Chat Container */}
      <div className="bg-white border border-slate-200 rounded-xl flex flex-col h-[620px] overflow-hidden">
        {/* Scrollable Message Thread */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4 bg-slate-50/40">
          {messages.map((msg) => {
            const isUser = msg.role === 'user';
            return (
              <div
                key={msg.id}
                className={`flex gap-3 ${isUser ? 'justify-end' : 'justify-start'}`}
              >
                {!isUser && (
                  <div className="w-8 h-8 rounded-lg bg-slate-900 text-white flex items-center justify-center shrink-0 mt-0.5">
                    <Bot className="w-4 h-4" />
                  </div>
                )}

                <div
                  className={`max-w-[85%] sm:max-w-[78%] rounded-xl px-4 py-3 border ${
                    isUser
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-800 border-slate-200'
                  }`}
                >
                  <div
                    className={`flex items-center gap-2 text-[11px] mb-1.5 ${
                      isUser ? 'text-slate-300' : 'text-slate-400'
                    }`}
                  >
                    <span className="font-medium">
                      {isUser ? user.displayName || 'You' : 'ERP Assistant'}
                    </span>
                    <span>•</span>
                    <span>
                      {msg.mode === 'google-search'
                        ? 'Google Search Grounding'
                        : msg.mode === 'google-maps'
                          ? 'Google Maps Grounding'
                          : 'ERP Workspace'}
                    </span>
                    <span>•</span>
                    <span>{msg.timestamp}</span>
                  </div>

                  {isUser ? (
                    <div className="text-sm whitespace-pre-wrap leading-relaxed">{msg.text}</div>
                  ) : (
                    <FormattedMarkdown text={msg.text} />
                  )}

                  {/* Grounding Citations: Google Search Web Sources */}
                  {!isUser && msg.webSources && msg.webSources.length > 0 && (
                    <div className="mt-3 pt-2.5 border-t border-slate-100 space-y-1.5">
                      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        <Globe className="w-3.5 h-3.5 text-sky-700" />
                        <span>Google Search Sources</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {msg.webSources.map((src, idx) => (
                          <a
                            key={`${msg.id}-w-${idx}`}
                            href={src.uri}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-700 transition-colors max-w-full"
                          >
                            <span className="truncate max-w-[260px]">{src.title}</span>
                            <ExternalLink className="w-3 h-3 shrink-0 text-slate-400" />
                          </a>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Grounding Citations: Google Maps Place & Review Sources */}
                  {!isUser && msg.mapSources && msg.mapSources.length > 0 && (
                    <div className="mt-3 pt-2.5 border-t border-slate-100 space-y-2">
                      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        <MapPin className="w-3.5 h-3.5 text-emerald-700" />
                        <span>Google Maps Places</span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {msg.mapSources.map((place, idx) => (
                          <div
                            key={`${msg.id}-m-${idx}`}
                            className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1"
                          >
                            <a
                              href={place.uri}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-900 hover:text-sky-700"
                            >
                              <span className="truncate">{place.title}</span>
                              <ExternalLink className="w-3 h-3 shrink-0" />
                            </a>
                            {place.reviews && place.reviews.length > 0 && (
                              <div className="space-y-1 pt-1">
                                {place.reviews.slice(0, 2).map((rev, rIdx) => (
                                  <div key={rIdx} className="text-[11px] text-slate-600">
                                    {rev.text && <p className="line-clamp-2 italic">“{rev.text}”</p>}
                                    <a
                                      href={rev.uri}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-sky-700 hover:underline inline-flex items-center gap-1"
                                    >
                                      <span>{rev.title}</span>
                                      <ExternalLink className="w-2.5 h-2.5" />
                                    </a>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {isUser && (
                  <div className="w-8 h-8 rounded-lg bg-slate-200 text-slate-700 flex items-center justify-center shrink-0 mt-0.5">
                    <UserIcon className="w-4 h-4" />
                  </div>
                )}
              </div>
            );
          })}

          {sending && (
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-slate-900 text-white flex items-center justify-center shrink-0">
                <Bot className="w-4 h-4" />
              </div>
              <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 text-xs text-slate-600 inline-flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-slate-700" />
                <span>
                  {mode === 'google-search'
                    ? 'Searching live web data...'
                    : mode === 'google-maps'
                      ? 'Searching Google Maps places...'
                      : 'Analyzing ERP data...'}
                </span>
              </div>
            </div>
          )}

          <div ref={threadEndRef} />
        </div>

        {/* Quick Prompts Strip */}
        <div className="px-4 py-2.5 bg-white border-t border-slate-200 flex items-center gap-2 overflow-x-auto">
          <span className="text-[11px] font-medium text-slate-400 shrink-0">Suggested:</span>
          {QUICK_PROMPTS[mode].map((preset, idx) => (
            <button
              key={idx}
              type="button"
              disabled={sending}
              onClick={() => void sendMessage(preset)}
              className="px-2.5 py-1 text-xs rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 whitespace-nowrap shrink-0 transition-colors cursor-pointer disabled:opacity-50"
            >
              {preset}
            </button>
          ))}
        </div>

        {/* Error Alert */}
        {error && (
          <div className="px-4 py-2 bg-rose-50 border-t border-rose-200 text-xs text-rose-700">
            {error}
          </div>
        )}

        {/* Composer */}
        <form
          onSubmit={handleSubmit}
          className="p-3 sm:p-4 bg-white border-t border-slate-200 flex items-end gap-2.5"
        >
          <textarea
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendMessage();
              }
            }}
            placeholder={`Ask in ${activeModeMeta.label} mode... (Enter to send, Shift+Enter for new line)`}
            className="flex-1 resize-none px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900/15 focus:border-slate-500 min-h-[42px] max-h-32"
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[42px] bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer shrink-0"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            <span className="hidden sm:inline">Send</span>
          </button>
        </form>
      </div>
    </div>
  );
};
