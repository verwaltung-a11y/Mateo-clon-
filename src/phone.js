// Normalisiert Telefonnummern aus AkuWin auf das WhatsApp-Format (nur Ziffern, mit Ländervorwahl).
// Beispiele: "0171 / 123 45 67" -> "491711234567", "+49 (0)171-1234567" -> "491711234567"

const DE_MOBILE = /^49(15|16|17)\d{7,9}$/;

export function normalizePhone(raw, defaultCountry = '49') {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/\(0\)/g, '');             // "+49 (0)171" -> "+49 171"
  const plus = s.startsWith('+');
  let digits = s.replace(/\D/g, '');
  if (!digits) return null;
  if (plus) { /* bereits international */ }
  else if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = defaultCountry + digits.slice(1);
  else if (!digits.startsWith(defaultCountry)) digits = defaultCountry + digits;
  if (digits.length < 9 || digits.length > 15) return null;
  return digits;
}

/** true, wenn es (für DE) eine Mobilfunknummer ist. Andere Länder: immer true (keine Prüfung möglich). */
export function isLikelyMobile(e164) {
  if (!e164) return false;
  if (e164.startsWith('49')) return DE_MOBILE.test(e164);
  return true;
}

export function formatPhone(e164) {
  if (!e164) return '';
  if (e164.startsWith('49')) {
    const rest = e164.slice(2);
    return `+49 ${rest.slice(0, 3)} ${rest.slice(3)}`;
  }
  return `+${e164}`;
}
