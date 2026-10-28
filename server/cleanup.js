const db = require('./db');
const fs = require('fs');
const path = require('path');

console.log('\n🧹 WA Messenger - Cleanup Tool\n');

const users = db.getUsers();
const allEntries = Object.entries(users);
console.log(`Found ${allEntries.length} total sessions`);

const seen = {};
const cleaned = {};
const removed = [];

for (const [sid, u] of allEntries) {
  // The scraper's owner row has no phone by design — keep it
  if (sid === db.SYSTEM_SESSION_ID) { cleaned[sid] = u; continue; }

  // Remove sessions with no valid phone
  if (!u.phone || u.phone === 'undefined' || u.phone === sid || u.phone === '+') {
    console.log(`🗑  Removing ghost session: ${sid} (phone: "${u.phone}")`);
    removed.push(sid);
    continue;
  }

  // Remove duplicate phone numbers — keep the one with most credits/sent
  if (seen[u.phone]) {
    const existing = cleaned[seen[u.phone]];
    const keepExisting = (existing.credits + existing.totalSent) >= (u.credits + u.totalSent);

    if (keepExisting) {
      console.log(`🗑  Removing duplicate: ${sid} (phone: ${u.phone}) — keeping ${seen[u.phone]}`);
      removed.push(sid);
    } else {
      console.log(`🗑  Removing duplicate: ${seen[u.phone]} (phone: ${u.phone}) — keeping ${sid}`);
      removed.push(seen[u.phone]);
      delete cleaned[seen[u.phone]];
      seen[u.phone] = sid;
      cleaned[sid] = u;
    }
  } else {
    seen[u.phone] = sid;
    cleaned[sid] = u;
  }
}

// Save cleaned users
db.saveUsers(cleaned);
console.log(`\n✅ Kept ${Object.keys(cleaned).length} sessions`);
console.log(`🗑  Removed ${removed.length} sessions\n`);

// Clean up orphaned session folders
const sessionsDir = path.join(__dirname, 'sessions');
if (fs.existsSync(sessionsDir)) {
  const folders = fs.readdirSync(sessionsDir);
  let foldersRemoved = 0;
  for (const folder of folders) {
    if (!cleaned[folder]) {
      const folderPath = path.join(sessionsDir, folder);
      try {
        fs.rmSync(folderPath, { recursive: true, force: true });
      } catch (e) {
        console.log(`⚠️  Could not delete folder ${folder}: ${e.code} — delete manually if needed`);
      }
      console.log(`🗂  Removed orphaned session folder: ${folder}`);
      foldersRemoved++;
    }
  }
  if (foldersRemoved === 0) console.log('🗂  No orphaned folders found');
}

console.log('\n✨ Cleanup complete! Restart your server.\n');
