// pdf.js — renders letter HTML to PDF with the server's installed Google Chrome (headless CLI).
//
// No npm packages: Chrome's own --print-to-pdf. Each render runs in a fresh temp folder with its
// own profile (so it never attaches to a Chrome someone has open). Every page gets a CSP that blocks
// scripts and every load except inline styles and data: images. One render at a time.
// (Chrome's --blink-settings=scriptEnabled=false would be simpler, but it stops --print-to-pdf
// from writing anything, so the CSP does that job.)
//
// Usage:
//   const { createPdfRenderer, findChrome } = require('./pdf');
//   const renderPdf = createPdfRenderer({ chromePath: findChrome() });
//   const buf = await renderPdf(html);
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const RENDER_TIMEOUT_MS = 60_000;
const LOCKDOWN_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`;

// Puts the CSP first in <head> so it applies before anything else on the page is parsed
function lockDown(html) {
  const s = String(html);
  const head = s.match(/<head[^>]*>/i);
  if (head) return s.slice(0, head.index + head[0].length) + LOCKDOWN_CSP + s.slice(head.index + head[0].length);
  return `<!doctype html><html><head><meta charset="utf-8">${LOCKDOWN_CSP}</head><body>${s}</body></html>`;
}

// CHROME_PATH first, then the usual Chrome install locations, then Edge as a fallback.
function findChrome(env = process.env, exists = fs.existsSync) {
  const pf = env.ProgramFiles || 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = env.LOCALAPPDATA || '';
  const candidates = [
    env.CHROME_PATH,
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find(p => exists(p)) || null;
}

function createPdfRenderer({ chromePath, timeoutMs = RENDER_TIMEOUT_MS, run = execFile, platform = process.platform } = {}) {
  let chain = Promise.resolve();   // serialises renders: one Chrome at a time

  async function renderOnce(html) {
    if (!chromePath) throw new Error('Chrome not found (set CHROME_PATH)');
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'permit-pdf-'));
    const htmlPath = path.join(dir, 'letter.html');
    const pdfPath = path.join(dir, 'letter.pdf');
    try {
      await fs.promises.writeFile(htmlPath, lockDown(html), 'utf8');
      const args = [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--disable-sync', '--disable-background-networking',
        '--no-pdf-header-footer',
        // Container (Linux): Chrome's sandbox needs privileges the container doesn't have, and /dev/shm is tiny
        ...(platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
        `--user-data-dir=${path.join(dir, 'profile')}`,
        `--print-to-pdf=${pdfPath}`,
        pathToFileURL(htmlPath).href,
      ];
      await new Promise((resolve, reject) => {
        run(chromePath, args, { timeout: timeoutMs, windowsHide: true }, err => (err ? reject(err) : resolve()));
      });
      const pdf = await fs.promises.readFile(pdfPath).catch(() => null);
      if (!pdf || pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('Chrome produced no PDF');
      return pdf;
    } finally {
      // Our own temp folder only (holds the letter HTML, which has PII)
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return function renderPdf(html) {
    const result = chain.then(() => renderOnce(html));
    chain = result.catch(() => {});
    return result;
  };
}

// Number of pages in a PDF (counts page objects; good enough for Chrome output)
const countPdfPages = buf => (buf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) || []).length;

module.exports = { createPdfRenderer, findChrome, countPdfPages, lockDown };
