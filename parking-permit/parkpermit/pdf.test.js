// Run: node --test pdf.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPdfRenderer, lockDown } = require('./pdf');

// Fake execFile: records the Chrome arguments and writes a PDF where --print-to-pdf points
function fakeRun(calls) {
  return (bin, args, opts, cb) => {
    calls.push({ bin, args });
    const out = args.find(a => a.startsWith('--print-to-pdf=')).slice('--print-to-pdf='.length);
    require('node:fs').writeFileSync(out, '%PDF-1.4 fake');
    cb(null);
  };
}

test('Linux (container): Chrome runs with --no-sandbox and --disable-dev-shm-usage', async () => {
  const calls = [];
  await createPdfRenderer({ chromePath: '/usr/bin/chromium', run: fakeRun(calls), platform: 'linux' })('<p>x</p>');
  assert.equal(calls[0].bin, '/usr/bin/chromium');
  assert.ok(calls[0].args.includes('--no-sandbox') && calls[0].args.includes('--disable-dev-shm-usage'));
  assert.ok(calls[0].args.includes('--headless=new'));
});

test('Windows: Chrome keeps its sandbox', async () => {
  const calls = [];
  await createPdfRenderer({ chromePath: 'chrome.exe', run: fakeRun(calls), platform: 'win32' })('<p>x</p>');
  assert.ok(!calls[0].args.includes('--no-sandbox'));
});

test('no Chrome found gives a clear error', async () => {
  await assert.rejects(createPdfRenderer({ chromePath: null })('<p>x</p>'), /Chrome not found/);
});

test('lockDown puts the CSP first in <head>, or wraps a fragment', () => {
  assert.match(lockDown('<html><head><title>t</title></head></html>'), /<head><meta http-equiv="Content-Security-Policy"/);
  assert.match(lockDown('<p>frag</p>'), /^<!doctype html><html><head>.*Content-Security-Policy.*<\/head><body><p>frag<\/p><\/body><\/html>$/s);
});
