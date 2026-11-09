// Login anlegen/ändern.
//   Admin (alle Filialen):  npm run set-password -- admin <passwort>
//   Filiale:                npm run set-password -- <benutzer> <passwort> <filial-id>
import { loadConfig } from '../src/config.js';
import { openDb, syncBranches } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

const [username, password, branchId] = process.argv.slice(2);
if (!username || !password) {
  console.error('Aufruf: npm run set-password -- <benutzer> <passwort> [filial-id]');
  process.exit(1);
}
if (password.length < 10) { console.error('Passwort muss mindestens 10 Zeichen haben.'); process.exit(1); }
const cfg = loadConfig();
const db = openDb(cfg.dbFile);
syncBranches(db, cfg.branches);
if (branchId && !db.prepare('SELECT 1 FROM branches WHERE id=?').get(branchId)) {
  console.error(`Unbekannte Filiale "${branchId}". Vorhanden: ${cfg.branches.branches.map((b) => b.id).join(', ')}`);
  process.exit(1);
}
db.prepare(`INSERT INTO logins (username, password_hash, branch_id) VALUES (?, ?, ?)
  ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, branch_id=excluded.branch_id`)
  .run(username.toLowerCase(), hashPassword(password), branchId || null);
console.log(`Login "${username.toLowerCase()}" gespeichert (${branchId ? `Filiale ${branchId}` : 'Admin, alle Filialen'}).`);
