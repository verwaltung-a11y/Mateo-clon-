import path from 'node:path';
import express from 'express';
import { loadConfig, ROOT } from './config.js';
import { openDb, syncBranches } from './db.js';
import { WhatsAppClient } from './whatsapp/client.js';
import { webhookRouter } from './whatsapp/webhook.js';
import { Messaging, httpError } from './messaging.js';
import { createSession, clearSession, requireAuth, verifyPassword } from './auth.js';
import { runImport, startSync } from './akuwin/importer.js';
import { findCandidates, runAutomations, startScheduler, localDate, addDays } from './automations/engine.js';
import { formatPhone } from './phone.js';

export function createApp({ cfg, db, wa, log = console }) {
  const messaging = new Messaging(db, wa, { log });
  const app = express();
  app.disable('x-powered-by');

  app.use('/webhook', webhookRouter({ messaging, verifyToken: cfg.whatsapp.verifyToken, appSecret: cfg.whatsapp.appSecret, log }));
  app.use(express.json({ limit: '200kb' }));
  app.use(express.static(path.join(ROOT, 'public')));

  // ---------- Anmeldung ----------
  const loginAttempts = new Map();
  app.post('/api/login', (req, res) => {
    const { username = '', password = '' } = req.body || {};
    const key = `${req.ip}:${username}`;
    const a = loginAttempts.get(key) || { n: 0, t: Date.now() };
    if (a.n >= 10 && Date.now() - a.t < 15 * 60_000) return res.status(429).json({ error: 'Zu viele Versuche – bitte 15 Minuten warten' });
    const row = db.prepare('SELECT * FROM logins WHERE username=?').get(String(username).trim().toLowerCase());
    if (!row || !verifyPassword(password, row.password_hash)) {
      loginAttempts.set(key, { n: a.n + 1, t: a.n === 0 ? Date.now() : a.t });
      return res.status(401).json({ error: 'Benutzername oder Passwort falsch' });
    }
    loginAttempts.delete(key);
    createSession(res, { username: row.username, branchId: row.branch_id }, cfg.sessionSecret);
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

  const api = express.Router();
  api.use(requireAuth(cfg.sessionSecret));
  const adminOnly = (req, res, next) => (req.user.isAdmin ? next() : res.status(403).json({ error: 'Nur für Administratoren' }));

  const scopeBranch = (req) => (req.user.isAdmin ? (req.query.branch || null) : req.user.branchId);
  const loadConv = (req) => {
    const conv = messaging.conversation(Number(req.params.id));
    if (!conv || (!req.user.isAdmin && conv.branch_id !== req.user.branchId)) throw httpError(404, 'Konversation nicht gefunden');
    return conv;
  };
  const sentBy = (req) => String(req.body?.sentBy || '').trim().slice(0, 40) || req.user.username;

  api.get('/me', (req, res) => {
    res.json({
      user: req.user,
      branches: db.prepare('SELECT id, name, display_phone FROM branches ORDER BY name').all(),
      manualTemplates: cfg.automations.manualTemplates || [],
      dryRun: cfg.whatsapp.dryRun,
    });
  });

  // ---------- Konversationen ----------
  api.get('/conversations', (req, res) => {
    const branch = scopeBranch(req);
    const q = `%${String(req.query.q || '').trim()}%`;
    const status = req.query.status === 'done' ? 'done' : req.query.status === 'all' ? null : 'open';
    const rows = db.prepare(`
      SELECT cv.*, c.first_name, c.last_name, c.akuwin_id, b.name AS branch_name
      FROM conversations cv
      LEFT JOIN customers c ON c.id = cv.customer_id
      JOIN branches b ON b.id = cv.branch_id
      WHERE (? IS NULL OR cv.branch_id = ?) AND (? IS NULL OR cv.status = ?)
        AND (cv.wa_id LIKE ? OR IFNULL(c.first_name,'') || ' ' || IFNULL(c.last_name,'') LIKE ?
             OR IFNULL(cv.profile_name,'') LIKE ? OR IFNULL(c.akuwin_id,'') LIKE ?)
      ORDER BY cv.last_message_at DESC LIMIT 300`).all(branch, branch, status, status, q, q, q, q);
    res.json(rows.map((r) => ({ ...r, phone: formatPhone(r.wa_id), windowOpen: messaging.isWindowOpen(r) })));
  });

  api.get('/conversations/:id', (req, res) => {
    const conv = loadConv(req);
    const customer = messaging.customer(conv.customer_id);
    res.json({
      conversation: { ...conv, phone: formatPhone(conv.wa_id), windowOpen: messaging.isWindowOpen(conv) },
      messages: db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at, id').all(conv.id),
      customer,
      devices: customer ? db.prepare('SELECT * FROM devices WHERE customer_id=? ORDER BY fitted_at DESC').all(customer.id) : [],
    });
  });

  api.post('/conversations/:id/messages', async (req, res, next) => {
    try {
      const conv = loadConv(req);
      const body = String(req.body?.body || '').trim();
      if (!body) throw httpError(400, 'Nachricht ist leer');
      if (body.length > 4096) throw httpError(400, 'Nachricht zu lang (max. 4096 Zeichen)');
      res.json(await messaging.sendText(conv.id, body, sentBy(req)));
    } catch (e) { next(e); }
  });

  api.post('/conversations/:id/template', async (req, res, next) => {
    try {
      const conv = loadConv(req);
      const template = (cfg.automations.manualTemplates || [])[Number(req.body?.templateIndex)];
      if (!template) throw httpError(400, 'Unbekannte Vorlage');
      res.json(await messaging.sendTemplate({ conversationId: conv.id, template, sentBy: sentBy(req) }));
    } catch (e) { next(e); }
  });

  api.post('/conversations/:id/read', (req, res) => { messaging.markRead(loadConv(req).id); res.json({ ok: true }); });

  api.post('/conversations/:id/status', (req, res) => {
    const conv = loadConv(req);
    const status = req.body?.status === 'done' ? 'done' : 'open';
    db.prepare('UPDATE conversations SET status=?, unread=0 WHERE id=?').run(status, conv.id);
    res.json({ ok: true });
  });

  api.post('/conversations/:id/link', (req, res) => {
    const conv = loadConv(req);
    const cust = req.body?.customerId ? messaging.customer(Number(req.body.customerId)) : null;
    db.prepare('UPDATE conversations SET customer_id=? WHERE id=?').run(cust?.id ?? null, conv.id);
    res.json({ ok: true });
  });

  // Eingehende Medien (Bild, Sprachnachricht) über den Server abrufen – das Token bleibt serverseitig.
  api.get('/messages/:id/media', async (req, res, next) => {
    try {
      const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(Number(req.params.id));
      if (!msg?.media_id) throw httpError(404, 'Kein Medium');
      req.params.id = msg.conversation_id; loadConv(req);
      const { buffer, mimeType } = await wa.downloadMedia(msg.media_id);
      res.type(mimeType || 'application/octet-stream').set('Cache-Control', 'private, max-age=3600').send(buffer);
    } catch (e) { next(e); }
  });

  // ---------- Kunden ----------
  api.get('/customers', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const like = `%${q}%`;
    const digits = q.replace(/\D/g, '');
    res.json(db.prepare(`SELECT c.*, b.name AS branch_name FROM customers c LEFT JOIN branches b ON b.id=c.branch_id
      WHERE IFNULL(first_name,'') || ' ' || IFNULL(last_name,'') LIKE ? OR IFNULL(last_name,'') || ', ' || IFNULL(first_name,'') LIKE ?
        OR akuwin_id = ? OR (? <> '' AND mobile_e164 LIKE ?)
      ORDER BY last_name, first_name LIMIT 50`).all(like, like, q, digits, `%${digits.replace(/^0/, '')}%`)
      .map((c) => ({ ...c, phone: formatPhone(c.mobile_e164) })));
  });

  api.post('/customers/:id/template', async (req, res, next) => {
    try {
      const cust = messaging.customer(Number(req.params.id));
      if (!cust) throw httpError(404, 'Kunde nicht gefunden');
      const template = (cfg.automations.manualTemplates || [])[Number(req.body?.templateIndex)];
      if (!template) throw httpError(400, 'Unbekannte Vorlage');
      const branchId = req.user.isAdmin ? (req.body?.branchId || cust.branch_id) : req.user.branchId;
      const msg = await messaging.sendTemplate({ customerId: cust.id, branchId, template, sentBy: sentBy(req) });
      res.json({ conversationId: msg.conversation_id });
    } catch (e) { next(e); }
  });

  api.post('/customers/:id/optin', (req, res) => {
    const cust = messaging.customer(Number(req.params.id));
    if (!cust) return res.status(404).json({ error: 'Kunde nicht gefunden' });
    messaging.setOptIn({ customerId: cust.id, optIn: !!req.body?.optIn, source: `manuell:${sentBy(req)}` });
    res.json(messaging.customer(cust.id));
  });

  // ---------- Automationen & Import ----------
  api.get('/automations/preview', (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    const today = localDate();
    const branch = scopeBranch(req);
    const list = findCandidates(db, cfg.automations, today, addDays(today, days))
      .filter((c) => !branch || c.customer.branch_id === branch)
      .map((c) => ({
        rule: c.rule.label || c.rule.id, dueDate: c.dueDate, skipReason: c.skipReason, alreadySent: c.alreadySent,
        customer: { id: c.customer.id, akuwinId: c.customer.akuwin_id, name: `${c.customer.first_name || ''} ${c.customer.last_name || ''}`.trim(), branchId: c.customer.branch_id },
        device: c.device,
      }));
    res.json({ rules: cfg.automations.rules, list });
  });

  api.get('/automations/runs', (req, res) => {
    const branch = scopeBranch(req);
    res.json(db.prepare(`SELECT r.*, c.first_name, c.last_name, c.akuwin_id FROM automation_runs r
      JOIN customers c ON c.id=r.customer_id WHERE (? IS NULL OR c.branch_id=?)
      ORDER BY r.id DESC LIMIT 200`).all(branch, branch));
  });

  api.post('/automations/run', adminOnly, async (req, res, next) => {
    try { res.json(await runAutomations(db, messaging, cfg.automations, { log, force: true })); } catch (e) { next(e); }
  });

  api.post('/import', adminOnly, async (req, res, next) => {
    try { res.json(await runImport(db, cfg)); } catch (e) { next(httpError(400, e.message)); }
  });

  api.get('/import/log', adminOnly, (req, res) => {
    res.json(db.prepare('SELECT * FROM import_log ORDER BY id DESC LIMIT 20').all());
  });

  api.get('/stats', (req, res) => {
    const branch = scopeBranch(req);
    res.json(db.prepare(`SELECT COUNT(*) AS customers,
        SUM(mobile_e164 IS NOT NULL) AS withMobile, SUM(opt_in = 1) AS optedIn,
        SUM(opted_out_at IS NOT NULL) AS optedOut FROM customers WHERE (? IS NULL OR branch_id=?)`).get(branch, branch));
  });

  // ---------- Live-Updates (Server-Sent Events) ----------
  api.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = (type) => (ev) => {
      if (!req.user.isAdmin && ev.branchId !== req.user.branchId) return;
      res.write(`event: ${type}\ndata: ${JSON.stringify(ev)}\n\n`);
    };
    const onMsg = send('message'), onStatus = send('status');
    messaging.on('message', onMsg); messaging.on('status', onStatus);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(ping); messaging.off('message', onMsg); messaging.off('status', onStatus); });
  });

  app.use('/api', api);
  app.use((err, req, res, _next) => {
    if (!err.status) log.error(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Interner Fehler' });
  });

  return { app, messaging };
}

// ---------- Start ----------
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.js')) {
  const cfg = loadConfig();
  const db = openDb(cfg.dbFile);
  syncBranches(db, cfg.branches);
  const wa = new WhatsAppClient({ token: cfg.whatsapp.token, apiVersion: cfg.whatsapp.apiVersion, dryRun: cfg.whatsapp.dryRun });
  const { app, messaging } = createApp({ cfg, db, wa });
  if (!db.prepare('SELECT 1 FROM logins LIMIT 1').get()) {
    console.warn('[setup] Noch kein Login angelegt: npm run set-password -- admin <passwort>');
  }
  if (cfg.whatsapp.dryRun) console.warn('[whatsapp] DRY_RUN aktiv – es werden KEINE Nachrichten wirklich versendet.');
  startSync(db, cfg);
  startScheduler(db, messaging, cfg.automations);
  app.listen(cfg.port, () => console.log(`KundenDialog läuft auf http://localhost:${cfg.port}`));
}
