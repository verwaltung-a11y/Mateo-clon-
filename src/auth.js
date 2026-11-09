// Einfache Anmeldung: ein Login pro Filiale (gemeinsamer Browser im Laden) + Admin-Logins.
import crypto from 'node:crypto';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const COOKIE = 'kd_session';
const MAX_AGE_S = 60 * 60 * 24 * 30; // 30 Tage – der Filial-Browser bleibt angemeldet

function sign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

export function createSession(res, { username, branchId }, secret) {
  const payload = Buffer.from(JSON.stringify({ u: username, b: branchId, exp: Date.now() + MAX_AGE_S * 1000 })).toString('base64url');
  const token = `${payload}.${sign(payload, secret)}`;
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_S}${secure}`);
}

export function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

export function readSession(req, secret) {
  const raw = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  const [payload, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload, secret);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const s = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (s.exp < Date.now()) return null;
  return { username: s.u, branchId: s.b, isAdmin: !s.b };
}

export function requireAuth(secret) {
  return (req, res, next) => {
    const s = readSession(req, secret);
    if (!s) return res.status(401).json({ error: 'Nicht angemeldet' });
    req.user = s;
    next();
  };
}
