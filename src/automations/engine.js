// Ermittelt fällige automatische Nachrichten (Geburtstag, Geräte-Alter) und versendet sie genau einmal.

export function localDate(d = new Date()) {
  // YYYY-MM-DD in der Server-Zeitzone (TZ=Europe/Berlin)
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Jahrestag eines Datums in einem bestimmten Jahr (29.02. -> 28.02. in Nicht-Schaltjahren). */
export function anniversary(iso, year) {
  const [, m, d] = iso.split('-');
  const day = m === '02' && d === '29' && !isLeap(year) ? '28' : d;
  return `${year}-${m}-${day}`;
}

export function addDays(iso, n) {
  const t = new Date(iso + 'T12:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

function eligibility(c, cfg) {
  if (c.inactive) return 'inaktiv/verstorben';
  if (!c.mobile_e164) return 'keine Mobilnummer';
  if (c.opted_out_at) return 'abgemeldet (STOPP)';
  if (cfg.requireOptIn && !c.opt_in) return 'keine WhatsApp-Einwilligung';
  return null;
}

/**
 * Liefert alle Kandidaten, deren Auslösedatum im Bereich [from, to] liegt.
 * Ergebnis: { rule, customer, device, refKey, dueDate, skipReason, alreadySent }
 */
export function findCandidates(db, cfg, from, to) {
  const out = [];
  const sent = db.prepare('SELECT 1 FROM automation_runs WHERE rule_id=? AND customer_id=? AND ref_key=?');
  const years = [Number(from.slice(0, 4)), Number(to.slice(0, 4))];
  const inRange = (d) => d >= from && d <= to;

  for (const rule of cfg.rules.filter((r) => r.enabled)) {
    if (rule.type === 'birthday') {
      const rows = db.prepare('SELECT * FROM customers WHERE birthday IS NOT NULL').all();
      for (const c of rows) {
        for (const y of new Set(years)) {
          const due = anniversary(c.birthday, y);
          if (!inRange(due) || due <= c.birthday) continue;
          out.push({ rule, customer: c, device: null, refKey: String(y), dueDate: due });
        }
      }
    } else if (rule.type === 'device_age') {
      // Pro Kunde nur die jüngste Versorgung betrachten – wer schon neue Geräte hat, wird nicht angeschrieben.
      const rows = db.prepare(`SELECT c.*, d.id AS device_id, d.manufacturer, d.model, d.fitted_at
        FROM customers c JOIN devices d ON d.customer_id = c.id
        WHERE d.fitted_at = (SELECT MAX(fitted_at) FROM devices WHERE customer_id = c.id)
        GROUP BY c.id`).all();
      for (const r of rows) {
        const due = anniversary(r.fitted_at, Number(r.fitted_at.slice(0, 4)) + rule.years);
        if (!inRange(due)) continue;
        const { device_id, manufacturer, model, fitted_at, ...customer } = r;
        out.push({ rule, customer, device: { id: device_id, manufacturer, model, fitted_at },
          refKey: `${rule.years}y:${fitted_at}`, dueDate: due });
      }
    }
  }
  for (const c of out) {
    c.skipReason = eligibility(c.customer, cfg);
    c.alreadySent = !!sent.get(c.rule.id, c.customer.id, c.refKey);
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

export function inSendWindow(cfg, now = new Date()) {
  const w = cfg.sendWindow || {};
  const h = now.getHours();
  if (w.weekdays && !w.weekdays.includes(now.getDay())) return false;
  return h >= (w.fromHour ?? 9) && h < (w.toHour ?? 18);
}

/** Versendet alle heute fälligen (inkl. Nachholtage) Nachrichten. */
export async function runAutomations(db, messaging, cfg, { now = new Date(), log = console, force = false } = {}) {
  if (!force && !inSendWindow(cfg, now)) return { sent: 0, failed: 0, skipped: 0, outsideWindow: true };
  const today = localDate(now);
  const maxCatchUp = Math.max(0, ...cfg.rules.map((r) => r.catchUpDays ?? 0));
  const candidates = findCandidates(db, cfg, addDays(today, -maxCatchUp), today)
    .filter((c) => c.dueDate >= addDays(today, -(c.rule.catchUpDays ?? 0)) && !c.alreadySent);

  const claim = db.prepare(`INSERT INTO automation_runs (rule_id, customer_id, ref_key, status)
    VALUES (?, ?, ?, 'pending') ON CONFLICT DO NOTHING RETURNING id`);
  const finish = db.prepare('UPDATE automation_runs SET status=?, message_id=?, error=? WHERE id=?');
  const stats = { sent: 0, failed: 0, skipped: 0 };

  for (const c of candidates) {
    const run = claim.get(c.rule.id, c.customer.id, c.refKey);
    if (!run) continue; // parallel bereits erledigt
    if (c.skipReason) { finish.run('skipped', null, c.skipReason, run.id); stats.skipped++; continue; }
    try {
      const msg = await messaging.sendTemplate({
        customerId: c.customer.id, template: c.rule.template, device: c.device,
        sentBy: `automation:${c.rule.id}`,
      });
      finish.run('sent', msg?.id ?? null, null, run.id); stats.sent++;
    } catch (e) {
      finish.run('failed', null, e.message, run.id); stats.failed++;
      log.warn(`[automation] ${c.rule.id} an Kunde ${c.customer.akuwin_id} fehlgeschlagen: ${e.message}`);
    }
    if (cfg.delayBetweenMessagesMs) await new Promise((r) => setTimeout(r, cfg.delayBetweenMessagesMs));
  }
  if (stats.sent || stats.failed) log.info(`[automation] ${JSON.stringify(stats)}`);
  return stats;
}

export function startScheduler(db, messaging, cfg, log = console) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runAutomations(db, messaging, cfg, { log }); }
    catch (e) { log.error('[automation]', e); }
    finally { running = false; }
  };
  setTimeout(tick, 10_000);
  return setInterval(tick, 15 * 60_000);
}
