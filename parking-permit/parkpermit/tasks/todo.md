# Whatsabot – Building Parking Permit Approval (WhatsApp)

## Decisions
- **Runtime (revised 2026-10-28):** a **standalone app** with its **own WhatsApp number**, not part of whatsabot. Production whatsabot runs **Baileys**, so this does too (`baileysAdapter.js` maps the whatsapp-web.js shapes the modules were written for). No send queue. Own admin page on the office LAN with its own login. PDFs via the server's **Google Chrome** (headless CLI). Packages are borrowed from whatsabot's `node_modules` (no internet).
- ~~Library: whatsapp-web.js, reusing the existing whatsabot session~~ (superseded above)
- **Approval timeout:** 36h default, editable on the permit admin page (stored in data/settings.json)
- **Privacy:** PII is purged once a request is finished and delivered. A PII-free request log is kept permanently.

## Data model (SQLite, better-sqlite3)
Two tables, so a purge is a clean row delete instead of nulling columns.

**`approval_requests`** holds PII and is deleted after the request finishes
| column | notes |
|---|---|
| ref_no (PK) | e.g. PP-0042 |
| client_jid | client WhatsApp ID |
| applicant_name, car_reg, justification | submitted details |
| remark | approver's remark (printed on the letter) |
| reject_reason | free text, may contain PII |
| group_msg_id | bot's summary message in the admin group |
| pdf_path | server copy of the letter |

**`approval_log`** has no PII, is kept permanently, and is the single source of truth for status
| column | notes |
|---|---|
| ref_no | links to the purged request |
| request_type | `PARKING_PERMIT` |
| status | PENDING / APPROVED / REJECTED / EXPIRED |
| permit_start, permit_end | dates only (no PII) |
| approver_name | taken from the admin whitelist, not the phone number |
| created_at, expires_at, decided_at, client_notified_at, purged_at | audit timestamps (ISO UTC) |

**Timeout setting:** stays in the existing settings JSON. The caller passes it to `createRequest()`; it is validated 1–48h and fixed into `expires_at` at creation, so changing the setting affects new requests only.

## Tasks
- [x] 1. **Schema and data layer.** `approvalDb.js` is a standalone module that takes the existing better-sqlite3 instance, so existing db exports are untouched. 11 tests pass (`node --test approvalDb.test.js`).
- [x] 2. **Intake.** `intake.js` handles client DMs that start with `PERMIT`. 17 tests in `intake.test.js`.
  - Labels are case-insensitive and tolerate WhatsApp bold; alternatives like `Reason:` and `Car Reg No:` are accepted.
  - Dates are DD/MM/YYYY. The start can't be in the past (Malaysia time), the end must be on or after the start, and the period is capped at 365 days.
  - Car reg is stored as `WXY1234` and shown as `WXY 1234`.
  - All errors are listed at once, and the template is sent as a separate message so the client can copy it.
  - A repeat submission for the same client and car while one is pending returns the existing ref instead of creating a new request.
  - Logs carry the ref no. only, never PII.
- [x] 3. **Group post.** `adminGroup.js` posts the summary with APPROVE / REJECT instructions and the expiry time (Malaysia time), then stores `group_msg_id`. 11 tests in `adminGroup.test.js`, including an end-to-end check from client DM to group post.
  - The group ID is read from the `admin_group_id` setting each time, so it can change without a restart.
  - If the setting is empty or wrong, requests queue up and a warning is logged once. On startup, `logGroups()` prints every group the bot is in so the ID can be copied.
  - `postUnposted()` runs on startup and every 5 minutes, posting any queued or failed requests oldest first.
  - Requests that are decided or expired are never posted, and each request is posted at most once.
  - **Known edge case:** if the bot crashes after posting but before saving the message ID, the request is posted again after the restart. This is rare and harmless.
  - New db helper: `listUnposted()`.
- [x] 4. **Approval listener.** `approvalListener.js` handles commands in the admin group. 21 tests in `approvalListener.test.js`.
  - Commands: quote-reply `APPROVE [remark]` / `REJECT reason`, or typed `APPROVE 0042 [remark]` / `REJECT 0042 reason`. They are case-insensitive and tolerate WhatsApp bold.
  - Normal chat is ignored, e.g. "Approved, thanks".
  - Approvers come from the `admin_approvers` setting: `[{ "number": "60123456789", "name": "Siti Aminah" }]`. Local numbers like `012-345 6789` get the 60 prefix.
  - Approvers are matched by phone number, by device-suffixed IDs, by `lid` (WhatsApp's hidden member ID), or via the contact's number. A non-approver is refused and their ID is logged so it can be added.
  - Quote-replies are matched by the full message ID, falling back to the message key, since ID formats vary across whatsapp-web.js versions.
  - Replying to one request while typing the number of another real request is refused as ambiguous. A remark starting with a number, like "2 cars max", still works.
  - A reject reason is required. Remarks are limited to 300 characters and reasons to 500.
  - First admin wins; later admins are told who decided. Expired requests are refused even before the expiry sweep has run.
  - Group confirmations contain only the ref no. and approver name, no applicant details.
  - New db helper: `findRefByGroupMsgKey()`.
- [x] 5. **PDF.** `letter.js` renders an A4 approval letter with Puppeteer, reusing whatsapp-web.js's own browser (`client.pupBrowser`), so nothing new is installed or launched. 12 tests in `letter.test.js`, including a real Chromium render checked visually.
  - The letterhead comes from the `letterhead` setting (org name, address, phone, email, logo, title, conditions, footer). Blank fields print as orange `[placeholders]`; the admin page fields come in task 9.
  - The logo must be PNG, JPG or WEBP, up to 1 MB. It is embedded in the PDF, and an unusable file is skipped with a warning.
  - Security: all typed text is HTML-escaped, and the render page runs no JavaScript and blocks all network and file loads.
  - Saved as `<outDir>/PP-0042.pdf` (no PII in the file name) via a temp file and rename, so a failed render leaves nothing behind. A retry reuses the existing file.
  - **Parking lot map:** shown full width from the `letterhead.map_path` setting (PNG, JPG or WEBP, up to 3 MB). It is capped at 100mm tall, so taller maps shrink and are centred. When unset, an orange dashed placeholder box appears.
  - To keep the letter on one A4 page with a map, the validity rows are merged into one "Valid Period" row and spacing is tighter. Verified with a wide map, a tall map and the placeholder. A very long justification could still push the map onto page 2.
- [x] 6. **Delivery.** `delivery.js` notifies the applicant of every outcome. 16 tests in `delivery.test.js`.
  - Approved: the PDF letter is sent as a document with a caption. Rejected: the reason is sent. Expired: the applicant is asked to resubmit.
  - A request is marked notified only after WhatsApp's server confirms the message (`createAckWaiter`). On a 60s timeout, the bot re-checks the message state before giving up.
  - Failures (no connection, no confirmation, letter render error) are retried by `deliverOutstanding()`, which runs on startup and every 5 minutes. After 3 failed attempts the admin group is warned once.
  - Group notes carry the ref no. only, and logs never contain PII. Each request is delivered at most once, even when the approval hook and the sweep overlap.
  - **Known edge case:** if WhatsApp delivers a message but its confirmation is lost, the retry sends it again, so the applicant could receive it twice. This is preferable to the applicant never receiving it.
  - New db helper: `listUndelivered()`.
- [x] 7 + 8. **Expiry and PII purge.** `maintenance.js` runs one job when WhatsApp is ready (catching up after downtime) and then every 5 minutes. 13 tests in `maintenance.test.js`.
  - Each run: expire overdue requests → post queued group summaries → deliver outstanding outcomes → purge → sweep stray letter files.
  - Each step is isolated, so one failure doesn't stop the rest, and overlapping runs are skipped.
  - Purge happens only after the applicant is notified, or 7 days after the decision. For each request:
    1. Delete the group summary "for everyone" (best effort).
    2. Delete the letter file. If that fails, purge waits and retries, because the file holds PII.
    3. Delete the PII row and set `purged_at` in one transaction.
  - Stray `PP-*.pdf` and `.tmp` files whose request is purged or unknown are removed. Other files in the folder are left alone.
- [x] **End-to-end check.** `e2e.test.js` wires every real module as in `whatsapp.js` against a fake WhatsApp client, and covers the approve, reject and expire paths plus "group ID set later".
  - After purge, every table in the database and the letters folder is scanned for the applicant's name, car reg, phone number, justification, remark and reason: none remain.
  - The bot's remaining group messages contain no applicant details.
- [x] **Standalone app + wiring (2026-10-28).** Installed library is Baileys 6.7.21, not whatsapp-web.js, so the plan changed from "3 lines in whatsapp.js" to a separate app.
  - [x] `deps.js` (borrow packages), `connection.js` (one number, reconnect with back-off, QR pairing on demand), `baileysAdapter.js` (+9 tests), `permitWorkflow.js` (+5 tests through the adapter with a fake Baileys socket, incl. @lid approver matched via `participantPn`, ack-gated delivery, delete-for-everyone key).
  - [x] `settings.js`: read fresh on change, validated save, image paths only via upload (+5 tests).
  - [x] `pdf.js`: headless Chrome CLI replaces Puppeteer in `letter.js`. Each page gets a CSP blocking scripts and non-`data:` loads (Chrome's `--blink-settings=scriptEnabled=false` stops `--print-to-pdf` from writing anything). Real-render tests: one A4 page with a tall map; scripts don't run.
  - [x] Layout fix: a map at the cap plus 4 conditions overflowed to page 2 → map cap 100mm → 85mm, tighter footer. Checked visually.
- [x] 9. **Admin page.** `server.js` (`createApp`) + `admin/` (plain HTML/JS, no build). Own login (`.env`), 5-failure lockout, strict CSP. (+8 tests)
  - [x] Status: WhatsApp state, QR pairing, unlink, readiness checklist.
  - [x] Settings form with server-side validation: timeout (1–48), group ID (with picker from the bot's groups), approvers, letterhead fields.
  - [x] Logo and map upload to `data/letterhead/` (type from magic bytes, size limits, server-chosen file name).
  - [x] Preview letter (sample data + unsaved form letterhead, no db writes).
  - [x] Request log from `approval_log` only (`listLog()` + test).
- [ ] 10. **On-server verification.** Run with a test admin group and a test phone number before going live.
  - [ ] Copy `parkpermit/` to the server; `.env` from `.env.example`; `node --test` passes (real-Chrome tests run if Chrome is found).
  - [ ] `pm2 start ecosystem.config.js`; the admin page opens from another PC on the LAN; sign in; Status shows "Chrome found".
  - [ ] Link WhatsApp from the admin page with the bot's own number. Restart the process: it reconnects without a QR.
  - [ ] Startup with no `admin_group_id`: group IDs are printed in `pm2 logs` (and the picker lists them). Set the ID; the queued request is posted within 5 minutes.
  - [ ] Bare `PERMIT` returns the help and template. An invalid template returns the errors and template. A valid one returns the ref, and the summary appears in the group.
  - [ ] Each approver sends one test `APPROVE`. If anyone is refused, add the `@lid` shown in the log to their approver entry.
  - [ ] Quote-reply `APPROVE Bay B2` delivers the PDF to the test phone. Open it and check the letterhead, map and one page.
  - [ ] Typed `REJECT 0002 reason` delivers the reason to the client.
  - [ ] Two admins approve the same request: the second is told who decided.
  - [ ] A non-approver tries to approve: refused.
  - [ ] Expiry: set the timeout to 1h, wait, and confirm the client and group are notified.
  - [ ] Expiry during downtime: stop the bot past the expiry time, start it, and confirm the expiry is handled on startup.
  - [ ] Restart while a request is pending: it can still be approved after the restart.
  - [ ] Delivery failure: briefly disconnect, approve, reconnect, and confirm the letter arrives within 5 minutes.
  - [ ] After purge: `approval_requests` is empty for that ref, the letters folder has no file, and the group summary shows as deleted.
  - [ ] `pm2 logs` contains no client name, car reg or phone number.

## Known limits
- The purge covers the **server only**. Copies on the client's and admins' phones are out of the bot's control.
- When admins quote-reply to a summary, WhatsApp may keep a quoted preview of it inside their reply, even after the bot deletes the original. Typing `APPROVE 0042` instead of quote-replying avoids this.
- WhatsApp only allows "delete for everyone" for roughly 2 days, so the timeout setting is capped at 48h (enforced in `createRequest`).
- A lost ack can cause a duplicate send to the client (preferred over a lost letter). A crash between posting the group summary and saving its ID causes a duplicate group post.
- A very long justification (500 characters) or many long conditions can still push the letter onto page 2 (map is capped at 85mm).

## Answered
1. **Intake:** fixed text template, starting with the keyword `PERMIT`
2. **Purge:** all finished requests (approved, rejected, expired), once the client has been notified. If notifying the client keeps failing, they are force-purged 7 days after the decision.
3. **Request fields:** name, car registration no., start date, end date, justification
   **Letter adds:** approver name and the remark (`APPROVE 0042 <remark>`, remark optional)

## Review
- **Modules 1–8:** built and tested off-server (Node 22, better-sqlite3, real Chromium for PDF): 109 tests passing, including an end-to-end flow with a PII scan after purge.
- **Standalone app (2026-10-28):** 139 tests passing in ~3 s (Node 25, Windows, real Chrome). Ran locally: admin page signs in, shows status and settings, renders a real preview PDF.
- **Not yet verified with a live WhatsApp session.** The Baileys behaviours relied on (participantPn on @lid senders, messages.update acks, delete-for-everyone, document send) are covered by fakes only; confirm on the server (task 10).
