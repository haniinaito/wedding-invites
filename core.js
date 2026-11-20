// Pure logic: ids, signed tokens, invite links, merge. No DOM.
const enc = new TextEncoder();
const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

export function b32(bytes) {
  let bits = 0, val = 0, out = '';
  for (const b of bytes) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHA[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += ALPHA[(val << (5 - bits)) & 31];
  return out;
}
export function rid(n = 6) {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return Array.from(a, x => ALPHA[x & 31]).join('');
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return b32(new Uint8Array(sig).slice(0, 10)); // 80 bits, 16 chars
}

// token = W1.<guestId>.<seats>.<sig>; sig = HMAC(secret, eventId|guestId|seats)
export async function makeToken(event, guest) {
  const sig = await hmac(event.secret, `${event.id}|${guest.id}|${guest.seats}`);
  return `W1.${guest.id}.${guest.seats}.${sig}`;
}

export async function verifyToken(event, raw) {
  const m = /^W1\.([0-9A-Z]{4,12})\.(\d{1,3})\.([0-9A-Z]{16})$/.exec(String(raw).trim().toUpperCase());
  if (!m) return { ok: false, reason: 'format' };
  const [, id, seats, sig] = m;
  const want = await hmac(event.secret, `${event.id}|${id}|${Number(seats)}`);
  let diff = 0; for (let i = 0; i < 16; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? { ok: true, id, seats: Number(seats) } : { ok: false, reason: 'signature' };
}

const b64u = {
  enc: s => btoa(String.fromCharCode(...enc.encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: s => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/')); return new TextDecoder().decode(Uint8Array.from(b, c => c.charCodeAt(0))); },
};

// The invite link carries everything the guest page needs. The secret is never in it.
export function inviteHash(event, guest, token) {
  return '#i=' + b64u.enc(JSON.stringify({
    e: { n: event.names, d: event.date, v: event.venue, m: event.map || '', x: event.note || '' },
    g: { n: guest.name, s: guest.seats, t: guest.table || '' }, k: token,
  }));
}
export function parseInvite(hash) {
  const m = /^#i=([\w-]+)$/.exec(hash); if (!m) return null;
  try { const o = JSON.parse(b64u.dec(m[1])); return o && o.e && o.g && o.k ? o : null; } catch { return null; }
}

// Merge another device's export into ours. Check-ins only ever grow.
export function mergeState(a, b) {
  if (a.event.id !== b.event.id) throw new Error('event-mismatch');
  const guests = new Map(a.guests.map(g => [g.id, g]));
  for (const g of b.guests) if (!guests.has(g.id)) guests.set(g.id, g);
  const checkins = { ...a.checkins };
  for (const [id, c] of Object.entries(b.checkins || {})) {
    const cur = checkins[id];
    checkins[id] = !cur ? c : { n: Math.max(cur.n, c.n), at: Math.min(cur.at, c.at) };
  }
  return { ...a, guests: [...guests.values()], checkins };
}

export function parseBulk(text) {
  return text.split(/\n/).map(l => l.trim()).filter(Boolean).map(l => {
    const [name, seats, table] = l.split(/[,،\t]/).map(s => s.trim());
    const n = parseInt(seats, 10);
    return { name, seats: n > 0 && n < 100 ? n : 1, table: table || '' };
  }).filter(g => g.name);
}

export function toCSV(state) {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['name', 'seats', 'table', 'phone', 'checked_in', 'at']];
  for (const g of state.guests) {
    const c = state.checkins[g.id];
    rows.push([g.name, g.seats, g.table, g.phone, c ? c.n : 0, c ? new Date(c.at).toISOString() : '']);
  }
  return '\ufeff' + rows.map(r => r.map(q).join(',')).join('\n');
}
