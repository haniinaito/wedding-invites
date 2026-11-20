import { qrModules } from './qr.js';
import { rid, makeToken, verifyToken, inviteHash, parseInvite, mergeState, parseBulk, toCSV } from './core.js';

/* ---------- storage (IndexedDB, one record) ---------- */
const DB = () => new Promise((res, rej) => {
  const r = indexedDB.open('wedding-invites', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
async function load() {
  const db = await DB();
  return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get('state'); q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error); });
}
async function save() {
  const db = await DB();
  return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(JSON.parse(JSON.stringify(state)), 'state'); t.oncomplete = res; t.onerror = () => rej(t.error); });
}

/* ---------- helpers ---------- */
const $app = document.getElementById('app');
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v; else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
};
const nf = new Intl.NumberFormat('ar-EG');
const fmtDate = d => d ? new Intl.DateTimeFormat('ar-EG', { dateStyle: 'full', timeStyle: 'short' }).format(new Date(d)) : '';
const fmtTime = t => new Intl.DateTimeFormat('ar-EG', { timeStyle: 'short' }).format(new Date(t));
const toast = msg => { const t = h('div', { class: 'toast', role: 'status' }, msg); document.body.append(t); setTimeout(() => t.remove(), 2600); };

function qrSvg(text, px = 240) {
  const m = qrModules(text), n = m.length, q = 4;
  let d = '';
  m.forEach((row, y) => { let x = 0; while (x < n) { if (row[x]) { let w = 1; while (x + w < n && row[x + w]) w++; d += `M${x + q} ${y + q}h${w}v1h-${w}z`; x += w; } else x++; } });
  const s = n + q * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="QR"><rect width="${s}" height="${s}" fill="#fff"/><path d="${d}" fill="#251f21"/></svg>`;
}
const qrEl = (text, px) => { const w = h('div', { class: 'qr' }); w.innerHTML = qrSvg(text, px); return w; };

async function svgToPngBlob(svg, px = 768) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const img = new Image(); img.src = url; await img.decode();
  const c = h('canvas', { width: px, height: px }); const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false; ctx.drawImage(img, 0, 0, px, px); URL.revokeObjectURL(url);
  return new Promise(r => c.toBlob(r, 'image/png'));
}
function download(name, blob) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const baseUrl = () => location.href.split('#')[0];

/* ---------- state ---------- */
let state = null;           // { event, guests, checkins }
let tab = 'guests';
let query = '';
let stopScan = null;

const seatsTotal = () => state.guests.reduce((a, g) => a + g.seats, 0);
const seatsIn = () => Object.values(state.checkins).reduce((a, c) => a + c.n, 0);

/* ---------- routing ---------- */
function route() {
  if (stopScan) { stopScan(); stopScan = null; }
  const inv = parseInvite(location.hash);
  if (inv) return renderGuestPage(inv);
  if (!state) return renderSetup();
  const t = location.hash.replace('#/', '') || 'guests';
  tab = ['guests', 'scan', 'event'].includes(t) ? t : 'guests';
  renderShell();
}
addEventListener('hashchange', route);

/* ---------- guest-facing invitation ---------- */
function renderGuestPage(inv) {
  $app.replaceChildren(h('main', { class: 'guest' },
    h('div', { class: 'invite' },
      h('p', { class: 'kicker' }, 'بكل الحب ندعوكم لحضور فرح'),
      h('h1', {}, inv.e.n),
      h('p', { class: 'when' }, fmtDate(inv.e.d)),
      h('p', { class: 'where' }, inv.e.v),
      inv.e.m && /^https?:\/\//.test(inv.e.m) ? h('a', { class: 'btn ghost', href: inv.e.m, target: '_blank', rel: 'noopener' }, 'الموقع على الخريطة') : null,
      h('hr'),
      h('p', { class: 'kicker' }, 'الدعوة باسم'),
      h('h2', {}, inv.g.n),
      h('p', { class: 'meta' }, `${nf.format(inv.g.s)} ${inv.g.s === 1 ? 'فرد' : 'أفراد'}`, inv.g.t ? ` • ترابيزة ${inv.g.t}` : ''),
      qrEl(inv.k, 260),
      h('p', { class: 'hint' }, 'اعرض الكود ده عند الباب. الدعوة تقبل الدخول مرة واحدة لعدد الأفراد المكتوب.'),
      inv.e.x ? h('p', { class: 'note' }, inv.e.x) : null)));
}

/* ---------- first run ---------- */
function renderSetup() {
  const f = h('form', { class: 'card stack', onsubmit: async e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    state = { event: { id: rid(6), secret: rid(20), names: v.names.trim(), date: v.date, venue: v.venue.trim(), map: v.map.trim(), note: v.note.trim() }, guests: [], checkins: {} };
    await save(); navigator.storage?.persist?.(); location.hash = '#/guests'; route();
  } },
    h('h1', {}, 'ابدأ دعوات الفرح'),
    field('الأسماء', h('input', { name: 'names', required: true, placeholder: 'أحمد و سارة' })),
    field('الميعاد', h('input', { name: 'date', type: 'datetime-local', required: true })),
    field('المكان', h('input', { name: 'venue', required: true, placeholder: 'قاعة ... الإسكندرية' })),
    field('لينك الخريطة (اختياري)', h('input', { name: 'map', type: 'url', dir: 'ltr', placeholder: 'https://maps.app.goo.gl/...' })),
    field('ملحوظة للضيوف (اختياري)', h('input', { name: 'note', placeholder: 'الحضور بعد الساعة ٧' })),
    h('button', { class: 'btn', type: 'submit' }, 'إنشاء'),
    h('p', { class: 'hint' }, 'البيانات بتتخزن على الجهاز ده بس. مفيش سيرفر. لو هتمسح الدعوات من أكتر من موبايل استخدم التصدير والدمج من تبويب الحدث.'));
  const imp = h('label', { class: 'btn ghost' }, 'استيراد نسخة من جهاز تاني', h('input', { type: 'file', accept: 'application/json', hidden: true, onchange: async e => {
    try { state = JSON.parse(await e.target.files[0].text()); if (!state.event?.secret) throw 0; await save(); route(); } catch { state = null; toast('الملف مش صالح'); }
  } }));
  $app.replaceChildren(h('main', { class: 'wrap' }, f, imp));
}
const field = (label, input) => h('label', { class: 'field' }, h('span', {}, label), input);

/* ---------- shell ---------- */
function renderShell() {
  const nav = h('nav', { class: 'tabs' }, ...[['guests', 'الضيوف'], ['scan', 'مسح'], ['event', 'الحدث']].map(([k, l]) =>
    h('a', { href: '#/' + k, class: k === tab ? 'on' : '', 'aria-current': k === tab ? 'page' : null }, l)));
  const body = h('main', { class: 'wrap' });
  $app.replaceChildren(h('header', { class: 'top' }, h('b', {}, state.event.names), h('span', {}, `${nf.format(seatsIn())} / ${nf.format(seatsTotal())} حضروا`)), body, nav);
  ({ guests: viewGuests, scan: viewScan, event: viewEvent })[tab](body);
}

/* ---------- guests ---------- */
function viewGuests(root) {
  const list = h('ul', { class: 'list' });
  const draw = () => {
    const q = query.trim().toLowerCase();
    const rows = state.guests.filter(g => !q || g.name.toLowerCase().includes(q) || (g.table || '').toLowerCase() === q);
    list.replaceChildren(...rows.map(g => {
      const c = state.checkins[g.id]?.n || 0;
      return h('li', {}, h('button', { class: 'row', onclick: () => openGuest(g) },
        h('span', { class: 'nm' }, g.name), h('span', { class: 'sub' }, `${nf.format(g.seats)} ${g.seats === 1 ? 'فرد' : 'أفراد'}`, g.table ? ` • ترابيزة ${g.table}` : ''),
        h('span', { class: 'pill' + (c >= g.seats ? ' ok' : c ? ' part' : '') }, c ? `${nf.format(c)}/${nf.format(g.seats)}` : 'لسه')));
    }));
    if (!rows.length) list.append(h('li', { class: 'empty' }, state.guests.length ? 'مفيش نتيجة' : 'لسه مفيش ضيوف. ضيف أول واحد من تحت.'));
  };
  const add = h('form', { class: 'card stack', onsubmit: async e => {
    e.preventDefault(); const v = Object.fromEntries(new FormData(add));
    const seats = Math.min(99, Math.max(1, parseInt(v.seats, 10) || 1));
    state.guests.push({ id: rid(6), name: v.name.trim(), seats, table: v.table.trim(), phone: v.phone.trim() });
    await save(); add.reset(); add.seats.value = 1; draw(); renderStats(); toast('اتضاف'); add.name.focus();
  } },
    h('h3', {}, 'ضيف جديد'),
    h('div', { class: 'grid2' }, field('الاسم', h('input', { name: 'name', required: true })), field('الأفراد', h('input', { name: 'seats', type: 'number', min: 1, max: 99, value: 1, inputmode: 'numeric' }))),
    h('div', { class: 'grid2' }, field('الترابيزة', h('input', { name: 'table' })), field('موبايل (واتساب)', h('input', { name: 'phone', type: 'tel', dir: 'ltr', placeholder: '2010...' }))),
    h('button', { class: 'btn', type: 'submit' }, 'إضافة'));
  const bulk = h('details', { class: 'card' }, h('summary', {}, 'إضافة مجموعة'),
    h('p', { class: 'hint' }, 'سطر لكل ضيف: الاسم، عدد الأفراد، الترابيزة'),
    h('textarea', { rows: 5, dir: 'auto', placeholder: 'عمرو حسن، 2، 4\nأسرة الشناوي، 5' }),
    h('button', { class: 'btn ghost', type: 'button', onclick: async e => {
      const ta = e.target.previousSibling, gs = parseBulk(ta.value);
      if (!gs.length) return;
      gs.forEach(g => state.guests.push({ id: rid(6), phone: '', ...g })); await save(); ta.value = ''; draw(); renderStats(); toast(`اتضاف ${nf.format(gs.length)}`);
    } }, 'إضافة الكل'));
  const stats = h('div', { class: 'stats' });
  function renderStats() {
    stats.replaceChildren(stat(state.guests.length, 'دعوة'), stat(seatsTotal(), 'فرد'), stat(seatsIn(), 'حضروا'));
  }
  renderStats(); draw();
  root.append(stats,
    h('input', { class: 'search', type: 'search', placeholder: 'ابحث بالاسم أو رقم الترابيزة', value: query, oninput: e => { query = e.target.value; draw(); } }),
    list, add, bulk,
    state.guests.length ? h('button', { class: 'btn ghost', onclick: printAll }, 'اطبع كل الدعوات') : null);
}
const stat = (n, l) => h('div', { class: 'stat' }, h('b', {}, nf.format(n)), h('span', {}, l));

async function openGuest(g) {
  const token = await makeToken(state.event, g);
  const link = baseUrl() + inviteHash(state.event, g, token);
  const dlg = h('dialog', { class: 'sheet' });
  const waText = `أهلا ${g.name}، ده كارت دعوة فرح ${state.event.names}:\n${link}`;
  const phone = (g.phone || '').replace(/\D/g, '');
  dlg.append(h('div', { class: 'stack' },
    h('h3', {}, g.name), h('p', { class: 'sub' }, `${nf.format(g.seats)} أفراد`, g.table ? ` • ترابيزة ${g.table}` : ''),
    qrEl(token, 220),
    h('code', { class: 'code', dir: 'ltr' }, token),
    h('div', { class: 'btns' },
      h('a', { class: 'btn', target: '_blank', rel: 'noopener', href: `https://wa.me/${phone}?text=${encodeURIComponent(waText)}` }, 'ابعت واتساب'),
      navigator.share ? h('button', { class: 'btn ghost', onclick: () => navigator.share({ title: 'دعوة فرح', text: waText, url: link }).catch(() => {}) }, 'مشاركة') : null,
      h('button', { class: 'btn ghost', onclick: async () => { try { await navigator.clipboard.writeText(link); toast('اتنسخ اللينك'); } catch { prompt('انسخ اللينك', link); } } }, 'نسخ اللينك'),
      h('button', { class: 'btn ghost', onclick: async () => download(`qr-${g.name}.png`, await svgToPngBlob(qrSvg(token, 100))) }, 'تحميل QR')),
    h('button', { class: 'btn danger', onclick: async () => {
      if (!confirm(`مسح دعوة ${g.name}؟ الكود القديم مش هيتقفل لو اتبعت، بس الضيف هيختفي من القايمة.`)) return;
      state.guests = state.guests.filter(x => x.id !== g.id); delete state.checkins[g.id]; await save(); dlg.close(); route();
    } }, 'مسح الضيف'),
    h('button', { class: 'btn ghost', onclick: () => dlg.close() }, 'إغلاق')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}

async function printAll() {
  const cards = await Promise.all(state.guests.map(async g => {
    const t = await makeToken(state.event, g);
    return h('div', { class: 'pcard' }, h('b', {}, state.event.names), h('span', {}, fmtDate(state.event.date)), h('span', {}, state.event.venue), h('hr'), h('b', {}, g.name), h('span', {}, `${nf.format(g.seats)} أفراد`, g.table ? ` • ترابيزة ${g.table}` : ''), qrEl(t, 150));
  }));
  const box = h('div', { id: 'print' }, ...cards); document.body.append(box);
  addEventListener('afterprint', () => box.remove(), { once: true }); print();
}

/* ---------- scan ---------- */
function viewScan(root) {
  const out = h('div', { class: 'result', 'aria-live': 'polite' });
  const video = h('video', { playsinline: true, muted: true, class: 'cam' });
  const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const camBox = h('div', { class: 'camwrap' }, video);
  let stream = null, raf = 0, last = '', lastAt = 0, paused = false, alive = true;
  stopScan = () => { alive = false; cancelAnimationFrame(raf); stream?.getTracks().forEach(t => t.stop()); };

  async function handle(raw) {
    const v = await verifyToken(state.event, raw);
    if (!v.ok) return show('bad', v.reason === 'format' ? 'مش كود دعوة' : 'كود مزوّر أو من حدث تاني', raw.slice(0, 40));
    const g = state.guests.find(x => x.id === v.id);
    const name = g?.name || `ضيف ${v.id}`;
    const done = state.checkins[v.id]?.n || 0;
    if (done >= v.seats) return show('warn', 'دخل قبل كده', `${name} • دخل ${nf.format(done)}/${nf.format(v.seats)} الساعة ${fmtTime(state.checkins[v.id].at)}`);
    let n = v.seats - done;
    const num = h('b', { class: 'num' }, nf.format(n));
    const setN = d => { n = Math.min(v.seats - done, Math.max(1, n + d)); num.textContent = nf.format(n); };
    paused = true;
    show('ok', `دعوة صحيحة: ${name}`, `${g?.table ? 'ترابيزة ' + g.table + ' • ' : ''}${nf.format(v.seats)} أفراد${done ? `، دخل منهم ${nf.format(done)}` : ''}${g ? '' : ' • مش في قايمة الجهاز ده'}`,
      h('div', { class: 'stepper' }, h('button', { class: 'btn ghost', onclick: () => setN(-1) }, '−'), num, h('button', { class: 'btn ghost', onclick: () => setN(1) }, '+')),
      h('button', { class: 'btn', onclick: async () => {
        const cur = state.checkins[v.id];
        state.checkins[v.id] = { n: Math.min(v.seats, (cur?.n || 0) + n), at: cur?.at || Date.now() };
        await save(); document.querySelector('.top span').textContent = `${nf.format(seatsIn())} / ${nf.format(seatsTotal())} حضروا`; paused = false; last = ''; show('ok', 'تم تسجيل الدخول', `${name} • ${nf.format(n)}`); navigator.vibrate?.(60);
      } }, 'سجّل دخول'),
      h('button', { class: 'btn ghost', onclick: () => { paused = false; last = ''; out.replaceChildren(); } }, 'إلغاء'));
  }
  function show(kind, title, sub, ...extra) { out.className = 'result ' + kind; out.replaceChildren(h('h3', {}, title), sub ? h('p', {}, sub) : null, ...extra); }

  async function tick() {
    if (!alive) return;
    if (!paused && video.readyState >= 2) {
      const w = Math.min(720, video.videoWidth), s = w / video.videoWidth;
      canvas.width = w; canvas.height = Math.round(video.videoHeight * s);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const { default: jsQR } = await import('./jsqr.js');
      const r = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
      if (r && (r.data !== last || Date.now() - lastAt > 4000)) { last = r.data; lastAt = Date.now(); await handle(r.data); }
    }
    if (alive) raf = requestAnimationFrame(tick);
  }
  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      video.srcObject = stream; await video.play(); camBox.classList.add('live'); raf = requestAnimationFrame(tick);
    } catch (e) { show('warn', 'الكاميرا مش شغالة', 'اسمح بالكاميرا من إعدادات المتصفح، أو اكتب الكود يدوي تحت.'); }
  }
  const manual = h('form', { class: 'row-form', onsubmit: e => { e.preventDefault(); const i = e.target.code; if (i.value.trim()) handle(i.value); i.value = ''; } },
    h('input', { name: 'code', dir: 'ltr', placeholder: 'W1.XXXXXX.2.XXXXXXXXXXXXXXXX', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false' }), h('button', { class: 'btn' }, 'تحقق'));
  root.append(camBox, out, h('h3', {}, 'إدخال يدوي'), manual,
    h('p', { class: 'hint' }, 'التحقق بيتم على الجهاز نفسه بدون إنترنت. لو أكتر من موبايل بيمسحوا، ادمجوا النتايج من تبويب الحدث.'));
  start();
}

/* ---------- event ---------- */
function viewEvent(root) {
  const e = state.event;
  const f = h('form', { class: 'card stack', onsubmit: async ev => {
    ev.preventDefault(); const v = Object.fromEntries(new FormData(f));
    Object.assign(e, { names: v.names.trim(), date: v.date, venue: v.venue.trim(), map: v.map.trim(), note: v.note.trim() });
    await save(); toast('اتحفظ'); route();
  } }, h('h3', {}, 'بيانات الحدث'),
    field('الأسماء', h('input', { name: 'names', value: e.names, required: true })),
    field('الميعاد', h('input', { name: 'date', type: 'datetime-local', value: e.date, required: true })),
    field('المكان', h('input', { name: 'venue', value: e.venue, required: true })),
    field('لينك الخريطة', h('input', { name: 'map', value: e.map, dir: 'ltr' })),
    field('ملحوظة', h('input', { name: 'note', value: e.note })),
    h('p', { class: 'hint' }, 'اللينكات اللي اتبعتت قبل التعديل هتفضل بالبيانات القديمة. الأكواد نفسها صالحة.'),
    h('button', { class: 'btn' }, 'حفظ'));
  const merge = h('label', { class: 'btn ghost' }, 'دمج نسخة من جهاز تاني', h('input', { type: 'file', accept: 'application/json', hidden: true, onchange: async ev => {
    try {
      const other = JSON.parse(await ev.target.files[0].text());
      state = mergeState(state, other); await save(); toast('اندمجت'); route();
    } catch (err) { toast(err.message === 'event-mismatch' ? 'الملف ده لحدث تاني' : 'الملف مش صالح'); }
  } }));
  root.append(f, h('div', { class: 'card stack' }, h('h3', {}, 'النسخ والمزامنة'),
    h('button', { class: 'btn ghost', onclick: () => download('wedding-backup.json', new Blob([JSON.stringify(state)], { type: 'application/json' })) }, 'تصدير نسخة كاملة (JSON)'),
    merge,
    h('button', { class: 'btn ghost', onclick: () => download('guests.csv', new Blob([toCSV(state)], { type: 'text/csv;charset=utf-8' })) }, 'تصدير CSV'),
    h('p', { class: 'hint' }, 'النسخة الكاملة فيها المفتاح السري اللي بيوقّع الأكواد. متبعتهاش للضيوف. للماسحين التانيين بس.')),
    h('button', { class: 'btn danger', onclick: async () => {
      if (!confirm('مسح كل البيانات من الجهاز ده؟')) return;
      if (!confirm('متأكد؟ مفيش رجوع غير لو عندك نسخة.')) return;
      state = null; const db = await DB(); db.transaction('kv', 'readwrite').objectStore('kv').clear(); location.hash = ''; route();
    } }, 'مسح كل حاجة'));
}

/* ---------- boot ---------- */
(async () => {
  try { state = await load(); } catch { state = null; }
  route();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
