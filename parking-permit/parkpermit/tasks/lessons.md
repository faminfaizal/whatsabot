# Lessons: parking permit module

Rules learned while building modules 1–8. Review at the start of each session.

1. **Assert specific strings, not whole classes of output.** Twice, a test asserted "no placeholder anywhere" and failed on a placeholder that was correct for that input (an unset map or terms). Assert the exact placeholders that must be absent.
2. **Content tests don't catch layout overflow.** Adding the parking map silently pushed the letter to 2 pages while every HTML test still passed. After any letter change, render a real PDF, check the page count, and look at it.
3. **Every reply format can collide with free text.** A quote-reply remark like "2 cars max" looked like a request number. Treat a typed number as a conflicting ref only if that request actually exists, and test remarks that start with digits.
4. **Two triggers for the same work need an in-flight guard.** The approval hook and the 5-minute sweep can both reach `postRequest` / `deliver` at once. Keep the `inFlight` sets, and keep the "only once" tests.
5. **Never `rm` with a shell variable path.** Write to fresh folders, or use `"${VAR:?}"`. In code, delete only exact files the module created (`PP-*.pdf`, `.tmp`).
6. **Don't trust one WhatsApp ID format.** Serialized message IDs, `@c.us` and `@lid` vary across whatsapp-web.js versions. Match with fallbacks, and log the unrecognised ID so a human can fix the config.
7. **No PII in logs is a tested rule, not a convention.** When adding a log line, add or extend the test that scans logs for the applicant's name, car reg and phone number.
8. **A real render beats a placeholder test image.** A 1px PNG never reaches the map's height cap, so the "worst case" test passed while a real tall map plus four conditions overflowed to page 2. Generate test images at realistic sizes.
9. **Check a CLI flag does what it claims before relying on it.** Chrome's `--blink-settings=scriptEnabled=false` silently stops `--print-to-pdf` from writing a file. Script blocking is done with a CSP that `pdf.js` adds to every page instead; a test proves a script can't add pages.
10. **Never leave a long timer pending in a test.** One un-acked delivery left the 60 s ack wait running and made the whole suite take 60 s. Finish the scenario (send the ack) instead.
