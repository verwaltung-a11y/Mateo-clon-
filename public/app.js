// KundenDialog – Browser-App für den Filial-Posteingang (ohne Build-Schritt).
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('.') : '');
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const fmtShort = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? fmtTime(iso) : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
};

const state = { me: null, convs: [], activeId: null, detail: null, branch: '', newCustomer: null };

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('Nicht angemeldet'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}
const initials = () => $('#initials').value.trim();

// ---------- Anmeldung ----------
function showLogin() { $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
    $('#loginError').textContent = '';
    start();
  } catch (err) { $('#loginError').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => { await api('/logout', { method: 'POST' }); location.reload(); });

// ---------- Start ----------
async function start() {
  try { state.me = await api('/me'); } catch { return showLogin(); }
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  const { user, branches, dryRun, manualTemplates } = state.me;
  const own = branches.find((b) => b.id === user.branchId);
  $('#branchLabel').textContent = own ? `${own.name} · ${own.display_phone || ''}` : 'Alle Filialen (Admin)';
  $('#dryRunBadge').classList.toggle('hidden', !dryRun);
  document.querySelectorAll('.admin-only').forEach((el) => el.classList.toggle('hidden', !user.isAdmin));
  $('#branchFilter').innerHTML = '<option value="">Alle Filialen</option>' + branches.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
  const opts = manualTemplates.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('');
  $('#templateSelect').innerHTML = opts; $('#newTemplate').innerHTML = opts;
  try { $('#initials').value = localStorage.getItem('kd_initials') || ''; } catch {}
  await loadConvs();
  connectEvents();
}
$('#initials').addEventListener('change', () => { try { localStorage.setItem('kd_initials', initials()); } catch {} });
$('#branchFilter').addEventListener('change', (e) => { state.branch = e.target.value; loadConvs(); if (!$('#view-automations').classList.contains('hidden')) loadAutomations(); });

// ---------- Ansichten ----------
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  for (const v of ['inbox', 'automations', 'admin']) $(`#view-${v}`).classList.toggle('hidden', v !== t.dataset.view);
  if (t.dataset.view === 'automations') loadAutomations();
  if (t.dataset.view === 'admin') loadImportLog();
}));

// ---------- Konversationsliste ----------
let searchTimer;
$('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadConvs, 250); });
$('#statusFilter').addEventListener('change', loadConvs);

async function loadConvs() {
  const p = new URLSearchParams({ q: $('#search').value, status: $('#statusFilter').value, branch: state.branch });
  state.convs = await api(`/conversations?${p}`);
  renderConvs();
}

function convName(c) {
  const n = [c.first_name, c.last_name].filter(Boolean).join(' ');
  return n || c.profile_name || c.phone;
}

function renderConvs() {
  const admin = state.me.user.isAdmin;
  $('#convList').innerHTML = state.convs.map((c) => `
    <li data-id="${c.id}" class="${c.id === state.activeId ? 'active' : ''}">
      <span class="name">${esc(convName(c))}</span><span class="time">${fmtShort(c.last_message_at)}</span>
      <span class="preview">${admin ? `<b>${esc(c.branch_name)}</b> · ` : ''}${esc(c.last_preview)}</span>
      ${c.unread ? `<span class="badge">${c.unread}</span>` : '<span></span>'}
    </li>`).join('') || '<li class="muted">Keine Konversationen</li>';
}
$('#convList').addEventListener('click', (e) => { const li = e.target.closest('li[data-id]'); if (li) openConv(Number(li.dataset.id)); });

// ---------- Chat ----------
async function openConv(id) {
  state.activeId = id;
  state.detail = await api(`/conversations/${id}`);
  if (state.detail.conversation.unread) api(`/conversations/${id}/read`, { method: 'POST' }).catch(() => {});
  const c = state.convs.find((x) => x.id === id); if (c) c.unread = 0;
  renderConvs(); renderChat();
  $('.inbox').classList.add('chat-open');
}

function statusIcon(m) {
  if (m.direction === 'in') return '';
  return { sent: '✓', delivered: '✓✓', read: '<span class="read">✓✓</span>', failed: `<span class="failed" title="${esc(m.error)}">⚠ nicht zugestellt</span>`, dry_run: '(Test)' }[m.status] || '…';
}

function renderChat() {
  const { conversation: cv, messages, customer, devices } = state.detail;
  $('#chatEmpty').classList.add('hidden'); $('#chatPane').classList.remove('hidden');
  const name = customer ? [customer.first_name, customer.last_name].filter(Boolean).join(' ') : (cv.profile_name || cv.phone);
  $('#chatTitle').textContent = name;
  $('#chatSub').textContent = `${cv.phone}${customer ? ` · Kd.-Nr. ${customer.akuwin_id}` : ' · nicht in AkuWin zugeordnet'}`;
  $('#toggleDone').textContent = cv.status === 'done' ? 'Wieder öffnen' : 'Erledigt ✓';
  $('#toggleDone').className = cv.status === 'done' ? 'secondary' : '';

  let lastDay = '';
  $('#messages').innerHTML = messages.map((m) => {
    const day = new Date(m.created_at).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
    const sep = day !== lastDay ? `<div class="day">${day}</div>` : ''; lastDay = day;
    const media = m.media_id && m.type === 'image' ? `<img src="/api/messages/${m.id}/media" alt="Bild" loading="lazy">`
      : m.media_id ? `<a href="/api/messages/${m.id}/media" target="_blank">${esc(m.type === 'audio' ? '▶ Sprachnachricht anhören' : 'Datei öffnen')}</a><br>` : '';
    const who = m.direction === 'out' ? (m.sent_by?.startsWith('automation:') ? 'Automatisch · ' : m.sent_by ? `${esc(m.sent_by)} · ` : '') : '';
    return `${sep}<div class="msg ${m.direction} ${m.type === 'template' ? 'template' : ''}">${media}<span class="body">${m.media_id && m.type === 'image' && m.body?.startsWith('[') ? '' : esc(m.body)}</span><div class="meta">${who}${fmtTime(m.created_at)} ${statusIcon(m)}</div></div>`;
  }).join('');
  $('#messages').scrollTop = $('#messages').scrollHeight;

  $('#windowClosed').classList.toggle('hidden', cv.windowOpen);
  $('#composer').classList.toggle('hidden', !cv.windowOpen);
  renderCustomer(customer, devices);
}

function renderCustomer(c, devices) {
  const p = $('#customerPanel');
  p.classList.remove('hidden');
  if (!c) {
    p.innerHTML = `<h3>Nicht zugeordnet</h3><p class="muted small">Diese Nummer ist in AkuWin keinem Kunden als Mobilnummer zugeordnet. Nach dem Eintrag in AkuWin wird die Konversation beim nächsten Import automatisch verknüpft.</p>`;
    return;
  }
  p.innerHTML = `
    <h3>${esc([c.salutation, c.first_name, c.last_name].filter(Boolean).join(' '))}</h3>
    <dl>
      <dt>Kd.-Nr.</dt><dd>${esc(c.akuwin_id)}</dd>
      <dt>Geburtstag</dt><dd>${fmtDate(c.birthday) || '–'}</dd>
      <dt>Mobil</dt><dd>${esc(c.mobile_raw || '–')}</dd>
      <dt>Filiale</dt><dd>${esc(state.me.branches.find((b) => b.id === c.branch_id)?.name || c.branch_id || '–')}</dd>
    </dl>
    <label class="optin"><input type="checkbox" id="optin" ${c.opt_in ? 'checked' : ''}> Einwilligung für WhatsApp-Erinnerungen</label>
    <p class="muted small">${c.opted_out_at ? `Abgemeldet am ${fmtDate(c.opted_out_at)}` : c.opt_in_at ? `Seit ${fmtDate(c.opt_in_at)} (${esc(c.opt_in_source)})` : 'Keine Einwilligung – erhält keine automatischen Nachrichten.'}</p>
    <h4>Hörsysteme</h4>
    <ul class="devices">${devices.map((d) => `<li><b>${esc(d.side || '')}</b> ${esc([d.manufacturer, d.model].filter(Boolean).join(' '))}<br><span class="muted small">Abgabe ${fmtDate(d.fitted_at) || '–'}${d.serial ? ` · SN ${esc(d.serial)}` : ''}</span></li>`).join('') || '<li class="muted">Keine Geräte erfasst</li>'}</ul>`;
  $('#optin').addEventListener('change', async (e) => {
    if (!confirm(e.target.checked ? 'Liegt die Einwilligung des Kunden vor (z.B. unterschriebenes Formular)?' : 'Einwilligung wirklich entfernen?')) { e.target.checked = !e.target.checked; return; }
    await api(`/customers/${c.id}/optin`, { method: 'POST', body: { optIn: e.target.checked, sentBy: initials() } });
    openConv(state.activeId);
  });
}

$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = $('#composerText').value.trim();
  if (!body) return;
  const btn = e.target.querySelector('button'); btn.disabled = true;
  try {
    await api(`/conversations/${state.activeId}/messages`, { method: 'POST', body: { body, sentBy: initials() } });
    $('#composerText').value = '';
    await openConv(state.activeId);
  } catch (err) { alert(err.message); } finally { btn.disabled = false; }
});
$('#composerText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); }
});
$('#sendTemplate').addEventListener('click', async () => {
  try {
    await api(`/conversations/${state.activeId}/template`, { method: 'POST', body: { templateIndex: $('#templateSelect').value, sentBy: initials() } });
    await openConv(state.activeId);
  } catch (err) { alert(err.message); }
});
$('#toggleDone').addEventListener('click', async () => {
  const done = state.detail.conversation.status !== 'done';
  await api(`/conversations/${state.activeId}/status`, { method: 'POST', body: { status: done ? 'done' : 'open' } });
  await loadConvs(); await openConv(state.activeId);
});

// ---------- Neue Konversation ----------
$('#newChat').addEventListener('click', () => {
  state.newCustomer = null; $('#custSearch').value = ''; $('#custResults').innerHTML = ''; $('#newSend').disabled = true;
  $('#newDialog').showModal(); $('#custSearch').focus();
});
let custTimer;
$('#custSearch').addEventListener('input', () => {
  clearTimeout(custTimer);
  custTimer = setTimeout(async () => {
    const list = await api(`/customers?q=${encodeURIComponent($('#custSearch').value)}`);
    $('#custResults').innerHTML = list.map((c) => `<li data-id="${c.id}" class="${c.mobile_e164 ? '' : 'disabled'}">
      ${esc(c.last_name)}, ${esc(c.first_name)} <span class="muted small">· ${esc(c.akuwin_id)} · ${c.mobile_e164 ? esc(c.phone) : 'keine Mobilnummer'}</span></li>`).join('');
  }, 250);
});
$('#custResults').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]'); if (!li || li.classList.contains('disabled')) return;
  document.querySelectorAll('#custResults li').forEach((x) => x.classList.toggle('sel', x === li));
  state.newCustomer = Number(li.dataset.id); $('#newSend').disabled = false;
});
$('#newSend').addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    const r = await api(`/customers/${state.newCustomer}/template`, { method: 'POST', body: { templateIndex: $('#newTemplate').value, sentBy: initials() } });
    $('#newDialog').close(); await loadConvs(); openConv(r.conversationId);
  } catch (err) { alert(err.message); }
});

// ---------- Automationen ----------
$('#previewDays').addEventListener('change', loadAutomations);
async function loadAutomations() {
  const b = state.branch ? `&branch=${encodeURIComponent(state.branch)}` : '';
  const [preview, runs, stats] = await Promise.all([
    api(`/automations/preview?days=${$('#previewDays').value}${b}`), api(`/automations/runs?${b}`), api(`/stats?${b}`),
  ]);
  $('#stats').innerHTML = `<div><b>${stats.customers ?? 0}</b>Kunden</div><div><b>${stats.withMobile ?? 0}</b>mit Mobilnummer</div>
    <div><b>${stats.optedIn ?? 0}</b>mit Einwilligung</div><div><b>${stats.optedOut ?? 0}</b>abgemeldet</div>`;
  $('#previewBody').innerHTML = preview.list.map((x) => `<tr><td>${fmtDate(x.dueDate)}</td><td>${esc(x.rule)}</td>
    <td>${esc(x.customer.name)} <span class="muted small">${esc(x.customer.akuwinId)}</span></td>
    <td>${x.device ? `${esc([x.device.manufacturer, x.device.model].filter(Boolean).join(' '))} <span class="muted small">(${fmtDate(x.device.fitted_at)})</span>` : ''}</td>
    <td>${x.alreadySent ? '<span class="ok">erledigt</span>' : x.skipReason ? `<span class="skip">wird übersprungen: ${esc(x.skipReason)}</span>` : '<span class="ok">wird gesendet</span>'}</td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">Nichts geplant</td></tr>';
  $('#runsBody').innerHTML = runs.map((r) => `<tr><td>${esc(r.created_at)}</td><td>${esc(r.rule_id)}</td>
    <td>${esc(r.first_name)} ${esc(r.last_name)}</td><td class="${r.status === 'sent' ? 'ok' : r.status === 'failed' ? 'fail' : 'skip'}">${esc(r.status)}</td><td>${esc(r.error || '')}</td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">Noch nichts gesendet</td></tr>';
}

// ---------- Admin ----------
$('#runImport').addEventListener('click', async () => {
  $('#adminResult').textContent = 'Import läuft…';
  try {
    const r = await api('/import', { method: 'POST' });
    $('#adminResult').textContent = `${r.customers} Kunden, ${r.devices} Geräte importiert, ${r.skipped} übersprungen.\n${r.warnings.slice(0, 20).join('\n')}`;
    loadImportLog();
  } catch (err) { $('#adminResult').textContent = err.message; }
});
$('#runAutomations').addEventListener('click', async () => {
  if (!confirm('Alle heute fälligen automatischen Nachrichten jetzt senden (auch außerhalb des Zeitfensters)?')) return;
  $('#adminResult').textContent = 'Sende…';
  try { const r = await api('/automations/run', { method: 'POST' }); $('#adminResult').textContent = `Gesendet: ${r.sent}, fehlgeschlagen: ${r.failed}, übersprungen: ${r.skipped}`; }
  catch (err) { $('#adminResult').textContent = err.message; }
});
async function loadImportLog() {
  const log = await api('/import/log');
  $('#importLog').innerHTML = log.map((l) => `<tr><td>${esc(l.created_at)}</td><td>${esc(l.source)}</td><td>${l.customers}</td><td>${l.devices}</td><td>${l.skipped}</td></tr>`).join('');
}

// ---------- Live-Updates ----------
function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('message', async (e) => {
    const ev = JSON.parse(e.data);
    if (ev.message.direction === 'in') notify(ev);
    await loadConvs();
    if (ev.conversation.id === state.activeId) openConv(state.activeId);
  });
  es.addEventListener('status', (e) => {
    const ev = JSON.parse(e.data);
    if (ev.conversationId === state.activeId) openConv(state.activeId);
  });
}

function notify(ev) {
  try { // kurzer Hinweiston
    const ctx = new AudioContext(), o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 880; g.gain.value = 0.08; o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.18);
  } catch {}
  document.title = '● Neue Nachricht – KundenDialog';
  setTimeout(() => { document.title = 'KundenDialog'; }, 8000);
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    new Notification('Neue WhatsApp-Nachricht', { body: ev.message.body || '' });
  }
}
if ('Notification' in window && Notification.permission === 'default') {
  document.addEventListener('click', () => Notification.requestPermission(), { once: true });
}

start();
