// Erzeugt Beispiel-Exportdateien im AkuWin-Format, importiert sie und legt Demo-Logins an.
// Nur zum Ausprobieren (DRY_RUN=true)!
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig } from '../src/config.js';
import { openDb, syncBranches } from '../src/db.js';
import { runImport } from '../src/akuwin/importer.js';
import { hashPassword } from '../src/auth.js';
import { Messaging } from '../src/messaging.js';
import { WhatsAppClient } from '../src/whatsapp/client.js';

const cfg = loadConfig();
const dir = path.resolve(ROOT, cfg.akuwin.csv.folder);
fs.mkdirSync(dir, { recursive: true });
const today = new Date();
const dd = (d) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
const shift = (y, days = 0) => { const d = new Date(today); d.setFullYear(d.getFullYear() - y); d.setDate(d.getDate() + days); return d; };

const kunden = [
  'Kundennr;Anrede;Vorname;Name;Geburtsdatum;Telefon;Mobil;Filiale;WhatsApp;Verstorben',
  `1001;Frau;Erika;Mustermann;${dd(shift(72))};0251 123123;0171 / 123 45 67;1;ja;`,
  `1002;Herr;Hans;Schmidt;${dd(shift(80, 3))};;0160-9876543;1;ja;`,
  `1003;Frau;Gisela;Meyer;14.03.1948;0251 999;0152 11122233;2;ja;`,
  `1004;Herr;Werner;Becker;02.11.1941;0251 888;;2;;`,
  `1005;Herr;Klaus;Wagner;${dd(shift(67))};;+49 176 5554443;2;;`,
].join('\r\n');
const geraete = [
  'GeraeteID;Kundennr;Seite;Hersteller;Modell;Seriennr;Abgabedatum',
  `G1;1003;L;Phonak;Audéo P90;SN1;${dd(shift(6))}`,
  `G2;1003;R;Phonak;Audéo P90;SN2;${dd(shift(6))}`,
  `G3;1002;L;Oticon;More 1;SN3;${dd(shift(6, 5))}`,
  `G4;1001;L;Signia;Pure 7X;SN4;${dd(shift(2))}`,
].join('\r\n');
fs.writeFileSync(path.join(dir, cfg.akuwin.csv.customersFile), Buffer.from(kunden, 'latin1'));
fs.writeFileSync(path.join(dir, cfg.akuwin.csv.devicesFile), Buffer.from(geraete, 'latin1'));

const db = openDb(cfg.dbFile);
syncBranches(db, cfg.branches);
console.log('Import:', await runImport(db, cfg));

const add = db.prepare(`INSERT INTO logins (username, password_hash, branch_id) VALUES (?, ?, ?)
  ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, branch_id=excluded.branch_id`);
add.run('admin', hashPassword('demo-passwort'), null);
for (const b of cfg.branches.branches) add.run(b.id, hashPassword('demo-passwort'), b.id);

// Eine eingehende Beispielnachricht simulieren
const messaging = new Messaging(db, new WhatsAppClient({ dryRun: true, log: { info() {} } }));
const b = cfg.branches.branches[0];
messaging.handleWebhook({ entry: [{ changes: [{ value: {
  metadata: { phone_number_id: b.phoneNumberId },
  contacts: [{ wa_id: '491711234567', profile: { name: 'Erika M.' } }],
  messages: [{ from: '491711234567', id: `demo.${Date.now()}`, timestamp: String(Math.floor(Date.now() / 1000)),
    type: 'text', text: { body: 'Guten Tag, mein linkes Hörgerät pfeift seit gestern. Kann ich vorbeikommen?' } }],
} }] }] });

console.log(`\nDemo bereit. Logins (Passwort jeweils "demo-passwort"): admin, ${cfg.branches.branches.map((x) => x.id).join(', ')}`);
console.log('Start: npm start  ->  http://localhost:' + cfg.port);
