import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { decode, parseCsv } from './csv.js';
import { mapCustomer, mapDevice } from './mapping.js';
import { tx } from '../db.js';

export function makeBranchResolver(branchesConfig) {
  const map = new Map();
  for (const b of branchesConfig.branches) {
    map.set(b.id.toLowerCase(), b.id);
    for (const code of b.akuwinCodes || []) map.set(String(code).toLowerCase(), b.id);
  }
  return (code) => map.get(String(code || '').trim().toLowerCase()) || branchesConfig.defaultBranch;
}

/** Liest Rohzeilen aus der konfigurierten Quelle. */
export async function readSource(akuwinCfg) {
  if (akuwinCfg.source === 'sql') {
    let mssql;
    try { mssql = (await import('mssql')).default; }
    catch { throw new Error("SQL-Quelle benötigt das Paket 'mssql' (npm install mssql)"); }
    const pool = await mssql.connect(akuwinCfg.sql.connectionString);
    try {
      const customers = (await pool.request().query(akuwinCfg.sql.customersQuery)).recordset;
      const devices = akuwinCfg.sql.devicesQuery
        ? (await pool.request().query(akuwinCfg.sql.devicesQuery)).recordset : [];
      return { customers, devices, source: 'sql' };
    } finally { await pool.close(); }
  }
  const { folder, customersFile, devicesFile, encoding, delimiter } = akuwinCfg.csv;
  const dir = path.resolve(ROOT, folder);
  const read = (f) => {
    const p = path.join(dir, f);
    if (!f || !fs.existsSync(p)) return null;
    return parseCsv(decode(fs.readFileSync(p), encoding), delimiter);
  };
  const customers = read(customersFile);
  if (!customers) throw new Error(`Kundendatei nicht gefunden: ${path.join(dir, customersFile)}`);
  return { customers, devices: read(devicesFile) || [], source: 'csv' };
}

/** Fingerabdruck der Quelldateien – Import nur, wenn sich etwas geändert hat. */
export function sourceFingerprint(akuwinCfg) {
  if (akuwinCfg.source !== 'csv') return String(Date.now());
  const dir = path.resolve(ROOT, akuwinCfg.csv.folder);
  return [akuwinCfg.csv.customersFile, akuwinCfg.csv.devicesFile].map((f) => {
    try { const s = fs.statSync(path.join(dir, f)); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; }
  }).join('|');
}

export function importRows(db, { customers, devices, source }, cfg) {
  const resolveBranch = makeBranchResolver(cfg.branches);
  const warnings = [];
  let skipped = 0, nCustomers = 0, nDevices = 0;

  const upsertCustomer = db.prepare(`
    INSERT INTO customers (akuwin_id, branch_id, salutation, first_name, last_name, birthday,
      mobile_raw, mobile_e164, inactive, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(akuwin_id) DO UPDATE SET branch_id=excluded.branch_id, salutation=excluded.salutation,
      first_name=excluded.first_name, last_name=excluded.last_name, birthday=excluded.birthday,
      mobile_raw=excluded.mobile_raw, mobile_e164=excluded.mobile_e164, inactive=excluded.inactive,
      updated_at=datetime('now')
    RETURNING id, opt_in, opt_in_source, opted_out_at`);
  const grantOptIn = db.prepare(`UPDATE customers SET opt_in=1, opt_in_source='akuwin',
      opt_in_at=COALESCE(opt_in_at, datetime('now')) WHERE id=?`);
  const revokeOptIn = db.prepare(`UPDATE customers SET opt_in=0 WHERE id=? AND opt_in_source='akuwin'`);
  const findCustomer = db.prepare('SELECT id FROM customers WHERE akuwin_id=?');
  const upsertDevice = db.prepare(`
    INSERT INTO devices (akuwin_id, customer_id, side, manufacturer, model, serial, fitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(akuwin_id) DO UPDATE SET customer_id=excluded.customer_id, side=excluded.side,
      manufacturer=excluded.manufacturer, model=excluded.model, serial=excluded.serial,
      fitted_at=excluded.fitted_at`);
  const linkConversations = db.prepare(`UPDATE conversations SET customer_id=?
      WHERE customer_id IS NULL AND wa_id=?`);

  tx(db, () => {
    customers.forEach((row, i) => {
      const c = mapCustomer(row, cfg.akuwin, resolveBranch, cfg.defaultCountryCode);
      if (c.error) { skipped++; warnings.push(`Kunde Zeile ${i + 2}: ${c.error}`); return; }
      const r = upsertCustomer.get(c.akuwinId, c.branchId, c.salutation, c.firstName, c.lastName,
        c.birthday, c.mobileRaw, c.mobile, c.inactive ? 1 : 0);
      if (c.optIn === true && !r.opted_out_at) grantOptIn.run(r.id);
      if (c.optIn === false) revokeOptIn.run(r.id);
      if (c.mobile) linkConversations.run(r.id, c.mobile);
      nCustomers++;
    });
    devices.forEach((row, i) => {
      const d = mapDevice(row, cfg.akuwin);
      if (d.error) { skipped++; warnings.push(`Gerät Zeile ${i + 2}: ${d.error}`); return; }
      const cust = findCustomer.get(d.customerAkuwinId);
      if (!cust) { skipped++; warnings.push(`Gerät Zeile ${i + 2}: Kunde ${d.customerAkuwinId} unbekannt`); return; }
      upsertDevice.run(d.akuwinId, cust.id, d.side, d.manufacturer, d.model, d.serial, d.fittedAt);
      nDevices++;
    });
    db.prepare('INSERT INTO import_log (source, customers, devices, skipped, warnings) VALUES (?,?,?,?,?)')
      .run(source, nCustomers, nDevices, skipped, JSON.stringify(warnings.slice(0, 200)));
  });
  return { customers: nCustomers, devices: nDevices, skipped, warnings };
}

export async function runImport(db, cfg) {
  const data = await readSource(cfg.akuwin);
  return importRows(db, data, cfg);
}

/** Startet den periodischen Abgleich (nur bei geänderten Dateien). */
export function startSync(db, cfg, log = console) {
  let last = null;
  const tick = async () => {
    const fp = sourceFingerprint(cfg.akuwin);
    if (fp === last) return;
    try {
      const r = await runImport(db, cfg);
      last = fp;
      log.info(`[akuwin] Import: ${r.customers} Kunden, ${r.devices} Geräte, ${r.skipped} übersprungen`);
    } catch (e) { log.warn(`[akuwin] Import fehlgeschlagen: ${e.message}`); }
  };
  tick();
  const ms = Math.max(1, cfg.akuwin.syncIntervalMinutes || 60) * 60_000;
  return setInterval(tick, ms);
}
