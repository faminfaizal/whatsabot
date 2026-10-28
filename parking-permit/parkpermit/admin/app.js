// Admin page for the parking permit bot. Plain JS, no build step (the server has no internet).
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const TOKEN_KEY = 'permitAdminToken';
const LOG_PAGE = 25;

let token = null;
try { token = sessionStorage.getItem(TOKEN_KEY); } catch {}
let statusTimer = null;
let logOffset = 0;

// ─── API ─────────────────────────────────────────────────────────
async function api(method, url, body, { raw = false } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && url !== '/api/login') { signOut(); throw new Error('Please sign in again'); }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return raw ? res : res.json();
}

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('bad', bad);
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 3000);
}

const fmt = iso => (iso ? new Date(iso).toLocaleString('en-MY', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtDate = d => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-MY', { dateStyle: 'medium' }) : '—');

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

// ─── Sign in / out ───────────────────────────────────────────────
function showLogin() {
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  clearInterval(statusTimer);
}

function signOut() {
  token = null;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
  showLogin();
}

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#login-error').textContent = '';
  try {
    const { token: t } = await api('POST', '/api/login', { username: f.get('username'), password: f.get('password') });
    token = t;
    try { sessionStorage.setItem(TOKEN_KEY, t); } catch {}
    e.target.reset();
    startApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', signOut);

// ─── Tabs ────────────────────────────────────────────────────────
function showTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== name; });
  if (name === 'log') loadLog();
}
$$('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));

// ─── Status ──────────────────────────────────────────────────────
const WA_TEXT = {
  open: ['ok', 'Connected'],
  qr: ['warn', 'Waiting for QR scan'],
  connecting: ['warn', 'Connecting…'],
  idle: ['bad', 'Not linked'],
};

async function loadStatus() {
  let s;
  try { s = await api('GET', '/api/status'); } catch { return; }
  const wa = s.whatsapp;
  const [cls, text] = WA_TEXT[wa.state] || ['bad', wa.state];
  $('#wa-dot').className = `dot ${cls}`;
  $('#wa-state').textContent = text + (wa.phone ? ` as +${wa.phone}` : '');
  $('#wa-detail').textContent = wa.error || (wa.state === 'idle' ? 'Link the bot\'s own phone number to start.' : '');
  $('#wa-qr-box').hidden = !wa.qr;
  if (wa.qr) $('#wa-qr').src = wa.qr;
  $('#wa-pair').hidden = wa.state !== 'idle';
  $('#wa-unlink').hidden = !wa.linked;

  const items = [
    [wa.state === 'open', 'WhatsApp connected', 'Link WhatsApp above'],
    [s.group_set, 'Admin group set', 'Set the admin group under Approvals'],
    [s.approvers > 0, `${s.approvers} approver${s.approvers === 1 ? '' : 's'}`, 'Add approvers under Approvals'],
    [s.chrome, 'Chrome found (PDF letters)', 'Chrome not found: set CHROME_PATH in .env'],
  ];
  $('#checklist').replaceChildren(...items.map(([ok, yes, no]) =>
    el('li', {}, el('span', { class: `mark ${ok ? 'ok' : 'no'}`, text: ok ? '✓' : '!' }), el('span', { text: ok ? yes : no }))));
  if (s.pending) $('#checklist').append(el('li', {}, el('span', { class: 'mark', text: '•' }), el('span', { text: `${s.pending} request${s.pending === 1 ? '' : 's'} awaiting a decision` })));
}

$('#wa-pair').addEventListener('click', async () => {
  try { await api('POST', '/api/whatsapp/pair'); toast('Generating QR code…'); setTimeout(loadStatus, 1500); }
  catch (e) { toast(e.message, true); }
});

$('#wa-unlink').addEventListener('click', async () => {
  if (!window.confirm('Unlink the bot from its WhatsApp number? Requests stop until it is linked again.')) return;
  try { await api('POST', '/api/whatsapp/unlink'); toast('Unlinked'); loadStatus(); }
  catch (e) { toast(e.message, true); }
});

// ─── Approvals settings ──────────────────────────────────────────
function approverRow(a = {}) {
  const tr = el('tr', {},
    el('td', {}, el('input', { name: 'name', value: a.name || '', placeholder: 'Siti Aminah', 'aria-label': 'Approver name' })),
    el('td', {}, el('input', { name: 'number', value: a.number || '', placeholder: '60123456789', inputmode: 'tel', 'aria-label': 'Phone number' })),
    el('td', {}, el('input', { name: 'lid', value: a.lid || '', placeholder: '…@lid', spellcheck: 'false', 'aria-label': 'LID' })),
    el('td', {}, el('button', { type: 'button', class: 'btn ghost danger', text: 'Remove', onclick: () => tr.remove() })));
  return tr;
}

function fillSettings(s) {
  const f = $('#settings-form');
  f.admin_group_id.value = s.admin_group_id || '';
  f.approval_timeout_hours.value = s.approval_timeout_hours;
  f.max_requests_per_day.value = s.max_requests_per_day;
  $('#approver-rows').replaceChildren(...(s.admin_approvers.length ? s.admin_approvers : [{}]).map(approverRow));

  const lf = $('#letter-form');
  const lh = s.letterhead;
  for (const k of ['org_name', 'title', 'address', 'phone', 'email', 'footer']) lf[k].value = lh[k] || '';
  lf.terms.value = (lh.terms || []).join('\n');
  for (const kind of ['logo', 'map']) showImage(kind, lh[`has_${kind}`]);
}

$('#add-approver').addEventListener('click', () => $('#approver-rows').append(approverRow()));

$('#group-picker').addEventListener('focus', loadGroups, { once: false });
$('#group-picker').addEventListener('change', e => { if (e.target.value) $('#settings-form').admin_group_id.value = e.target.value; });

async function loadGroups() {
  const sel = $('#group-picker');
  if (sel.dataset.loaded) return;
  try {
    const groups = await api('GET', '/api/groups');
    sel.replaceChildren(el('option', { value: '', text: groups.length ? 'Choose a group…' : 'The bot is in no groups' }),
      ...groups.map(g => el('option', { value: g.id, text: g.name || g.id })));
    sel.dataset.loaded = '1';
  } catch (e) {
    sel.replaceChildren(el('option', { value: '', text: e.message }));
  }
}

$('#settings-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const approvers = $$('#approver-rows tr').map(tr => ({
    name: $('[name=name]', tr).value, number: $('[name=number]', tr).value, lid: $('[name=lid]', tr).value,
  })).filter(a => a.name.trim() || a.number.trim() || a.lid.trim());
  try {
    const s = await api('PUT', '/api/settings', {
      admin_group_id: f.admin_group_id.value,
      approval_timeout_hours: Number(f.approval_timeout_hours.value),
      max_requests_per_day: Number(f.max_requests_per_day.value),
      admin_approvers: approvers,
    });
    fillSettings(s);
    toast('Saved');
    loadStatus();
  } catch (err) {
    toast(err.message, true);
  }
});

// ─── Letter ──────────────────────────────────────────────────────
function letterheadFromForm() {
  const f = $('#letter-form');
  const out = {};
  for (const k of ['org_name', 'title', 'address', 'phone', 'email', 'footer', 'terms']) out[k] = f[k].value;
  return out;
}

$('#letter-form').addEventListener('submit', async e => {
  e.preventDefault();
  try { fillSettings(await api('PUT', '/api/settings', { letterhead: letterheadFromForm() })); toast('Saved'); }
  catch (err) { toast(err.message, true); }
});

$('#preview').addEventListener('click', async () => {
  const btn = $('#preview');
  btn.disabled = true;
  // Open the tab now (inside the click) so pop-up blockers allow it, then fill it
  const win = window.open('', '_blank');
  try {
    const res = await api('POST', '/api/preview', { letterhead: letterheadFromForm() }, { raw: true });
    const url = URL.createObjectURL(await res.blob());
    if (win) win.location.href = url; else window.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    if (win) win.close();
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

async function showImage(kind, has) {
  const slot = $(`.image-slot[data-kind="${kind}"]`);
  const img = $('img', slot);
  $('.remove', slot).hidden = !has;
  $('.empty', slot).hidden = !!has;
  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  img.hidden = true;
  if (!has) return;
  try {
    const res = await api('GET', `/api/images/${kind}`, null, { raw: true });
    img.src = URL.createObjectURL(await res.blob());
    img.hidden = false;
  } catch {}
}

$$('.image-slot').forEach(slot => {
  const kind = slot.dataset.kind;
  $('input[type=file]', slot).addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Could not read the file'));
      r.readAsDataURL(file);
    });
    try { fillSettings(await api('POST', `/api/images/${kind}`, { data })); toast(`${kind === 'logo' ? 'Logo' : 'Map'} uploaded`); }
    catch (err) { toast(err.message, true); }
  });
  $('.remove', slot).addEventListener('click', async () => {
    try { fillSettings(await api('DELETE', `/api/images/${kind}`)); toast('Removed'); }
    catch (err) { toast(err.message, true); }
  });
});

// ─── Request log ─────────────────────────────────────────────────
async function loadLog() {
  const status = $('#log-status').value;
  let data;
  try { data = await api('GET', `/api/log?status=${encodeURIComponent(status)}&limit=${LOG_PAGE}&offset=${logOffset}`); }
  catch (e) { toast(e.message, true); return; }
  const rows = data.rows.map(r => el('tr', {},
    el('td', {}, el('strong', { text: r.ref_no })),
    el('td', {}, el('span', { class: `badge ${r.status}`, text: r.status })),
    el('td', { text: r.permit_start === r.permit_end ? fmtDate(r.permit_start) : `${fmtDate(r.permit_start)} – ${fmtDate(r.permit_end)}` }),
    el('td', { text: r.approver_name || '—' }),
    el('td', { text: fmt(r.created_at) }),
    el('td', { text: fmt(r.decided_at) }),
    el('td', { text: fmt(r.client_notified_at) }),
    el('td', { text: fmt(r.purged_at) })));
  $('#log-rows').replaceChildren(...(rows.length ? rows : [el('tr', { class: 'empty-row' }, el('td', { colspan: '8', text: 'No requests yet' }))]));
  const end = Math.min(logOffset + data.rows.length, data.total);
  $('#log-count').textContent = data.total ? `${logOffset + 1}–${end} of ${data.total}` : '';
  $('#log-prev').disabled = logOffset === 0;
  $('#log-next').disabled = end >= data.total;
}

$('#log-status').addEventListener('change', () => { logOffset = 0; loadLog(); });
$('#log-prev').addEventListener('click', () => { logOffset = Math.max(0, logOffset - LOG_PAGE); loadLog(); });
$('#log-next').addEventListener('click', () => { logOffset += LOG_PAGE; loadLog(); });

// ─── Start ───────────────────────────────────────────────────────
async function startApp() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  try { fillSettings(await api('GET', '/api/settings')); } catch (e) { if (token) toast(e.message, true); return; }
  loadStatus();
  clearInterval(statusTimer);
  statusTimer = setInterval(loadStatus, 4000);   // QR codes rotate; keep the status fresh
}

if (token) startApp(); else showLogin();
