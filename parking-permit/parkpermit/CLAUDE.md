# Parking Permit Approval (standalone app)

A WhatsApp workflow for building parking permits, running as **its own app with its own WhatsApp
number**, separate from whatsabot (it only borrows whatsabot's installed packages):
1. The applicant DMs the bot `PERMIT` plus a template.
2. The bot posts a summary to the admin group, where any approver replies APPROVE or REJECT.
3. The bot sends the applicant a PDF approval letter, the rejection reason, or an expiry notice.
4. The applicant's PII is purged; a PII-free log is kept.

Status: built and tested locally (152 tests, incl. real Chrome PDF renders). Remaining: on-server
verification with a test group and test phone (`tasks/todo.md` → task 10). Read `tasks/lessons.md` first.

## Environment (landmines)
- Windows Server; whatsabot lives at `D:\whatsabot`, this app at `D:\whatsabot\parking-permit\parkpermit`.
- **The server has NO internet.** No `npm install`. `deps.js` loads packages already installed for whatsabot:
  `better-sqlite3` from `whatsabot/node_modules`; Baileys, express, jsonwebtoken, dotenv, qrcode, pino from
  `whatsabot/server/node_modules` (override with `WHATSABOT_SERVER_DIR`). Don't add a dependency that isn't there.
- WhatsApp library: **Baileys** (`@whiskeysockets/baileys` 6.7.x), not whatsapp-web.js. The permit modules were
  written against whatsapp-web.js shapes; `baileysAdapter.js` translates (see below).
- PDF: **Google Chrome** on the server, run headless from the CLI by `pdf.js` (`findChrome()`: `CHROME_PATH`, then
  the usual install paths, then Edge). No Puppeteer.
- Own WhatsApp number, own SQLite file (`data/permit.db`), own login folder (`data/auth`). Never point it at a
  whatsabot session folder: two processes on one WhatsApp login kick each other off (`connectionReplaced`).
- Docker (production): `Dockerfile` here + root `docker-compose.yml` → http://10.49.39.144:8059. Image has Chromium (`CHROME_PATH=/usr/bin/chromium`, Chrome runs with `--no-sandbox` on Linux), packages from this folder's own `package.json`/lock (`deps.js` falls back to whatsabot's only outside Docker), data in volume `/data`. See `../../DEPLOY.md`.
- Process (non-Docker): PM2 app `parking-permit` (`ecosystem.config.js`). Admin page on the LAN: `http://<server>:5100`.

## Files (flat folder; tests use `./` requires)
| File | Role |
|---|---|
| `server.js` | Entry point. `main()` wires everything; `createApp(deps)` is the admin API (testable without WhatsApp). |
| `connection.js` | One Baileys socket: auto-reconnect with back-off, QR pairing on demand (`pair()`), `unlink()`, `status()`. |
| `baileysAdapter.js` | Baileys ↔ whatsapp-web.js shapes: `wrapIncoming(msg)`, `sendText`, `sendFile`, `deleteMessage`, acks, `getChats`. |
| `permitWorkflow.js` | `createPermitWorkflow({client, db, getSettings, outDir, renderPdf})` → `{handleMessage, onReady, stop, runMaintenance, approvals, letters}`. |
| `settings.js` | `data/settings.json`: `get()` re-reads on change; `save(input)` validates + merges; `setImage(kind, path)`. |
| `limiter.js` | Sliding-window counter; used by `intake.js` for the daily cap (setting `max_requests_per_day`) and the 10-messages-a-minute flood guard. |
| `pdf.js` | `createPdfRenderer({chromePath})` → `renderPdf(html) → Buffer`; `findChrome()`; `countPdfPages()`. |
| `deps.js` | `load(name)`: normal require, else whatsabot's server `node_modules`. |
| `admin/` | Admin page: plain HTML/CSS/JS, no build step, no inline script/style (strict CSP). |
| `approvalDb.js` `intake.js` `adminGroup.js` `approvalListener.js` `letter.js` `delivery.js` `maintenance.js` | The workflow modules. Each file's header shows its wiring; `permitWorkflow.js` is the real wiring. |

## Baileys ↔ whatsapp-web.js mapping (baileysAdapter.js)
- Message ids are stored in whatsapp-web.js format `true_<remoteJid>_<keyId>`; `deleteMessage` parses it back
  into a Baileys key for "delete for everyone".
- Quote-replies: Baileys gives the quoted message's key id as `contextInfo.stanzaId`; the listener matches it
  via `findRefByGroupMsgKey` (LIKE on the key id).
- Acks: Baileys status ERROR 0 / PENDING 1 / SERVER_ACK 2 / … → ack −1 / 0 / 1 / …; `delivery.js` waits for ack ≥ 1.
  The adapter caches recent acks so an ack that arrives before anyone waits is not lost. No message store:
  `getMessageById` returns null, so the ack-timeout re-check never succeeds (the 5-min retry covers it).
- Group sender: `key.participant` (often `…@lid`); `getContact()` returns the phone from `participantPn`/`senderPn`,
  which is how approvers listed by phone number are recognised when WhatsApp hides them behind a LID.
- `connection.js` calls `getSocket()` fresh each time: Baileys makes a new socket on every reconnect.

## Request lifecycle
```
PENDING ──approve──▶ APPROVED ─┐
   │    ──reject───▶ REJECTED ─┼─▶ client notified (WhatsApp ack ≥ 1) ─▶ purged
   └──expires_at──▶ EXPIRED  ──┘       (or force-purge 7 days after decision)
```
- Ref numbers: `PP-0001`… Admins may type `1`, `0001`, `PP-0001` or `pp1` (`normalizeRef`).
- First admin wins via an atomic `UPDATE … WHERE status='PENDING' AND expires_at > now`.
- `expires_at` is fixed at creation; changing the timeout affects new requests only.
- Timestamps are ISO UTC in the db; display is Malaysia time (UTC+8, hard-coded).

## Settings (data/settings.json, edited on the admin page)
```json
{
  "admin_group_id": "120363…@g.us",
  "approval_timeout_hours": 36,
  "max_requests_per_day": 5,
  "admin_approvers": [{ "name": "Siti Aminah", "number": "60123456789", "lid": "optional…@lid" }],
  "letterhead": { "org_name": "", "address": "line1\nline2", "phone": "", "email": "",
                  "logo_path": "", "map_path": "", "title": "Building Parking Permit", "terms": ["…"], "footer": "" }
}
```
- Timeout 1–48 h (WhatsApp's delete-for-everyone window is ~2 days; the purge deletes the group summary).
- `logo_path` / `map_path` are set only by the upload handler (files saved as `data/letterhead/{logo,map}.{png,jpg,webp}`,
  type sniffed from bytes; logo ≤ 1 MB, map ≤ 3 MB). `settings.save()` ignores them in input.

## Config (.env next to server.js; see .env.example)
`PERMIT_ADMIN_USER`, `PERMIT_ADMIN_PASSWORD` (8+ chars, not a default), `PERMIT_JWT_SECRET` (32+ chars) — admin
login is refused until all are set. `PERMIT_HOST` (default 0.0.0.0), `PERMIT_PORT` (5100). Optional:
`CHROME_PATH`, `PERMIT_DATA_DIR`, `WHATSABOT_SERVER_DIR`. Login: 5 failures per IP in 15 min → 15 min lock.

## Commands (on the server)
```bat
cd /d D:\whatsabot\parking-permit\parkpermit
node --test                         :: whole suite (~3 s); real-Chrome tests run when Chrome is found
copy .env.example .env              :: then fill it in
pm2 start ecosystem.config.js && pm2 save
pm2 logs parking-permit --lines 100
```
Requires Node 20+ (`node --test` discovery).

## Rules for changes
- **No PII in logs, file names or group confirmations.** Log the ref no. only. Tests assert this.
- Never mark a request notified before WhatsApp's ack. Purge only after notification, or the 7-day force purge.
- Never purge the PII row while its PDF exists. Purge order: group message (best effort) → file (must succeed) → row.
- Every user/admin string in the letter HTML goes through `esc()`. `pdf.js` adds a CSP blocking scripts and all
  non-`data:` loads to every page it renders.
- `permitWorkflow` keeps `bot_state.last_online` (heartbeat 60 s, set on stop); on reconnect after ≥10 min it tells the admin group the outage length (no applicant details).
- `maintenance.runOnce()` order: expire → post → deliver → purge → stray-file sweep; steps isolated; no overlap.
- The admin API never returns `approval_requests` data or server file paths.
- Add a test for every behaviour change. After any letter layout change, render a real PDF (letter.test.js does,
  with a tall map) and confirm it is still **one A4 page** — and look at it.

## Known limits (accepted)
- The purge covers the server only; copies on the applicant's and admins' phones remain.
- A quote-reply may keep a quoted preview of the deleted summary on admins' phones; typing `APPROVE 0042` avoids it.
- A lost ack can cause a duplicate send to the applicant (preferred over a lost letter).
- A crash between posting the group summary and saving its ID causes a duplicate group post after restart.
- A very long justification or many long conditions can still push the letter to a second page.
