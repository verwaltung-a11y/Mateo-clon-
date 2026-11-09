// Schlanker Client für die WhatsApp Business Cloud API (Meta Graph API).

export class WhatsAppClient {
  constructor({ token, apiVersion = 'v23.0', dryRun = true, fetchImpl = fetch, log = console }) {
    this.token = token;
    this.base = `https://graph.facebook.com/${apiVersion}`;
    this.dryRun = dryRun;
    this.fetch = fetchImpl;
    this.log = log;
  }

  async #post(path, payload) {
    if (this.dryRun) {
      this.log.info(`[whatsapp:DRY_RUN] POST ${path} ${JSON.stringify(payload)}`);
      return { messages: [{ id: `dryrun.${Date.now()}.${Math.random().toString(36).slice(2, 8)}` }], dryRun: true };
    }
    const res = await this.fetch(`${this.base}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error?.error_data?.details || data?.error?.message || `HTTP ${res.status}`);
      err.code = data?.error?.code;
      throw err;
    }
    return data;
  }

  sendText(phoneNumberId, to, body) {
    return this.#post(`${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', recipient_type: 'individual', to,
      type: 'text', text: { body, preview_url: true },
    });
  }

  sendTemplate(phoneNumberId, to, name, language, bodyParams = []) {
    const template = { name, language: { code: language } };
    if (bodyParams.length) {
      template.components = [{ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: String(t) })) }];
    }
    return this.#post(`${phoneNumberId}/messages`, { messaging_product: 'whatsapp', to, type: 'template', template });
  }

  markRead(phoneNumberId, messageId) {
    return this.#post(`${phoneNumberId}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: messageId });
  }

  /** Lädt eingehende Medien (Bilder, Sprachnachrichten) – liefert { buffer, mimeType }. */
  async downloadMedia(mediaId) {
    const auth = { Authorization: `Bearer ${this.token}` };
    const meta = await (await this.fetch(`${this.base}/${mediaId}`, { headers: auth })).json();
    if (!meta.url) throw new Error('Medium nicht gefunden');
    const res = await this.fetch(meta.url, { headers: auth });
    return { buffer: Buffer.from(await res.arrayBuffer()), mimeType: meta.mime_type };
  }
}
