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

  app.get('/api/notifications/channel-status', requireAuth, (_req: AuthRequest, res) => {
    const emailWebhookUrl = (process.env.NOTIFICATION_EMAIL_WEBHOOK_URL || '').trim();
    const whatsappWebhookUrl = (process.env.NOTIFICATION_WHATSAPP_WEBHOOK_URL || '').trim();
    res.json({
      emailApiConfigured: Boolean(emailWebhookUrl && /^https:\/\//i.test(emailWebhookUrl)),
      whatsappApiConfigured: Boolean(whatsappWebhookUrl && /^https:\/\//i.test(whatsappWebhookUrl)),
    });
  });

  app.post('/api/notifications/send', requireAuth, async (req: AuthRequest, res) => {
    try {
      const body = (req.body ?? {}) as {
        channel?: string;
        recipientAddress?: string;
        recipientName?: string;
        subject?: string;
        message?: string;
      };
      const channel = typeof body.channel === 'string' ? body.channel : '';
      const recipientAddress =
        typeof body.recipientAddress === 'string' ? body.recipientAddress.trim().slice(0, 120) : '';
      const recipientName =
        typeof body.recipientName === 'string' ? body.recipientName.trim().slice(0, 120) : '';
      const subject =
        typeof body.subject === 'string' ? body.subject.trim().slice(0, 200) : '';
      const message =
        typeof body.message === 'string' ? body.message.trim().slice(0, 2000) : '';

      if (!recipientAddress || !message) {
        res.status(400).json({ error: 'Recipient contact and message are required.' });
        return;
      }

      if (channel === 'Email') {
        const webhookUrl = (process.env.NOTIFICATION_EMAIL_WEBHOOK_URL || '').trim();
        const webhookToken = (process.env.NOTIFICATION_EMAIL_WEBHOOK_TOKEN || '').trim();
        if (!webhookUrl || !/^https:\/\//i.test(webhookUrl)) {
          res.status(501).json({
            configured: false,
            fallback: 'manual',
            error: 'Automatic Email API is not configured. Use manual email handoff instead.',
          });
          return;
        }
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (webhookToken) headers.Authorization = `Bearer ${webhookToken}`;
        const upstream = await fetch(webhookUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            to: recipientAddress,
            recipientName,
            subject: subject || 'Vehicle Document Expiry Reminder — BAPASITARAM ENTERPRISE',
            text: message,
          }),
        });
        if (!upstream.ok) {
          res.status(502).json({ error: `Email delivery gateway returned HTTP ${upstream.status}.` });
          return;
        }
        res.json({ sent: true, channel: 'Email' });
        return;
      }

      if (channel === 'WhatsApp (API)') {
        const webhookUrl = (process.env.NOTIFICATION_WHATSAPP_WEBHOOK_URL || '').trim();
        const webhookToken = (process.env.NOTIFICATION_WHATSAPP_WEBHOOK_TOKEN || '').trim();
        if (!webhookUrl || !/^https:\/\//i.test(webhookUrl)) {
          res.status(501).json({
            configured: false,
            fallback: 'manual',
            error: 'Automatic WhatsApp API is not configured. Use manual WhatsApp sharing instead.',
          });
          return;
        }
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (webhookToken) headers.Authorization = `Bearer ${webhookToken}`;
        const upstream = await fetch(webhookUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            to: recipientAddress,
            recipientName,
            text: message,
          }),
        });
        if (!upstream.ok) {
          res.status(502).json({ error: `WhatsApp API gateway returned HTTP ${upstream.status}.` });
          return;
        }
        res.json({ sent: true, channel: 'WhatsApp (API)' });
        return;
      }

      res.status(400).json({ error: 'Unsupported notification channel.' });
    } catch (error) {
      console.error('Notification dispatch error:', error);
      res.status(500).json({ error: 'Unable to dispatch notification right now.' });
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
