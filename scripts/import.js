// Einmaliger AkuWin-Import von der Kommandozeile: npm run import
import { loadConfig } from '../src/config.js';
import { openDb, syncBranches } from '../src/db.js';
import { runImport } from '../src/akuwin/importer.js';

const cfg = loadConfig();
const db = openDb(cfg.dbFile);
syncBranches(db, cfg.branches);
const r = await runImport(db, cfg);
console.log(`Importiert: ${r.customers} Kunden, ${r.devices} Geräte, ${r.skipped} übersprungen`);
for (const w of r.warnings.slice(0, 30)) console.log('  -', w);
const s = db.prepare(`SELECT COUNT(*) n, SUM(mobile_e164 IS NOT NULL) mobil, SUM(opt_in=1) optin FROM customers`).get();
console.log(`Datenbank: ${s.n} Kunden, davon ${s.mobil} mit Mobilnummer, ${s.optin} mit WhatsApp-Einwilligung`);
