// Run: node --test letter.test.js
// The real-PDF tests run when Chrome is found (pdf.js findChrome, or CHROME_PATH); otherwise skipped.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const createApprovalDb = require('./approvalDb');
const { createLetterService, renderLetterHtml, loadLogo, loadMap } = require('./letter');

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'letter-'));
const quiet = { warn: () => {}, error: () => {} };

const approvedRow = (o = {}) => ({
  ref_no: 'PP-0042', status: 'APPROVED', applicant_name: 'Ahmad Faiz', car_reg: 'WXY1234',
  permit_start: '2026-11-01', permit_end: '2026-11-30', justification: 'Night shift duty',
  approver_name: 'Siti Aminah', remark: 'Bay B2 only', decided_at: '2026-10-25T07:12:00.000Z', ...o,
});

function setup() {
  const approvals = createApprovalDb(new Database(':memory:'));
  const ref = approvals.createRequest({
    clientJid: '60111111111@c.us', name: 'Ahmad Faiz', carReg: 'WXY1234',
    start: '2026-11-01', end: '2026-11-30', justification: 'Night shift duty',
  }, 36);
  return { approvals, ref };
}

// Fake renderPdf that records the HTML it was given
function fakeRenderer({ fail = false } = {}) {
  const calls = { renders: 0, html: null };
  const renderPdf = async html => {
    calls.renders++;
    calls.html = html;
    if (fail) throw new Error('render failed');
    return Buffer.from('%PDF-1.4 fake');
  };
  return { calls, renderPdf };
}

// ── HTML ─────────────────────────────────────────────────
test('letter shows every request field, approver, remark and MYT issue date', () => {
  const html = renderLetterHtml(approvedRow(), { org_name: 'Menara ABC', address: 'Jalan 1\nKuala Lumpur', phone: '03-1234 5678', email: 'admin@abc.my', terms: ['Display on dashboard'] });
  for (const s of ['PP-0042', 'Ahmad Faiz', 'WXY 1234', '1 Nov 2026', '30 Nov 2026', '30 days',
    'Night shift duty', 'Siti Aminah', 'Bay B2 only', '25 Oct 2026', '3:12 PM', 'APPROVED',
    'Menara ABC', 'Jalan 1<br>Kuala Lumpur', 'Tel: 03-1234 5678', 'admin@abc.my']) assert.ok(html.includes(s), s);
  for (const p of ['[Organisation Name]', '[Address]', '[Phone]', '[Permit conditions']) assert.ok(!html.includes(p), `no ${p} when filled`);
  assert.ok(html.includes('1 Nov 2026 – 30 Nov 2026 (30 days)'));
});

test('empty letterhead prints visible placeholders and defaults', () => {
  const html = renderLetterHtml(approvedRow(), {});
  for (const s of ['[Organisation Name]', '[Address]', '[Phone] · [Email]', '[Permit conditions',
    'Building Parking Permit: Approval', 'computer-generated letter']) assert.ok(html.includes(s), s);
  assert.equal(renderLetterHtml(approvedRow(), null).includes('[Organisation Name]'), true, 'null letterhead ok');
});

test('custom title, terms (array or multi-line), and footer', () => {
  const a = renderLetterHtml(approvedRow(), { title: 'Car Park Pass', terms: ['Display on dashboard', 'Non-transferable'], footer: 'Issued by Facilities' });
  assert.ok(a.includes('Car Park Pass: Approval'));
  assert.ok(a.includes('<li>Display on dashboard</li><li>Non-transferable</li>'));
  assert.ok(a.includes('Issued by Facilities'));
  const b = renderLetterHtml(approvedRow(), { terms: 'One\n\nTwo\n' });
  assert.ok(b.includes('<li>One</li><li>Two</li>'));
});

test('no remark shows a dash; single-day permit says 1 day', () => {
  const html = renderLetterHtml(approvedRow({ remark: null, permit_end: '2026-11-01' }), {});
  assert.match(html, /<th>Remark<\/th><td>—<\/td>/);
  assert.ok(html.includes('<td>1 Nov 2026 (1 day)</td>'), 'single day shows one date');
});

test('client-typed and admin-typed text is HTML-escaped', () => {
  const evil = '<script>alert(1)</script><img src="file:///C:/secret">';
  const html = renderLetterHtml(approvedRow({ applicant_name: evil, justification: evil, remark: evil }), { org_name: evil });
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!html.includes('<img src="file'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('letter page carries a CSP that blocks scripts and every non-data: load', () => {
  const html = renderLetterHtml(approvedRow(), {});
  assert.ok(html.includes(`content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"`));
});

// ── logo ─────────────────────────────────────────────────
test('logo: PNG becomes a data URI; bad type, missing or oversized files are skipped with a warning', () => {
  const dir = tmpDir();
  const png = path.join(dir, 'logo.png'); fs.writeFileSync(png, PNG_1PX);
  const svg = path.join(dir, 'logo.svg'); fs.writeFileSync(svg, '<svg/>');
  const big = path.join(dir, 'big.jpg'); fs.writeFileSync(big, Buffer.alloc(1024 * 1024 + 1));
  const warns = [];
  const log = { warn: m => warns.push(m) };
  assert.match(loadLogo(png, log), /^data:image\/png;base64,/);
  assert.equal(loadLogo(svg, log), null);
  assert.equal(loadLogo(path.join(dir, 'nope.png'), log), null);
  assert.equal(loadLogo(big, log), null);
  assert.equal(loadLogo('', log), null);
  assert.equal(warns.length, 3);
  assert.ok(renderLetterHtml(approvedRow(), {}, { logo: loadLogo(png, log) }).includes('<img class="logo" src="data:image/png'));
});

test('parking map: placeholder box when unset, full-width image when set, 3 MB limit', () => {
  const noMap = renderLetterHtml(approvedRow(), {});
  assert.ok(noMap.includes('Parking Lot Map'));
  assert.ok(noMap.includes('<div class="ph-box"><span class="ph">[Parking lot map]</span></div>'));

  const dir = tmpDir();
  const map = path.join(dir, 'map.png'); fs.writeFileSync(map, PNG_1PX);
  const bigOk = path.join(dir, 'ok.jpg'); fs.writeFileSync(bigOk, Buffer.alloc(2 * 1024 * 1024));
  const tooBig = path.join(dir, 'big.jpg'); fs.writeFileSync(tooBig, Buffer.alloc(3 * 1024 * 1024 + 1));
  const warns = [];
  const log = { warn: m => warns.push(m) };
  const withMap = renderLetterHtml(approvedRow(), {}, { map: loadMap(map, log) });
  assert.ok(withMap.includes('<img src="data:image/png;base64,'));
  assert.ok(!withMap.includes('[Parking lot map]'));
  assert.ok(loadMap(bigOk, log), '2 MB map accepted (logo limit is 1 MB)');
  assert.equal(loadMap(tooBig, log), null);
  assert.match(warns[0], /parking map larger than 3 MB/);
});

test('issueLetter embeds the map from letterhead.map_path', async () => {
  const { approvals, ref } = setup();
  approvals.approve(ref, 'Siti');
  const map = path.join(tmpDir(), 'map.png'); fs.writeFileSync(map, PNG_1PX);
  const r = fakeRenderer();
  const svc = createLetterService({ approvals, getLetterhead: () => ({ map_path: map }), outDir: tmpDir(), renderPdf: r.renderPdf, log: quiet });
  await svc.issueLetter(ref);
  assert.ok(r.calls.html.includes('alt="Parking lot map"'));
});

// ── issueLetter ──────────────────────────────────────────
test('issueLetter writes <ref>.pdf and stores the path', async () => {
  const { approvals, ref } = setup();
  approvals.approve(ref, 'Siti Aminah', 'Bay B2');
  const dir = path.join(tmpDir(), 'permits');   // created on demand
  const r = fakeRenderer();
  const svc = createLetterService({ approvals, getLetterhead: () => ({}), outDir: dir, renderPdf: r.renderPdf, log: quiet });
  const p = await svc.issueLetter(ref);
  assert.equal(p, path.join(dir, 'PP-0001.pdf'));
  assert.ok(fs.readFileSync(p).toString().startsWith('%PDF'));
  assert.ok(!fs.existsSync(`${p}.tmp`));
  assert.equal(approvals.getRequest(ref).pdf_path, p);
  assert.ok(r.calls.html.includes('Bay B2'));
});

test('issueLetter is reusable on retry: existing file is returned without re-rendering', async () => {
  const { approvals, ref } = setup();
  approvals.approve(ref, 'Siti Aminah');
  const r = fakeRenderer();
  const svc = createLetterService({ approvals, getLetterhead: () => ({}), outDir: tmpDir(), renderPdf: r.renderPdf, log: quiet });
  const p1 = await svc.issueLetter(ref);
  const p2 = await svc.issueLetter(ref);
  assert.equal(p1, p2);
  assert.equal(r.calls.renders, 1);
});

test('issueLetter refuses requests that are not approved, or unknown', async () => {
  const { approvals, ref } = setup();
  const svc = createLetterService({ approvals, getLetterhead: () => ({}), outDir: tmpDir(), renderPdf: fakeRenderer().renderPdf, log: quiet });
  await assert.rejects(svc.issueLetter(ref), /PENDING, not APPROVED/);
  approvals.reject(ref, 'Siti', 'no');
  await assert.rejects(svc.issueLetter(ref), /REJECTED, not APPROVED/);
  await assert.rejects(svc.issueLetter('PP-9999'), /not found/);
});

test('render failure leaves no PDF or temp file behind', async () => {
  const { approvals, ref } = setup();
  approvals.approve(ref, 'Siti');
  const dir = tmpDir();
  const svc = createLetterService({ approvals, getLetterhead: () => ({}), outDir: dir, renderPdf: fakeRenderer({ fail: true }).renderPdf, log: quiet });
  await assert.rejects(svc.issueLetter(ref), /render failed/);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(approvals.getRequest(ref).pdf_path, null);
});

test('previewLetter renders sample data with the given letterhead and touches no db or folder', async () => {
  const { approvals } = setup();
  const before = JSON.stringify(approvals.getLog('PP-0001'));
  const dir = tmpDir();
  const r = fakeRenderer();
  const svc = createLetterService({ approvals, getLetterhead: () => ({ org_name: 'Saved Org' }), outDir: dir, renderPdf: r.renderPdf, log: quiet });
  const pdf = await svc.previewLetter({ org_name: 'Unsaved Org' });
  assert.ok(pdf.toString().startsWith('%PDF'));
  assert.ok(r.calls.html.includes('Unsaved Org') && !r.calls.html.includes('Saved Org'));
  assert.ok(r.calls.html.includes('PP-0000') && r.calls.html.includes('Sample Applicant'));
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(JSON.stringify(approvals.getLog('PP-0001')), before);
});

// ── real Chrome (pdf.js) ─────────────────────────────────
const { createPdfRenderer, findChrome, countPdfPages } = require('./pdf');
const CHROME = findChrome();

// Solid-colour RGB PNG of any size (no image library needed)
function makePng(width, height) {
  const zlib = require('node:zlib');
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;   // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x9c)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('real PDF: one A4 page with full letterhead, logo and a tall map', { skip: !CHROME && 'Chrome not found (set CHROME_PATH)' }, async () => {
  const { approvals, ref } = setup();
  approvals.approve(ref, 'Siti Aminah', 'Bay B2 only');
  const dir = process.env.LETTER_OUT || tmpDir();
  const imgDir = tmpDir();
  const logo = path.join(imgDir, 'logo.png'); fs.writeFileSync(logo, makePng(240, 80));
  const tallMap = path.join(imgDir, 'map.png'); fs.writeFileSync(tallMap, makePng(400, 1200));   // hits the 100mm cap
  const svc = createLetterService({
    approvals, outDir: dir, renderPdf: createPdfRenderer({ chromePath: CHROME }), log: quiet,
    getLetterhead: () => (process.env.LETTER_PLACEHOLDERS ? {} : {
      org_name: 'Menara Contoh Sdn Bhd', address: 'Level 1, Jalan Contoh\n50000 Kuala Lumpur',
      phone: '03-1234 5678', email: 'facilities@contoh.my', logo_path: logo,
      map_path: process.env.LETTER_MAP || tallMap,
      terms: ['Display this letter on the dashboard.', 'Permit is not transferable.',
              'Park only in the bay stated in the remark.', 'Management may revoke this permit at any time.'],
    }),
  });
  const buf = fs.readFileSync(await svc.issueLetter(ref));
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(countPdfPages(buf), 1, 'letter fits on one page');
  assert.match(buf.toString('latin1'), /MediaBox \[0 0 59[45]\.\d+ 84[12]\.\d+\]/, 'A4 page size');
});

test('real PDF: scripts in the HTML do not run', { skip: !CHROME && 'Chrome not found (set CHROME_PATH)' }, async () => {
  const renderPdf = createPdfRenderer({ chromePath: CHROME });
  // If the script ran it would add 30 pages
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><p>one page</p>
    <script>for (let i = 0; i < 30; i++) document.body.insertAdjacentHTML('beforeend', '<div style="page-break-before:always">x</div>');</script>
    </body></html>`;
  assert.equal(countPdfPages(await renderPdf(html)), 1);
});
