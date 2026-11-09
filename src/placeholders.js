// Platzhalter für Vorlagen: {anrede}, {vorname}, {nachname}, {filiale}, {anpassdatum}, {geraet}, {kundennr}

export function anrede(c) {
  const s = (c?.salutation || '').toLowerCase();
  const name = c?.last_name || '';
  if (name && /frau/.test(s)) return `Frau ${name}`;
  if (name && /herr/.test(s)) return `Herr ${name}`;
  return [c?.first_name, c?.last_name].filter(Boolean).join(' ') || 'liebe Kundin, lieber Kunde';
}

export function formatDateDe(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

export function fillParams(params = [], ctx = {}) {
  const { customer, branch, device } = ctx;
  const values = {
    anrede: anrede(customer),
    vorname: customer?.first_name || '',
    nachname: customer?.last_name || '',
    kundennr: customer?.akuwin_id || '',
    filiale: branch?.name || '',
    anpassdatum: formatDateDe(device?.fitted_at),
    geraet: [device?.manufacturer, device?.model].filter(Boolean).join(' '),
  };
  return params.map((p) => String(p).replace(/\{(\w+)\}/g, (_, k) => values[k] ?? '').trim() || '-');
}
