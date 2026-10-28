const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

// Feed/callback settings are read on every run, so a URL changed from the admin page takes effect
const CONTACTS_PATH = path.join(__dirname, 'data', 'local_contacts.csv');

// ─── Load local_contacts.csv → { name_lowercase: number } ────────

function loadContacts() {
  if (!fs.existsSync(CONTACTS_PATH)) return {};
  const csv = fs.readFileSync(CONTACTS_PATH, 'utf8');
  const lines = csv.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map(h => h.trim().replace(/^\uFEFF/, '').toLowerCase());
  const nameIdx = headers.indexOf('name');
  const numberIdx = headers.indexOf('number');
  if (nameIdx === -1 || numberIdx === -1) return {};

  const map = {};
  lines.slice(1).forEach(line => {
    const vals = line.split(',').map(v => v.trim());
    const name = vals[nameIdx];
    const number = vals[numberIdx];
    if (name && number) map[name.toLowerCase()] = number;
  });
  return map;
}

// ─── Main scrape function ─────────────────────────────────────────

async function runScraper() {
  const FEED_URL = process.env.SCRAPER_FEED_URL;
  const CALLBACK_URL = process.env.SCRAPER_CALLBACK_URL;
  const CALLBACK_KEY = process.env.SCRAPER_CALLBACK_KEY;
  const result = {
    imported: 0,
    skipped_duplicate: 0,
    skipped_no_contact: 0,
    skipped_no_schedule: 0,
    errors: [],
    callback_status: null,
  };

  if (!FEED_URL) {
    result.errors.push('SCRAPER_FEED_URL not set in .env');
    return result;
  }

  // ── Step 1: Fetch feed page ──────────────────────────────────────
  let html;
  try {
    const response = await axios.get(FEED_URL, { timeout: 15000 });
    html = response.data;
  } catch (e) {
    result.errors.push(`Feed unreachable: ${e.message}`);
    return result;
  }

  // ── Step 2: Parse table#wssched-feed ────────────────────────────
  const $ = cheerio.load(html);
  const rows = $('#wssched-feed tbody tr');

  if (rows.length === 0) {
    result.errors.push('Feed table found but no rows — nothing to import');
    return result;
  }

  // ── Step 3: Load contacts ────────────────────────────────────────
  const contacts = loadContacts();

  // ── Step 4: Process each row ─────────────────────────────────────
  const toImport = [];

  rows.each((_, row) => {
    const $row = $(row);
    const externalId = $row.attr('data-msgid');
    const toUsername = $row.find('.to_username').text().trim();
    const message = $row.find('.message').text().trim(); // cheerio auto-decodes HTML entities
    const scheduledAt = $row.find('.scheduledAt').text().trim();
    const status = $row.find('.msg_status').text().trim();

    // Only process pending rows
    if (status !== 'pending') return;

    // Check duplicate — already imported
    const existing = db.getScheduleByExternalId(externalId);
    if (existing) {
      result.skipped_duplicate++;
      return;
    }

    // Match username → phone number
    const phone = contacts[toUsername.toLowerCase()];
    if (!phone) {
      result.skipped_no_contact++;
      console.log(`⚠️ Scraper: no contact match for "${toUsername}"`);
      return;
    }

    // Parse scheduledAt — handle Oracle timestamp format with fractional seconds
    // e.g. "2026-04-03 09:13:39.0"
    const cleanScheduledAt = scheduledAt.replace(/\.\d+$/, ''); // strip fractional seconds
    const scheduledDate = new Date(cleanScheduledAt);
    if (isNaN(scheduledDate.getTime())) {
      result.errors.push(`Invalid scheduledAt for msg_id ${externalId}: "${scheduledAt}"`);
      return;
    }

    toImport.push({
      id: uuidv4(),
      sessionId: db.SYSTEM_SESSION_ID,
      to: phone,
      message,
      scheduledAt: scheduledDate.toISOString(),
      repeat: 'once',
      status: 'pending',
      createdAt: new Date().toISOString(),
      external_id: externalId,
    });
  });

  // ── Step 5: Insert into schedules ────────────────────────────────
  for (const s of toImport) {
    try {
      db.insertSchedule(s);
      result.imported++;
      console.log(`✅ Scraper: imported msg_id ${s.external_id} → ${s.to}`);
    } catch (e) {
      result.errors.push(`Insert failed for external_id ${s.external_id}: ${e.message}`);
    }
  }

  // ── Step 6: Callback to mark as Fetched ─────────────────────────
  // The callback marks the WHOLE feed fetched (it takes no msg ids), so only call it when every
  // pending row is safely stored here. If a row was skipped (no contact match, bad date, insert
  // error) the callback is withheld so the row stays in the feed; rows already imported are
  // skipped as duplicates on the next run via external_id.
  const stored = result.imported + result.skipped_duplicate;
  const unsafe = result.skipped_no_contact + result.errors.length;
  if (unsafe > 0) {
    result.callback_status = {
      status: 'withheld',
      message: `${unsafe} row(s) not imported — fix contacts/data and run again; feed not marked fetched`,
    };
  } else if (stored > 0 && !CALLBACK_URL) {
    result.callback_status = { status: 'skipped', message: 'SCRAPER_CALLBACK_URL not set' };
  } else if (stored > 0) {
    try {
      const cbUrl = `${CALLBACK_URL}?key=${encodeURIComponent(CALLBACK_KEY || '')}`;
      const cbResponse = await axios.get(cbUrl, { timeout: 10000 });
      const cbData = cbResponse.data;
      result.callback_status = typeof cbData === 'object' ? cbData : { raw: cbData };
      console.log(`📤 Scraper callback: ${JSON.stringify(result.callback_status)}`);
    } catch (e) {
      result.errors.push(`Callback failed: ${e.message}`);
      result.callback_status = { status: 'error', message: e.message };
    }
  } else {
    result.callback_status = { status: 'skipped', message: 'Nothing imported, callback not called' };
  }

  return result;
}

module.exports = { runScraper };
