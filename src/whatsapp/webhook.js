import crypto from 'node:crypto';
import express from 'express';

export function webhookRouter({ messaging, verifyToken, appSecret, log = console }) {
  const r = express.Router();

  // Verifizierung beim Einrichten im Meta-Dashboard
  r.get('/', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && verifyToken && req.query['hub.verify_token'] === verifyToken) {
      return res.status(200).send(req.query['hub.challenge']);
    }
    res.sendStatus(403);
  });

  r.post('/', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (appSecret) {
      const sig = req.get('x-hub-signature-256') || '';
      const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(raw).digest('hex');
      if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        log.warn('[webhook] Ungültige Signatur – verworfen');
        return res.sendStatus(401);
      }
    } else {
      log.warn('[webhook] WHATSAPP_APP_SECRET nicht gesetzt – Signatur wird NICHT geprüft');
    }
    res.sendStatus(200); // Meta erwartet eine schnelle Antwort
    try { messaging.handleWebhook(JSON.parse(raw.toString('utf8'))); }
    catch (e) { log.error('[webhook] Verarbeitung fehlgeschlagen', e); }
  });

  return r;
}
