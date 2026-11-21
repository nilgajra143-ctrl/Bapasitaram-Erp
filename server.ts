import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAuth, type AuthRequest } from './server/auth.ts';
import { runErpAssistant, type AssistantRequestPayload } from './server/gemini.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);

  app.use(express.json({ limit: '1mb' }));

  app.post('/api/gemini/chat', requireAuth, async (req: AuthRequest, res) => {
    try {
      const body = (req.body ?? {}) as AssistantRequestPayload;
      const result = await runErpAssistant(body);
      res.json(result);
    } catch (error: unknown) {
      const err = error as { status?: number; statusCode?: number; message?: string };
      console.error('Gemini assistant request error:', err);
      const status =
        typeof err.statusCode === 'number'
          ? err.statusCode
          : typeof err.status === 'number' && err.status >= 400 && err.status < 600
            ? err.status
            : 500;

      let clientMessage = err.message || 'Unable to process AI request right now.';
      if (status === 403 || clientMessage.includes('API_KEY_INVALID') || clientMessage.includes('PERMISSION_DENIED')) {
        clientMessage =
          'Gemini API authorization failed. Please verify the API key in Settings > Secrets.';
      } else if (status === 429 || clientMessage.includes('RESOURCE_EXHAUSTED')) {
        clientMessage =
          'Gemini API rate limit reached. Please wait a moment and try again.';
      }

      res.status(status).json({ error: clientMessage });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`BAPASITARAM ERP server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
