// letter.js — renders the approval letter for an APPROVED permit request as a PDF
//
// Usage (permitWorkflow.js):
//   const letters = require('./letter').createLetterService({
//     approvals,
//     getLetterhead: () => getSettings().letterhead,  // editable in the admin page
//     outDir: path.join(DATA_DIR, 'letters'),
//     renderPdf,                                      // html → Buffer, from pdf.js (headless Chrome)
//   });
//   const pdfPath = await letters.issueLetter('PP-0042');
//   const previewPdf = await letters.previewLetter(letterhead);   // dummy data, no db access
//
// settings.letterhead (every field optional; blanks print as orange [placeholders]):
//   { "org_name": "", "address": "line 1\nline 2", "phone": "", "email": "", "logo_path": "",
//     "map_path": "", "title": "Building Parking Permit", "terms": ["condition 1", "condition 2"], "footer": "" }
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { formatCarReg, formatDate } = require('./intake');
const { formatDateTimeMYT } = require('./adminGroup');

const LOGO_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const MAX_LOGO_BYTES = 1024 * 1024;
const MAX_MAP_BYTES = 3 * 1024 * 1024;
const DEFAULT_TITLE = 'Building Parking Permit';
const DEFAULT_FOOTER = 'This is a computer-generated letter. No signature is required.';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = s => String(s ?? '').trim();
const ph = text => `<span class="ph">${esc(text)}</span>`;
const orPh = (value, placeholder) => (clean(value) ? esc(clean(value)) : ph(placeholder));

// Image file → data URI (the page loads nothing from disk or network). Null if absent or unusable.
function loadImage(filePath, { label, maxBytes }, log = console) {
  const p = clean(filePath);
  if (!p) return null;
  const type = LOGO_TYPES[path.extname(p).toLowerCase()];
  if (!type) { log.warn(`[permit] ${label} must be PNG, JPG or WEBP: ${p}`); return null; }
  try {
    const buf = fs.readFileSync(p);
    if (buf.length > maxBytes) { log.warn(`[permit] ${label} larger than ${maxBytes / 1048576} MB, skipped: ${p}`); return null; }
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch (e) {
    log.warn(`[permit] ${label} not readable, skipped: ${p} (${e.code || e.message})`);
    return null;
  }
}
const loadLogo = (p, log) => loadImage(p, { label: 'logo', maxBytes: MAX_LOGO_BYTES }, log);
const loadMap = (p, log) => loadImage(p, { label: 'parking map', maxBytes: MAX_MAP_BYTES }, log);

const toLines = v => (Array.isArray(v) ? v : String(v ?? '').split(/\r?\n/)).map(clean).filter(Boolean);

// images: { logo, map } as data URIs (or null)
function renderLetterHtml(r, letterhead = {}, images = {}) {
  const { logo: logoDataUri = null, map: mapDataUri = null } = images || {};
  const lh = letterhead || {};
  const days = Math.round((Date.parse(r.permit_end) - Date.parse(r.permit_start)) / 864e5) + 1;
  const decided = r.decided_at || new Date().toISOString();
  const issuedOn = formatDateTimeMYT(decided).split(',')[0];
  const title = clean(lh.title) || DEFAULT_TITLE;
  const period = r.permit_start === r.permit_end
    ? formatDate(r.permit_start)
    : `${formatDate(r.permit_start)} – ${formatDate(r.permit_end)}`;

  const address = toLines(lh.address);
  const contact = [clean(lh.phone) && `Tel: ${esc(clean(lh.phone))}`, clean(lh.email) && esc(clean(lh.email))].filter(Boolean);
  const terms = toLines(lh.terms);

  const row = (label, value) => `<tr><th>${label}</th><td>${value}</td></tr>`;

  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${esc(r.ref_no)}</title>
<style>
  @page { size: A4; margin: 18mm 18mm 20mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", Arial, Helvetica, sans-serif; color: #1a1a1a; font-size: 10pt; line-height: 1.4; }
  .head { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid #1f3b5c; padding-bottom: 10px; }
  .logo { max-height: 60px; max-width: 160px; }
  .org { font-size: 15pt; font-weight: 700; color: #1f3b5c; }
  .sub { font-size: 9pt; color: #444; }
  .ph { color: #b45309; font-style: italic; }
  .meta { display: flex; justify-content: space-between; margin: 12px 0 0; font-size: 9.5pt; }
  .titlebar { display: flex; align-items: center; justify-content: space-between; margin: 12px 0 6px; }
  h1 { font-size: 14pt; margin: 0; letter-spacing: .3px; }
  .stamp { border: 2px solid #15803d; color: #15803d; font-weight: 700; padding: 2px 12px; border-radius: 4px; letter-spacing: 2px; font-size: 10pt; }
  p { margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 10px; }
  th, td { border: 1px solid #cbd5e1; padding: 4px 10px; vertical-align: top; text-align: left; }
  th { width: 32%; background: #f1f5f9; font-weight: 600; }
  td { white-space: pre-line; word-break: break-word; }
  h2 { font-size: 10.5pt; margin: 10px 0 4px; }
  ol { margin: 4px 0; padding-left: 20px; font-size: 9.5pt; }
  .map { break-inside: avoid; margin: 4px 0 12px; }
  .map img { display: block; margin: 0 auto; width: auto; height: auto; max-width: 100%; max-height: 85mm; border: 1px solid #cbd5e1; }
  .map .ph-box { display: flex; align-items: center; justify-content: center; width: 100%; height: 80mm;
                 border: 2px dashed #f59e0b; background: #fffbeb; border-radius: 4px; }
  .foot { margin-top: 12px; padding-top: 6px; border-top: 1px solid #cbd5e1; font-size: 8.5pt; color: #555; }
</style></head>
<body>
  <div class="head">
    ${logoDataUri ? `<img class="logo" src="${logoDataUri}" alt="">` : ''}
    <div>
      <div class="org">${orPh(lh.org_name, '[Organisation Name]')}</div>
      <div class="sub">${address.length ? address.map(esc).join('<br>') : ph('[Address]')}</div>
      <div class="sub">${contact.length ? contact.join(' &nbsp;·&nbsp; ') : ph('[Phone] · [Email]')}</div>
    </div>
  </div>

  <div class="meta">
    <div><strong>Ref No:</strong> ${esc(r.ref_no)}</div>
    <div><strong>Date:</strong> ${esc(issuedOn)}</div>
  </div>

  <div class="titlebar">
    <h1>${esc(title)}: Approval</h1>
    <span class="stamp">APPROVED</span>
  </div>

  <p>To: <strong>${esc(r.applicant_name)}</strong></p>
  <p>Your application for a building parking permit has been approved with the following details:</p>

  <table>
    ${row('Name', esc(r.applicant_name))}
    ${row('Car Registration No.', esc(formatCarReg(r.car_reg)))}
    ${row('Valid Period', `${esc(period)} (${days} day${days === 1 ? '' : 's'})`)}
    ${row('Justification', esc(r.justification))}
    ${row('Approved By', esc(r.approver_name))}
    ${row('Remark', clean(r.remark) ? esc(clean(r.remark)) : '—')}
  </table>

  <h2>Parking Lot Map</h2>
  <div class="map">${mapDataUri
    ? `<img src="${mapDataUri}" alt="Parking lot map">`
    : `<div class="ph-box">${ph('[Parking lot map]')}</div>`}</div>

  <h2>Conditions</h2>
  <ol>${(terms.length ? terms.map(esc) : [ph('[Permit conditions, e.g. display this letter on the dashboard]')]).map(t => `<li>${t}</li>`).join('')}</ol>

  <p>Please keep this letter and present it when requested by building management or security.</p>

  <div class="foot">
    ${esc(clean(lh.footer) || DEFAULT_FOOTER)}<br>
    Approved by ${esc(r.approver_name)} on ${esc(formatDateTimeMYT(decided))} (Malaysia time). Ref ${esc(r.ref_no)}.
  </div>
</body></html>`;
}

// Dummy approved request for the admin page's "Preview letter" (never stored)
const SAMPLE_REQUEST = Object.freeze({
  ref_no: 'PP-0000', status: 'APPROVED', applicant_name: 'Sample Applicant', car_reg: 'ABC1234',
  permit_start: '2026-01-01', permit_end: '2026-01-31',
  justification: 'Sample justification text, as typed by the applicant.',
  approver_name: 'Sample Approver', remark: 'Sample remark',
});

const renderWithImages = (r, lh, log) =>
  renderLetterHtml(r, lh, { logo: loadLogo(lh.logo_path, log), map: loadMap(lh.map_path, log) });

function createLetterService({ approvals, getLetterhead, outDir, renderPdf, log = console }) {
  // Renders and saves the PDF for an approved request. Returns its path.
  // Safe to call again (e.g. on retry): reuses the existing file.
  async function issueLetter(ref) {
    const r = approvals.getRequest(ref);
    if (!r) throw new Error(`${ref} not found`);
    if (r.status !== 'APPROVED') throw new Error(`${ref} is ${r.status}, not APPROVED`);
    if (r.pdf_path && fs.existsSync(r.pdf_path)) return r.pdf_path;

    // The letter contains client-typed text: everything is escaped, the page's CSP blocks scripts
    // and every non-data: load, and pdf.js runs Chrome with scripts disabled.
    const html = renderWithImages(r, getLetterhead() || {}, log);

    await fs.promises.mkdir(outDir, { recursive: true });
    const finalPath = path.join(outDir, `${ref}.pdf`);   // file name carries no PII
    const tmpPath = `${finalPath}.tmp`;

    try {
      const pdf = await renderPdf(html);
      await fs.promises.writeFile(tmpPath, pdf);
      await fs.promises.rename(tmpPath, finalPath);
    } catch (e) {
      await fs.promises.unlink(tmpPath).catch(() => {});
      throw e;
    }

    approvals.setPdfPath(ref, finalPath);
    return finalPath;
  }

  // PDF for the admin page's preview: sample data and the given (possibly unsaved) letterhead.
  // Touches neither the db nor the letters folder.
  async function previewLetter(letterhead) {
    const sample = { ...SAMPLE_REQUEST, decided_at: new Date().toISOString() };
    return renderPdf(renderWithImages(sample, letterhead || getLetterhead() || {}, log));
  }

  return { issueLetter, previewLetter };
}

module.exports = { createLetterService, renderLetterHtml, loadLogo, loadMap, SAMPLE_REQUEST };
