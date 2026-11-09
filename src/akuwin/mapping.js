// Wandelt Rohzeilen (aus CSV oder SQL) anhand der Spaltenzuordnung in interne Datensätze um.
import { normalizePhone, isLikelyMobile } from '../phone.js';

function pick(row, spec) {
  if (!spec) return '';
  const keys = Array.isArray(spec) ? spec : [spec];
  const lower = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
  for (const k of keys) {
    const v = lower[String(k).toLowerCase()];
    if (v != null && String(v).trim() !== '') return v instanceof Date ? v : String(v).trim();
  }
  return '';
}

/** Akzeptiert DD.MM.YYYY, DD.MM.YY, YYYY-MM-DD (+Uhrzeit) und Date-Objekte. Liefert YYYY-MM-DD oder null. */
export function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  let y, mo, d;
  if (m) {
    [, d, mo, y] = m;
    if (y.length === 2) y = (Number(y) > (new Date().getFullYear() % 100) ? '19' : '20') + y;
  } else if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) {
    [, y, mo, d] = m;
  } else return null;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const check = new Date(iso + 'T00:00:00Z');
  if (isNaN(check) || check.toISOString().slice(0, 10) !== iso) return null;
  if (Number(y) < 1900) return null;
  return iso;
}

export function mapCustomer(row, cfg, branchResolver, defaultCountry) {
  const c = cfg.customerColumns;
  const truthy = new Set((cfg.truthyValues || []).map((x) => x.toLowerCase()));
  const isTrue = (v) => truthy.has(String(v).toLowerCase());

  const akuwinId = pick(row, c.id);
  if (!akuwinId) return { error: 'Kundennummer fehlt' };

  // Erste Spalte mit gültiger Mobilnummer verwenden
  const mobileCols = Array.isArray(c.mobile) ? c.mobile : [c.mobile];
  let mobileRaw = '', mobile = null;
  for (const col of mobileCols) {
    const raw = pick(row, col);
    const n = normalizePhone(raw, defaultCountry);
    if (n && isLikelyMobile(n)) { mobileRaw = raw; mobile = n; break; }
    if (!mobileRaw) mobileRaw = raw;
  }

  return {
    akuwinId,
    branchId: branchResolver(pick(row, c.branch)),
    salutation: pick(row, c.salutation) || null,
    firstName: pick(row, c.firstName) || null,
    lastName: pick(row, c.lastName) || null,
    birthday: parseDate(pick(row, c.birthday)),
    mobileRaw: mobileRaw || null,
    mobile,
    optIn: c.optIn ? isTrue(pick(row, c.optIn)) : null,   // null = AkuWin liefert keine Info
    inactive: c.inactive ? isTrue(pick(row, c.inactive)) : false,
  };
}

export function mapDevice(row, cfg) {
  const c = cfg.deviceColumns;
  const customerAkuwinId = pick(row, c.customerId);
  if (!customerAkuwinId) return { error: 'Kundennummer fehlt' };
  const fittedAt = parseDate(pick(row, c.fittedAt));
  const serial = pick(row, c.serial);
  return {
    akuwinId: pick(row, c.id) || `${customerAkuwinId}:${serial || pick(row, c.side)}:${fittedAt}`,
    customerAkuwinId,
    side: pick(row, c.side) || null,
    manufacturer: pick(row, c.manufacturer) || null,
    model: pick(row, c.model) || null,
    serial: serial || null,
    fittedAt,
  };
}
