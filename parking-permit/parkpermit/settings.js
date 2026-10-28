// settings.js — the permit app's settings (data/settings.json), edited from the admin page.
//
// get() re-reads the file whenever it changes on disk, so getters like () => settings.get().x always
// see the current value and admin edits apply without a restart.
// save(input) validates, merges into the current settings and writes atomically.
// logo_path / map_path are never taken from input: only the upload handler sets them (setImage).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { MAX_TIMEOUT_HOURS } = require('./approvalDb');

const DEFAULT_LETTERHEAD = Object.freeze({
  org_name: '', address: '', phone: '', email: '', logo_path: '', map_path: '',
  title: 'Building Parking Permit', terms: [], footer: '',
});
const DEFAULTS = Object.freeze({
  admin_group_id: '',
  approval_timeout_hours: 36,
  max_requests_per_day: 5,
  admin_approvers: [],
  letterhead: DEFAULT_LETTERHEAD,
});

const TEXT_LIMITS = { org_name: 150, address: 500, phone: 50, email: 150, title: 100, footer: 300 };
const MAX_TERMS = 15, MAX_TERM = 300, MAX_APPROVERS = 50;

// "012-345 6789" → "60123456789" (local Malaysian numbers get the 60 prefix)
function normalizeNumber(n) {
  const d = String(n ?? '').replace(/\D/g, '');
  return d.startsWith('0') ? `6${d}` : d;
}

function normalizeLid(l) {
  const d = String(l ?? '').trim().replace(/@lid$/i, '');
  return d ? (/^\d{5,20}$/.test(d) ? `${d}@lid` : null) : '';
}

const toLines = v => (Array.isArray(v) ? v : String(v ?? '').split(/\r?\n/))
  .map(s => String(s ?? '').trim()).filter(Boolean);

// Returns { errors: [], value: {...partial, normalised} } for the keys present in input
function validate(input = {}) {
  const errors = [];
  const value = {};

  if ('admin_group_id' in input) {
    const g = String(input.admin_group_id ?? '').trim();
    if (g && !/^[\d-]+@g\.us$/.test(g)) errors.push('Admin group ID must look like 120363…@g.us');
    else value.admin_group_id = g;
  }

  if ('approval_timeout_hours' in input) {
    const h = Number(input.approval_timeout_hours);
    if (!Number.isInteger(h) || h < 1 || h > MAX_TIMEOUT_HOURS) errors.push(`Approval timeout must be a whole number of hours from 1 to ${MAX_TIMEOUT_HOURS}`);
    else value.approval_timeout_hours = h;
  }

  if ('max_requests_per_day' in input) {
    const n = Number(input.max_requests_per_day);
    if (!Number.isInteger(n) || n < 1 || n > 50) errors.push('Requests per applicant per day must be a whole number from 1 to 50');
    else value.max_requests_per_day = n;
  }

  if ('admin_approvers' in input) {
    const list = input.admin_approvers;
    if (!Array.isArray(list)) errors.push('Approvers must be a list');
    else if (list.length > MAX_APPROVERS) errors.push(`At most ${MAX_APPROVERS} approvers`);
    else {
      const out = [];
      list.forEach((a, i) => {
        const name = String(a?.name ?? '').replace(/\s+/g, ' ').trim();
        const number = normalizeNumber(a?.number);
        const lid = normalizeLid(a?.lid);
        const row = `Approver ${i + 1}`;
        if (!name) errors.push(`${row}: name is required`);
        else if (name.length > 100) errors.push(`${row}: name is too long`);
        if (number && !/^\d{8,15}$/.test(number)) errors.push(`${row}: number should be 8–15 digits, e.g. 60123456789`);
        if (lid === null) errors.push(`${row}: LID should be digits, e.g. 123456789012345@lid`);
        if (!number && !lid) errors.push(`${row}: give a phone number or a LID`);
        out.push({ name, number, ...(lid ? { lid } : {}) });
      });
      value.admin_approvers = out;
    }
  }

  if ('letterhead' in input) {
    const lh = input.letterhead || {};
    const out = {};
    for (const [key, max] of Object.entries(TEXT_LIMITS)) {
      if (!(key in lh)) continue;
      const v = String(lh[key] ?? '').trim();
      if (v.length > max) errors.push(`Letterhead ${key.replace('_', ' ')} is too long (max ${max} characters)`);
      else out[key] = v;
    }
    if ('terms' in lh) {
      const terms = toLines(lh.terms);
      if (terms.length > MAX_TERMS) errors.push(`At most ${MAX_TERMS} conditions`);
      else if (terms.some(t => t.length > MAX_TERM)) errors.push(`Each condition must be ${MAX_TERM} characters or fewer`);
      else out.terms = terms;
    }
    if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) errors.push('Letterhead email is not valid');
    value.letterhead = out;   // logo_path / map_path deliberately ignored
  }

  return { errors, value };
}

function createSettingsStore(file) {
  let cache = null, cacheMtime = -1;

  function read() {
    let stat;
    try { stat = fs.statSync(file); } catch { return structuredClone(DEFAULTS); }
    if (cache && stat.mtimeMs === cacheMtime) return cache;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache = { ...DEFAULTS, ...raw, letterhead: { ...DEFAULT_LETTERHEAD, ...(raw.letterhead || {}) } };
      cacheMtime = stat.mtimeMs;
    } catch (e) {
      // A broken file must not crash message handling; keep the last good copy (or defaults)
      console.error('[permit] settings.json unreadable, using last good settings:', e.message);
      if (!cache) cache = structuredClone(DEFAULTS);
    }
    return cache;
  }

  function write(next) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
    cache = null;   // re-read (and re-stat) on next get()
  }

  // A deep copy, so callers can't mutate the cache
  const get = () => structuredClone(read());

  function save(input) {
    const { errors, value } = validate(input);
    if (errors.length) return { ok: false, errors };
    const cur = read();
    const next = { ...cur, ...value, letterhead: { ...cur.letterhead, ...(value.letterhead || {}) } };
    write(next);
    return { ok: true, settings: get() };
  }

  // kind: 'logo' | 'map'; p: absolute path chosen by the server, or '' to clear
  function setImage(kind, p) {
    const key = { logo: 'logo_path', map: 'map_path' }[kind];
    if (!key) throw new Error(`unknown image kind ${kind}`);
    const cur = read();
    write({ ...cur, letterhead: { ...cur.letterhead, [key]: p || '' } });
    return get();
  }

  return { get, save, setImage };
}

module.exports = { createSettingsStore, validate, normalizeNumber, DEFAULTS };
