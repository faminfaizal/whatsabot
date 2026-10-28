// Run: node --test server.test.js
// Admin API (createApp) with a real settings store and approvals db, fake WhatsApp connection.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createApp, sniffImage, adminConfigError } = require('./server');
const { createSettingsStore } = require('./settings');
const createApprovalDb = require('./approvalDb');

const ENV = { PERMIT_ADMIN_USER: 'facilities', PERMIT_ADMIN_PASSWORD: 'S3cure-pass!', PERMIT_JWT_SECRET: 'x'.repeat(40) };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const quiet = { log() {}, warn() {}, error() {} };

async function startServer({ env = ENV, chromePath = 'chrome.exe' } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-'));
  const settings = createSettingsStore(path.join(dataDir, 'settings.json'));
  const approvals = createApprovalDb(new Database(':memory:'));
  const previews = [];
  const workflow = { approvals, letters: { previewLetter: async lh => { previews.push(lh); return Buffer.from('%PDF-1.4 preview'); } } };
  const conn = { st: 'open', status() { return { state: this.st, qr: null, phone: '60100000000', linked: true, error: null }; }, pair() {}, async unlink() {} };
  const client = { getChats: async () => [{ isGroup: true, name: 'Facilities', id: { _serialized: '120363041234567890@g.us' } }] };
  const app = createApp({ settings, workflow, client, connection: conn, dataDir, chromePath, env, log: quiet });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = null;
  const call = async (method, url, body, tok = token) => {
    const res = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  const login = async () => { token = (await call('POST', '/api/login', { username: ENV.PERMIT_ADMIN_USER, password: ENV.PERMIT_ADMIN_PASSWORD })).data.token; return token; };
  return { server, call, login, settings, approvals, dataDir, previews, conn, close: () => server.close() };
}

test('admin config: missing or weak credentials disable login', async () => {
  assert.match(adminConfigError({}), /must be set/);
  assert.match(adminConfigError({ ...ENV, PERMIT_ADMIN_PASSWORD: 'admin123' }), /too weak/);
  assert.match(adminConfigError({ ...ENV, PERMIT_JWT_SECRET: 'short' }), /at least 32/);
  assert.equal(adminConfigError(ENV), null);
  const s = await startServer({ env: {} });
  try { assert.equal((await s.call('POST', '/api/login', { username: 'a', password: 'b' })).status, 503); }
  finally { s.close(); }
});

test('every API route needs a token; login lockout after 5 failures', async () => {
  const s = await startServer();
  try {
    for (const [m, u] of [['GET', '/api/status'], ['GET', '/api/settings'], ['PUT', '/api/settings'], ['GET', '/api/log'],
      ['POST', '/api/preview'], ['POST', '/api/images/logo'], ['GET', '/api/groups'], ['POST', '/api/whatsapp/unlink']]) {
      assert.equal((await s.call(m, u, m === 'GET' ? undefined : {})).status, 401, `${m} ${u}`);
    }
    assert.equal((await s.call('GET', '/api/status', null, 'forged.token.here')).status, 401);
    for (let i = 0; i < 5; i++) assert.equal((await s.call('POST', '/api/login', { username: ENV.PERMIT_ADMIN_USER, password: 'wrong' })).status, 401);
    const locked = await s.call('POST', '/api/login', { username: ENV.PERMIT_ADMIN_USER, password: ENV.PERMIT_ADMIN_PASSWORD });
    assert.equal(locked.status, 429);
  } finally { s.close(); }
});

test('status, groups, settings round-trip with validation errors listed', async () => {
  const s = await startServer();
  try {
    await s.login();
    const st = (await s.call('GET', '/api/status')).data;
    assert.deepEqual({ ...st, whatsapp: st.whatsapp.state }, { whatsapp: 'open', chrome: true, group_set: false, approvers: 0, pending: 0 });
    assert.deepEqual((await s.call('GET', '/api/groups')).data, [{ id: '120363041234567890@g.us', name: 'Facilities' }]);

    const bad = await s.call('PUT', '/api/settings', { approval_timeout_hours: 0, admin_group_id: 'nope' });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.errors.length, 2);

    const ok = await s.call('PUT', '/api/settings', { admin_group_id: '120363041234567890@g.us', admin_approvers: [{ name: 'Siti', number: '0123456789' }] });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.admin_approvers[0].number, '60123456789');
    assert.equal('logo_path' in ok.data.letterhead, false, 'server file paths are not exposed');
    assert.equal(ok.data.letterhead.has_logo, false);

    s.conn.st = 'idle';
    assert.equal((await s.call('GET', '/api/groups')).status, 409);
  } finally { s.close(); }
});

test('image upload: type from bytes, size limits, server-chosen name, serve and remove', async () => {
  const s = await startServer();
  try {
    await s.login();
    const up = await s.call('POST', '/api/images/logo', { data: `data:image/png;base64,${PNG.toString('base64')}` });
    assert.equal(up.status, 200);
    assert.equal(up.data.letterhead.has_logo, true);
    const saved = s.settings.get().letterhead.logo_path;
    assert.equal(saved, path.join(s.dataDir, 'letterhead', 'logo.png'));

    const got = await s.call('GET', '/api/images/logo');
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.ok(got.data.equals(PNG));

    assert.equal((await s.call('POST', '/api/images/logo', { data: Buffer.from('<svg onload=alert(1)/>').toString('base64') })).status, 400);
    assert.equal((await s.call('POST', '/api/images/logo', { data: Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]).toString('base64') })).status, 400);
    assert.equal((await s.call('POST', '/api/images/map', { data: Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]).toString('base64') })).status, 200, 'map allows up to 3 MB');
    assert.equal((await s.call('POST', '/api/images/../../evil', { data: PNG.toString('base64') })).status, 404);

    const del = await s.call('DELETE', '/api/images/logo');
    assert.equal(del.data.letterhead.has_logo, false);
    assert.equal(fs.existsSync(saved), false);
  } finally { s.close(); }
});

test('preview uses the unsaved form letterhead plus saved images; refuses invalid input or no Chrome', async () => {
  const s = await startServer();
  try {
    await s.login();
    s.settings.setImage('map', '/data/letterhead/map.png');
    const res = await s.call('POST', '/api/preview', { letterhead: { org_name: 'Draft Org', logo_path: 'C:\\evil.png' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(s.previews[0].org_name, 'Draft Org');
    assert.equal(s.previews[0].map_path, '/data/letterhead/map.png');
    assert.equal(s.previews[0].logo_path, '', 'client cannot point the renderer at a file');
    assert.equal((await s.call('POST', '/api/preview', { letterhead: { email: 'bad' } })).status, 400);
  } finally { s.close(); }
  const noChrome = await startServer({ chromePath: null });
  try {
    await noChrome.login();
    assert.equal((await noChrome.call('POST', '/api/preview', { letterhead: {} })).status, 409);
  } finally { noChrome.close(); }
});

test('request log comes from approval_log only: no applicant details, filters and bad status', async () => {
  const s = await startServer();
  try {
    await s.login();
    const ref = s.approvals.createRequest({ clientJid: '60111111111@s.whatsapp.net', name: 'Ahmad Faiz', carReg: 'WXY1234',
      start: '2099-12-01', end: '2099-12-31', justification: 'Night shift duty' }, 36);
    s.approvals.approve(ref, 'Siti', 'Bay B2 only');
    const log = await s.call('GET', '/api/log');
    assert.equal(log.data.total, 1);
    const text = JSON.stringify(log.data);
    for (const p of ['Ahmad', 'WXY1234', '60111111111', 'Night shift', 'Bay B2']) assert.ok(!text.includes(p), p);
    assert.equal((await s.call('GET', '/api/log?status=REJECTED')).data.total, 0);
    assert.equal((await s.call('GET', '/api/log?status=bogus')).status, 400);
  } finally { s.close(); }
});

test('admin page is served with strict security headers', async () => {
  const s = await startServer();
  try {
    const page = await s.call('GET', '/');
    assert.equal(page.status, 200);
    assert.ok(page.data.toString().includes('Parking Permit Admin'));
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'.*frame-ancestors 'none'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal((await s.call('GET', '/api/nope')).status, 401, 'unknown API paths still need auth');
  } finally { s.close(); }
});

test('/healthz answers without a token and reveals nothing', async () => {
  const s = await startServer();
  try {
    const r = await s.call('GET', '/healthz');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { ok: true });
  } finally { s.close(); }
});

test('sniffImage recognises PNG, JPEG, WEBP only', () => {
  assert.equal(sniffImage(PNG).ext, '.png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])).ext, '.jpg');
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')).ext, '.webp');
  assert.equal(sniffImage(Buffer.from('GIF89a......')), null);
});
