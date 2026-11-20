# Wedding invites PWA

Static, no build step, no backend. Serve over HTTPS (camera + service worker need it) or localhost:

    npx serve .        # or: python3 -m http.server 8080

Deploy to any static host (GitHub Pages, Netlify, Cloudflare Pages).

## How it works
- QR payload: `W1.<guestId>.<seats>.<sig>`, sig = first 80 bits of HMAC-SHA256(secret, eventId|guestId|seats), Crockford base32.
- Verification is offline on any device that holds the event secret (the full JSON export). Forged or edited seat counts fail.
- Guest invite link: `<url>#i=<base64url JSON>` (names, venue, guest, token). The secret is never in it. The hash never reaches a server.
- State: IndexedDB. Check-ins are monotonic per guest, so merging two scanner devices = union of guests, max of seats-in.
- QR encoding: Kazuhiko Arase's qrcode-generator (MIT). Decoding: jsQR (Apache-2.0). Both bundled, no CDN.

## Known limits
- No shared live state between scanner phones. Sync is export/merge of JSON.
- Anyone holding the secret can mint codes. Anyone with a guest's code can use it once per seat count, so a screenshot shared by the guest works (same as any bearer ticket).
- Changing a guest's seats means a new token (old one still verifies for the old seat count). Delete and re-add.
- Bump `VERSION` in sw.js on each deploy.
