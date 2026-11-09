// Kernlogik: Konversationen, Ein-/Ausgang, Opt-in/Opt-out, 24-Stunden-Fenster.
import { EventEmitter } from 'node:events';
import { fillParams } from './placeholders.js';

const WINDOW_MS = 24 * 60 * 60 * 1000;
const STOP_WORDS = /^\s*(stop|stopp|abmelden|abbestellen|keine nachrichten)\s*[.!]?\s*$/i;
const START_WORDS = /^\s*(start|anmelden)\s*[.!]?\s*$/i;

export const OPT_OUT_REPLY = 'Sie erhalten von uns ab sofort keine automatischen WhatsApp-Nachrichten mehr. Mit START können Sie sich jederzeit wieder anmelden. Für Fragen schreiben Sie uns gerne weiterhin hier.';
export const OPT_IN_REPLY = 'Vielen Dank! Wir senden Ihnen künftig Erinnerungen und Grüße per WhatsApp. Abmelden jederzeit mit STOPP.';

export class Messaging extends EventEmitter {
  constructor(db, wa, { log = console } = {}) {
    super();
    this.db = db; this.wa = wa; this.log = log;
  }

  branch(id) { return this.db.prepare('SELECT * FROM branches WHERE id=?').get(id); }
  branchByPhoneNumberId(pnid) { return this.db.prepare('SELECT * FROM branches WHERE phone_number_id=?').get(pnid); }
  customer(id) { return id ? this.db.prepare('SELECT * FROM customers WHERE id=?').get(id) : null; }
  conversation(id) { return this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id); }

  findCustomerByWaId(waId, branchId) {
    return this.db.prepare(`SELECT * FROM customers WHERE mobile_e164=?
      ORDER BY (branch_id = ?) DESC, inactive ASC, updated_at DESC LIMIT 1`).get(waId, branchId);
  }

  getOrCreateConversation(branchId, waId, { customerId = null, profileName = null } = {}) {
    let conv = this.db.prepare('SELECT * FROM conversations WHERE branch_id=? AND wa_id=?').get(branchId, waId);
    if (!conv) {
      const cust = customerId ? this.customer(customerId) : this.findCustomerByWaId(waId, branchId);
      conv = this.db.prepare(`INSERT INTO conversations (branch_id, wa_id, customer_id, profile_name)
        VALUES (?, ?, ?, ?) RETURNING *`).get(branchId, waId, cust?.id ?? null, profileName);
    } else if (profileName && profileName !== conv.profile_name) {
      this.db.prepare('UPDATE conversations SET profile_name=? WHERE id=?').run(profileName, conv.id);
    }
    return conv;
  }

  isWindowOpen(conv) {
    return !!conv.last_inbound_at && Date.now() - Date.parse(conv.last_inbound_at) < WINDOW_MS;
  }

  #insertMessage(convId, m) {
    const msg = this.db.prepare(`INSERT INTO messages (conversation_id, direction, type, body, media_id,
        template_name, wa_message_id, status, error, sent_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')))
      ON CONFLICT(wa_message_id) DO NOTHING RETURNING *`).get(
      convId, m.direction, m.type, m.body ?? null, m.mediaId ?? null, m.templateName ?? null,
      m.waMessageId ?? null, m.status ?? null, m.error ?? null, m.sentBy ?? null, m.createdAt ?? null);
    if (!msg) return null; // Duplikat (Meta stellt Webhooks u.U. mehrfach zu)
    const inbound = m.direction === 'in';
    this.db.prepare(`UPDATE conversations SET last_message_at=?, last_preview=?,
        last_inbound_at = CASE WHEN ? THEN ? ELSE last_inbound_at END,
        unread = CASE WHEN ? THEN unread + 1 ELSE 0 END,
        status = CASE WHEN ? THEN 'open' ELSE status END
      WHERE id=?`).run(msg.created_at, (m.body || `[${m.type}]`).slice(0, 120),
      inbound ? 1 : 0, msg.created_at, inbound ? 1 : 0, inbound ? 1 : 0, convId);
    const conv = this.conversation(convId);
    this.emit('message', { branchId: conv.branch_id, conversation: conv, message: msg });
    return msg;
  }

  // ---------- Eingehend (Webhook) ----------

  handleWebhook(payload) {
    for (const entry of payload?.entry || []) {
      for (const change of entry.changes || []) {
        const v = change.value || {};
        const branch = this.branchByPhoneNumberId(v.metadata?.phone_number_id);
        if (!branch) { this.log.warn(`[webhook] Unbekannte phone_number_id ${v.metadata?.phone_number_id}`); continue; }
        const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
        for (const m of v.messages || []) this.#handleInbound(branch, m, names[m.from]);
        for (const s of v.statuses || []) this.#handleStatus(s);
      }
    }
  }

  #handleInbound(branch, m, profileName) {
    const conv = this.getOrCreateConversation(branch.id, m.from, { profileName });
    const { type, body, mediaId } = extractContent(m);
    const msg = this.#insertMessage(conv.id, {
      direction: 'in', type, body, mediaId, waMessageId: m.id, status: 'received',
      createdAt: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : null,
    });
    if (!msg) return;
    this.wa.markRead(branch.phone_number_id, m.id).catch(() => {});

    if (type === 'text' || type === 'button') {
      const cust = this.customer(this.conversation(conv.id).customer_id);
      if (STOP_WORDS.test(body || '')) {
        this.setOptIn({ customerId: cust?.id, waId: m.from, optIn: false, source: 'whatsapp' });
        this.sendText(conv.id, OPT_OUT_REPLY, 'system').catch((e) => this.log.warn(e.message));
      } else if (START_WORDS.test(body || '') && cust && !cust.opt_in) {
        this.setOptIn({ customerId: cust.id, optIn: true, source: 'whatsapp' });
        this.sendText(conv.id, OPT_IN_REPLY, 'system').catch((e) => this.log.warn(e.message));
      }
    }
  }

  #handleStatus(s) {
    const err = s.errors?.map((e) => `${e.code}: ${e.error_data?.details || e.title}`).join('; ') || null;
    const rank = { sent: 1, delivered: 2, read: 3, failed: 9 };
    const msg = this.db.prepare('SELECT * FROM messages WHERE wa_message_id=?').get(s.id);
    if (!msg) return;
    if ((rank[s.status] || 0) <= (rank[msg.status] || 0)) return; // Status nicht zurückstufen
    this.db.prepare('UPDATE messages SET status=?, error=COALESCE(?, error) WHERE id=?').run(s.status, err, msg.id);
    const conv = this.conversation(msg.conversation_id);
    this.emit('status', { branchId: conv.branch_id, conversationId: conv.id, messageId: msg.id, status: s.status, error: err });
  }

  // ---------- Ausgehend ----------

  async sendText(conversationId, body, sentBy) {
    const conv = this.conversation(conversationId);
    if (!conv) throw httpError(404, 'Konversation nicht gefunden');
    if (!this.isWindowOpen(conv)) {
      throw httpError(409, 'Das 24-Stunden-Fenster ist geschlossen. Bitte eine Vorlage senden.');
    }
    const branch = this.branch(conv.branch_id);
    return this.#send(conv, { type: 'text', body, sentBy },
      () => this.wa.sendText(branch.phone_number_id, conv.wa_id, body));
  }

  /** Vorlage senden – an bestehende Konversation oder an einen Kunden (legt Konversation an). */
  async sendTemplate({ conversationId, customerId, branchId, template, sentBy, device = null, previewText = null }) {
    let conv = conversationId ? this.conversation(conversationId) : null;
    const customer = this.customer(customerId ?? conv?.customer_id);
    if (!conv) {
      if (!customer?.mobile_e164) throw httpError(400, 'Kunde hat keine gültige Mobilnummer');
      conv = this.getOrCreateConversation(branchId || customer.branch_id, customer.mobile_e164, { customerId: customer.id });
    }
    const branch = this.branch(conv.branch_id);
    const params = fillParams(template.params, { customer, branch, device });
    const body = previewText || `[Vorlage ${template.name}] ${params.join(' | ')}`;
    return this.#send(conv, { type: 'template', body, templateName: template.name, sentBy },
      () => this.wa.sendTemplate(branch.phone_number_id, conv.wa_id, template.name, template.language || 'de', params));
  }

  async #send(conv, m, fn) {
    try {
      const res = await fn();
      return this.#insertMessage(conv.id, { ...m, direction: 'out', waMessageId: res.messages?.[0]?.id, status: res.dryRun ? 'dry_run' : 'sent' });
    } catch (e) {
      this.#insertMessage(conv.id, { ...m, direction: 'out', status: 'failed', error: e.message });
      throw httpError(502, `WhatsApp: ${e.message}`);
    }
  }

  // ---------- Einwilligung ----------

  setOptIn({ customerId, waId, optIn, source }) {
    const ids = customerId ? [customerId]
      : this.db.prepare('SELECT id FROM customers WHERE mobile_e164=?').all(waId).map((r) => r.id);
    for (const id of ids) {
      if (optIn) {
        this.db.prepare(`UPDATE customers SET opt_in=1, opt_in_source=?, opt_in_at=datetime('now'),
          opted_out_at=NULL WHERE id=?`).run(source, id);
      } else {
        this.db.prepare(`UPDATE customers SET opt_in=0, opt_in_source=?, opted_out_at=datetime('now')
          WHERE id=?`).run(source, id);
      }
    }
  }

  markRead(conversationId) {
    this.db.prepare('UPDATE conversations SET unread=0 WHERE id=?').run(conversationId);
  }
}

export function extractContent(m) {
  switch (m.type) {
    case 'text': return { type: 'text', body: m.text?.body };
    case 'button': return { type: 'button', body: m.button?.text };
    case 'interactive': return { type: 'text', body: m.interactive?.button_reply?.title || m.interactive?.list_reply?.title };
    case 'image': case 'video': case 'document': case 'audio': case 'sticker': {
      const media = m[m.type] || {};
      const label = { image: 'Bild', video: 'Video', document: 'Dokument', audio: 'Sprachnachricht', sticker: 'Sticker' }[m.type];
      return { type: m.type, body: media.caption || media.filename || `[${label}]`, mediaId: media.id };
    }
    case 'location': return { type: 'location', body: `[Standort] ${m.location?.latitude}, ${m.location?.longitude}` };
    case 'reaction': return { type: 'reaction', body: `Reaktion: ${m.reaction?.emoji || ''}` };
    default: return { type: m.type || 'unknown', body: `[Nicht unterstützter Nachrichtentyp: ${m.type}]` };
  }
}

export function httpError(status, message) {
  const e = new Error(message); e.status = status; return e;
}
