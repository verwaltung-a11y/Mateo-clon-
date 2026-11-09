import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, isLikelyMobile } from '../src/phone.js';
import { parseCsv, decode } from '../src/akuwin/csv.js';
import { parseDate, mapCustomer } from '../src/akuwin/mapping.js';
import { anniversary, findCandidates, runAutomations, addDays, localDate } from '../src/automations/engine.js';
import { fillParams } from '../src/placeholders.js';
import { openDb, syncBranches } from '../src/db.js';
import { importRows } from '../src/akuwin/importer.js';
import { Messaging } from '../src/messaging.js';
import { WhatsAppClient } from '../src/whatsapp/client.js';

const quiet = { info() {}, warn() {}, error() {} };
const branches = { branches: [{ id: 'z', name: 'Zentrale', phoneNumberId: 'PN1', akuwinCodes: ['1'] },
  { id: 'n', name: 'Nord', phoneNumberId: 'PN2', akuwinCodes: ['2'] }], defaultBranch: 'z' };
const akuwin = {
  customerColumns: { id: 'Kundennr', salutation: 'Anrede', firstName: 'Vorname', lastName: 'Name', birthday: 'Geburtsdatum',
    mobile: ['Mobil', 'Telefon'], branch: 'Filiale', optIn: 'WhatsApp', inactive: 'Verstorben' },
  deviceColumns: { id: 'ID', customerId: 'Kundennr', side: 'Seite', manufacturer: 'Hersteller', model: 'Modell', serial: 'SN', fittedAt: 'Abgabe' },
  truthyValues: ['ja', 'x', '1'],
};
const autoCfg = (over = {}) => ({ requireOptIn: true, sendWindow: { fromHour: 0, toHour: 24 }, delayBetweenMessagesMs: 0,
  rules: [
    { id: 'gb', type: 'birthday', enabled: true, catchUpDays: 1, template: { name: 'gb', language: 'de', params: ['{anrede}'] } },
    { id: 'g6', type: 'device_age', years: 6, catchUpDays: 30, enabled: true, template: { name: 'g6', language: 'de', params: ['{anrede}', '{anpassdatum}'] } },
  ], ...over });

function setup() {
  const db = openDb(':memory:');
  syncBranches(db, branches);
  const sent = [];
  const wa = new WhatsAppClient({ dryRun: true, log: { info: (m) => sent.push(m) } });
  const messaging = new Messaging(db, wa, { log: quiet });
  return { db, messaging, sent };
}

test('Telefonnummern werden normalisiert', () => {
  assert.equal(normalizePhone('0171 / 123 45 67'), '491711234567');
  assert.equal(normalizePhone('+49 (0)171-1234567'), '491711234567');
  assert.equal(normalizePhone('0049 160 9876543'), '491609876543');
  assert.equal(normalizePhone('+43 664 1234567'), '436641234567');
  assert.equal(normalizePhone('12'), null);
  assert.ok(isLikelyMobile('491711234567'));
  assert.ok(!isLikelyMobile('49251123456'));
});

test('CSV: Semikolon, Anführungszeichen, Windows-1252', () => {
  const buf = Buffer.from('Kundennr;Name\r\n1;"Müller; Jürgen"\r\n2;"Sag ""Hallo"""\r\n', 'latin1');
  const rows = parseCsv(decode(buf, 'windows-1252'));
  assert.deepEqual(rows, [{ Kundennr: '1', Name: 'Müller; Jürgen' }, { Kundennr: '2', Name: 'Sag "Hallo"' }]);
});

test('Datumsformate', () => {
  assert.equal(parseDate('05.03.1950'), '1950-03-05');
  assert.equal(parseDate('1950-03-05 00:00:00'), '1950-03-05');
  assert.equal(parseDate('31.02.2000'), null);
  assert.equal(parseDate(''), null);
  assert.equal(anniversary('1948-02-29', 2027), '2027-02-28');
  assert.equal(anniversary('1948-02-29', 2028), '2028-02-29');
});

test('Mapping: Festnetz wird übersprungen, Mobilnummer gefunden', () => {
  const c = mapCustomer({ Kundennr: '7', Telefon: '0171 5555555', Mobil: '0251 12345', Filiale: '2', WhatsApp: 'Ja' }, akuwin, () => 'n', '49');
  assert.equal(c.mobile, '491715555555');
  assert.equal(c.optIn, true);
});

test('Platzhalter', () => {
  const p = fillParams(['{anrede}', '{anpassdatum}', '{filiale}'], {
    customer: { salutation: 'Frau', first_name: 'Erika', last_name: 'Muster' }, branch: { name: 'Nord' }, device: { fitted_at: '2020-11-09' } });
  assert.deepEqual(p, ['Frau Muster', '09.11.2020', 'Nord']);
});

function seed(db, today) {
  const y = Number(today.slice(0, 4));
  importRows(db, {
    source: 'test',
    customers: [
      { Kundennr: '1', Anrede: 'Frau', Vorname: 'Erika', Name: 'A', Geburtsdatum: `${today.slice(8, 10)}.${today.slice(5, 7)}.1950`, Mobil: '0171 1111111', Filiale: '1', WhatsApp: 'ja' },
      { Kundennr: '2', Anrede: 'Herr', Vorname: 'Hans', Name: 'B', Geburtsdatum: `${today.slice(8, 10)}.${today.slice(5, 7)}.1940`, Mobil: '0171 2222222', Filiale: '1', WhatsApp: '' },
      { Kundennr: '3', Anrede: 'Herr', Vorname: 'Tot', Name: 'C', Geburtsdatum: `${today.slice(8, 10)}.${today.slice(5, 7)}.1930`, Mobil: '0171 3333333', Filiale: '2', WhatsApp: 'ja', Verstorben: 'x' },
      { Kundennr: '4', Anrede: 'Frau', Vorname: 'Gisela', Name: 'D', Geburtsdatum: '01.01.1945', Mobil: '0171 4444444', Filiale: '2', WhatsApp: 'ja' },
      { Kundennr: '5', Anrede: 'Frau', Vorname: 'Neu', Name: 'E', Geburtsdatum: '01.01.1945', Mobil: '0171 5555555', Filiale: '2', WhatsApp: 'ja' },
    ],
    devices: [
      { ID: 'a', Kundennr: '4', Seite: 'L', Abgabe: `${today.slice(8, 10)}.${today.slice(5, 7)}.${y - 6}` },
      { ID: 'b', Kundennr: '4', Seite: 'R', Abgabe: `${today.slice(8, 10)}.${today.slice(5, 7)}.${y - 6}` },
      // Kunde 5: alte Geräte 6 Jahre, aber inzwischen neu versorgt -> keine Nachricht
      { ID: 'c', Kundennr: '5', Seite: 'L', Abgabe: `${today.slice(8, 10)}.${today.slice(5, 7)}.${y - 6}` },
      { ID: 'd', Kundennr: '5', Seite: 'L', Abgabe: `01.01.${y - 1}` },
    ],
  }, { branches, akuwin, defaultCountryCode: '49' });
}

test('Automationen: Geburtstag + 6 Jahre, Einwilligung, Verstorbene, genau einmal', async () => {
  const { db, messaging, sent } = setup();
  const now = new Date(); now.setHours(10);
  const today = localDate(now);
  if (today.endsWith('02-29')) return; // Testdaten nicht sinnvoll an diesem Tag
  seed(db, today);

  const cands = findCandidates(db, autoCfg(), addDays(today, -1), today);
  const byKd = Object.fromEntries(cands.map((c) => [`${c.rule.id}:${c.customer.akuwin_id}`, c]));
  assert.equal(byKd['gb:1'].skipReason, null);
  assert.equal(byKd['gb:2'].skipReason, 'keine WhatsApp-Einwilligung');
  assert.equal(byKd['gb:3'].skipReason, 'inaktiv/verstorben');
  assert.ok(byKd['g6:4']);
  assert.ok(!byKd['g6:5'], 'neu versorgter Kunde wird nicht angeschrieben');

  const r1 = await runAutomations(db, messaging, autoCfg(), { now, log: quiet });
  assert.deepEqual(r1, { sent: 2, failed: 0, skipped: 2 });
  assert.equal(sent.length, 2);
  assert.match(sent.join('\n'), /"name":"g6".*"Frau D"/);

  const r2 = await runAutomations(db, messaging, autoCfg(), { now, log: quiet });
  assert.deepEqual(r2, { sent: 0, failed: 0, skipped: 0 });
});

test('Eingehende Nachricht, 24h-Fenster, STOPP und Statusupdates', async () => {
  const { db, messaging } = setup();
  seed(db, localDate());
  const hook = (msgs, statuses) => messaging.handleWebhook({ entry: [{ changes: [{ value: {
    metadata: { phone_number_id: 'PN2' }, contacts: [{ wa_id: '491714444444', profile: { name: 'Gisi' } }],
    messages: msgs, statuses } }] }] });

  // Ohne eingehende Nachricht kein freier Text erlaubt
  const conv0 = messaging.getOrCreateConversation('n', '491714444444');
  await assert.rejects(messaging.sendText(conv0.id, 'Hallo', 'MK'), /24-Stunden/);

  hook([{ from: '491714444444', id: 'wamid.1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hallo, Termin?' } }]);
  hook([{ from: '491714444444', id: 'wamid.1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hallo, Termin?' } }]); // Duplikat
  const conv = messaging.conversation(conv0.id);
  assert.equal(conv.unread, 1);
  assert.ok(conv.customer_id, 'mit AkuWin-Kunde verknüpft');
  assert.ok(messaging.isWindowOpen(conv));

  const out = await messaging.sendText(conv.id, 'Gerne, morgen 10 Uhr?', 'MK');
  assert.equal(out.status, 'dry_run');

  db.prepare("UPDATE messages SET wa_message_id='wamid.out', status='sent' WHERE id=?").run(out.id);
  hook([], [{ id: 'wamid.out', status: 'read' }]);
  hook([], [{ id: 'wamid.out', status: 'delivered' }]); // darf nicht zurückstufen
  assert.equal(db.prepare('SELECT status FROM messages WHERE id=?').get(out.id).status, 'read');

  hook([{ from: '491714444444', id: 'wamid.2', type: 'text', text: { body: 'STOPP' } }]);
  const cust = db.prepare("SELECT * FROM customers WHERE akuwin_id='4'").get();
  assert.equal(cust.opt_in, 0);
  assert.ok(cust.opted_out_at);

  // Re-Import mit WhatsApp=ja darf die Abmeldung nicht überschreiben
  seed(db, localDate());
  assert.equal(db.prepare("SELECT opt_in FROM customers WHERE akuwin_id='4'").get().opt_in, 0);
});
