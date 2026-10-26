// La Manche 2026 — every CS&PF crossing of the season as one animated swarm.
//
// Data: web/data/tracks_<year>.json, written by `swim-tracks build`. Each swim
// carries its track as [minutes since start, lat, lng] at the pilot boat's
// 20-minute AIS fixes; positions in between are linear interpolation.
//
// Two clocks:
//   start — every swim starts at T = 0, so the swarm leaves Dover together and
//           the finish order is the order of the times.
//   hw    — T is hours relative to high water Dover; each swim enters at its own
//           tidal phase, so tracks that met the same stream line up.

const YEAR = 2026;
const TIDE_H = 12.4206; // M2 period, hours

const $ = (id) => document.getElementById(id);
// ?og renders the 1200x630 share card (see `task og`): no panel, no controls, frozen frame
const OG = new URLSearchParams(location.search).has('og');
if (OG) document.body.classList.add('og');
const state = {
  swims: [],
  align: 'start',
  org: 'all',
  kind: 'all',
  color: 'dur',
  sort: 'date',
  query: '',
  T: 0,
  playing: false,
  speed: 1,         // simulated hours per real second
  focus: null,      // swim object
  only: false,      // show the focused swim alone
  hover: null,
};

// ---------- formatting ----------
const hm = (h) => {
  const s = h < 0 ? '−' : '';
  const a = Math.abs(h);
  let H = Math.floor(a), M = Math.round((a - H) * 60);
  if (M === 60) { H += 1; M = 0; }
  return `${s}${H}:${String(M).padStart(2, '0')}`;
};
const hwLabel = (x) => `HW${x >= 0 ? '+' : '−'}${hm(Math.abs(x))}`;
const wrapHW = (x) => { // fold onto the nearest high water
  let p = ((x % TIDE_H) + TIDE_H) % TIDE_H;
  return p > TIDE_H / 2 ? p - TIDE_H : p;
};
const fmtDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long' });
const fmtClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
const fmtShort = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short' });
const springLabel = (f) => f < 0.55 ? 'neaps' : f < 0.75 ? 'towards neaps' : f < 0.92 ? 'mid-cycle' : f < 1.02 ? 'springs' : 'big springs';
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- colour ----------
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const RAMP = ['#7ff0d2', '#4fc3e8', '#a78bfa', '#f472b6', '#ff6b4a'].map(hex); // fast/neap -> slow/spring
function ramp(u) {
  u = Math.max(0, Math.min(1, u)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(u)), f = u - i;
  const c = RAMP[i].map((v, k) => Math.round(v + f * (RAMP[i + 1][k] - v)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
const BOAT_COLORS = ['#4fc3e8', '#ff6b4a', '#f0c674', '#7ff0d2', '#c792ea', '#f472b6', '#9ccc65', '#ffab70', '#e8edf7'];
const ORG = { cspf: { label: 'CS&PF', color: '#4fc3e8' }, csa: { label: 'CSA', color: '#f0c674' } };
let durDomain = [8, 20], boatColor = {};

function colorOf(s) {
  if (state.color === 'boat') return boatColor[s.boat] || '#8fa3c4';
  if (state.color === 'org') return ORG[s.org].color;
  if (state.color === 'spring') return ramp((s.spring - 0.45) / (1.1 - 0.45));
  return ramp((s.dur - durDomain[0]) / (durDomain[1] - durDomain[0]));
}

// ---------- time model ----------
const offset = (s) => (state.align === 'hw' ? s.hw : 0);
const elapsed = (s) => state.T - offset(s);
function range() {
  const vis = visible();
  if (!vis.length) return [0, 1];
  if (state.align === 'start') return [0, Math.max(...vis.map((s) => s.dur))];
  return [Math.min(...vis.map((s) => s.hw)), Math.max(...vis.map((s) => s.hw + s.dur))];
}
function visible() {
  return state.swims.filter((s) => {
    if (state.only && state.focus) return s === state.focus;
    return (state.org === 'all' || s.org === state.org) && (state.kind === 'all' || s.kind === state.kind);
  });
}

// position along the track after h hours; returns index of last passed fix too
function posAt(s, h) {
  const m = Math.max(0, Math.min(s.minutes, h * 60));
  const t = s.track;
  let i = 0;
  while (i < t.length - 2 && t[i + 1][0] <= m) i++;
  const a = t[i], b = t[i + 1] || a;
  const u = b[0] > a[0] ? (m - a[0]) / (b[0] - a[0]) : 0;
  return { i, lat: a[1] + u * (b[1] - a[1]), lng: a[2] + u * (b[2] - a[2]) };
}

// ---------- map ----------
const map = L.map('map', { zoomControl: false, attributionControl: true, zoomSnap: 0.25 }).setView([50.99, 1.45], 10);
L.control.zoom({ position: 'topright' }).addTo(map);
// CARTO basemap key, shared with the simulator: client-side and public by
// nature, free up to 5M tiles a month as long as the attribution stays visible.
const CARTO_KEY = 'cb1_2c2i_1_1ce4efe5c245f87b5e9ee326';
L.tileLayer(`https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png?key=${CARTO_KEY}`, {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> · Tracks <a href="https://cspf.co.uk/cs-and-pf-swims">CS&amp;PF</a>',
  maxZoom: 15,
}).addTo(map);
for (const [name, lat, lng, dir] of [
  ['Dover', 51.127, 1.316, 'left'], ['Folkestone', 51.081, 1.180, 'left'],
  ['Cap Gris-Nez', 50.8685, 1.581, 'left'], ['Wissant', 50.887, 1.664, 'right'],
  ['Cap Blanc-Nez', 50.925, 1.705, 'right'], ['Calais', 50.958, 1.852, 'right'],
  ['Boulogne', 50.726, 1.597, 'right'],
]) {
  L.circleMarker([lat, lng], { radius: 2, color: '#f2e9d8', weight: 1, opacity: 0.6, fillOpacity: 0.6, interactive: false })
    .addTo(map).bindTooltip(name, { permanent: true, direction: dir, className: 'place', offset: [dir === 'left' ? -4 : 4, 0] });
}

const cv = $('swarm');
const ctx = cv.getContext('2d');
let hidden = false;
map.on('zoomstart', () => { hidden = true; cv.style.opacity = 0; });
map.on('zoomend', () => { hidden = false; cv.style.opacity = 1; draw(); });
map.on('move resize', () => draw());

function sizeCanvas() {
  const sz = map.getSize(), dpr = window.devicePixelRatio || 1;
  if (cv.width !== sz.x * dpr || cv.height !== sz.y * dpr) {
    cv.width = sz.x * dpr; cv.height = sz.y * dpr;
    cv.style.width = sz.x + 'px'; cv.style.height = sz.y + 'px';
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
const P = (lat, lng) => map.latLngToContainerPoint([lat, lng]);

// screen-space path up to elapsed hours h (also cached for hit-testing)
function pathTo(s, h) {
  const p = posAt(s, h);
  const pts = [];
  for (let k = 0; k <= p.i; k++) pts.push(P(s.track[k][1], s.track[k][2]));
  pts.push(P(p.lat, p.lng));
  return pts;
}
function stroke(pts) {
  ctx.beginPath();
  pts.forEach((q, k) => (k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
  ctx.stroke();
}

let drawn = []; // [{s, pts}] for hover hit-testing

function draw() {
  if (hidden) return;
  sizeCanvas();
  const sz = map.getSize();
  ctx.clearRect(0, 0, sz.x, sz.y);
  ctx.lineJoin = ctx.lineCap = 'round';
  drawn = [];

  const focus = state.focus;
  const dim = focus && !state.only ? 0.18 : 1;
  const list = visible().filter((s) => s !== focus);

  // 1. trails
  for (const s of list) {
    const e = elapsed(s);
    if (e <= 0) continue;
    const pts = pathTo(s, e);
    drawn.push({ s, pts });
    const done = e >= s.dur;
    const hov = state.hover === s;
    ctx.strokeStyle = colorOf(s);
    ctx.globalAlpha = (hov ? 0.95 : done ? 0.3 : 0.55) * (hov ? 1 : dim);
    ctx.lineWidth = hov ? 2.6 : done ? 1.1 : 1.4;
    stroke(pts);
  }
  // 2. heads (in the water) and finish dots
  for (const s of list) {
    const e = elapsed(s);
    if (e <= 0) continue;
    const done = e >= s.dur;
    const p = posAt(s, e), q = P(p.lat, p.lng);
    ctx.globalAlpha = dim * (done ? 0.7 : 1);
    ctx.fillStyle = colorOf(s);
    if (!done) { ctx.shadowColor = colorOf(s); ctx.shadowBlur = 10; }
    ctx.beginPath();
    ctx.arc(q.x, q.y, done ? 1.8 : 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;
  if (focus) drawFocus(focus);
}

function drawFocus(s) {
  const col = colorOf(s);
  const full = s.track.map((t) => P(t[1], t[2]));
  // whole route as a dotted preview so the eye knows where it is going
  ctx.setLineDash([2, 5]);
  ctx.strokeStyle = '#f2e9d8';
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 1.2;
  stroke(full);
  ctx.setLineDash([]);

  const e = elapsed(s);
  if (e > 0) {
    const pts = pathTo(s, e);
    drawn.push({ s, pts });
    ctx.globalAlpha = 1;
    ctx.strokeStyle = col;
    ctx.lineWidth = 3.2;
    ctx.shadowColor = col; ctx.shadowBlur = 8;
    stroke(pts);
    ctx.shadowBlur = 0;
  }
  // hour ticks, only those already swum
  ctx.font = '10px "IBM Plex Mono", monospace';
  for (let h = 1; h < s.dur; h++) {
    if (h > e) break;
    const p = posAt(s, h), q = P(p.lat, p.lng);
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = '#0a1220';
    ctx.strokeStyle = '#f2e9d8';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(q.x, q.y, 2.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#f2e9d8';
    ctx.fillText(`${h}h`, q.x + 6, q.y + 3);
  }
  // start and head
  const st = full[0];
  ctx.fillStyle = '#f2e9d8';
  ctx.beginPath(); ctx.arc(st.x, st.y, 3, 0, Math.PI * 2); ctx.fill();
  const p = posAt(s, Math.max(0, e)), q = P(p.lat, p.lng);
  ctx.globalAlpha = 1;
  ctx.fillStyle = col;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.shadowColor = col; ctx.shadowBlur = 14;
  ctx.beginPath(); ctx.arc(q.x, q.y, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.shadowBlur = 0;
  if (e >= s.dur) {
    ctx.font = '600 11px "IBM Plex Mono", monospace';
    ctx.fillStyle = '#f2e9d8';
    ctx.fillText(`${s.landing} · ${s.time}`, q.x + 10, q.y + 4);
  }
}

// ---------- hover / click on the map ----------
function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
  const u = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
  return Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy);
}
function hit(pt) {
  let best = null, bd = 7;
  for (const { s, pts } of drawn) {
    for (let k = 1; k < pts.length; k++) {
      const d = segDist(pt, pts[k - 1], pts[k]);
      if (d < bd) { bd = d; best = s; }
    }
  }
  return best;
}
const tip = $('tip');
map.on('mousemove', (ev) => {
  const s = hit(ev.containerPoint);
  if (s !== state.hover) { state.hover = s; if (!state.playing) draw(); }
  map.getContainer().style.cursor = s ? 'pointer' : '';
  if (!s) { tip.style.display = 'none'; return; }
  tip.innerHTML = `${esc(s.name)}${s.team ? ` <small>(${s.team})</small>` : ''} · ${s.time.slice(0, 5)}<br><small>${fmtShort.format(s.startDate)} · ${esc(s.boat)} · ${s.landing}</small>`;
  tip.style.display = 'block';
  tip.style.left = ev.containerPoint.x + 14 + 'px';
  tip.style.top = ev.containerPoint.y + 12 + 'px';
});
map.on('mouseout', () => { tip.style.display = 'none'; state.hover = null; });
map.on('click', (ev) => {
  const s = hit(ev.containerPoint);
  select(s && s !== state.focus ? s : null);
});

// keep tracks clear of the overlays: clock top-left, card top-right, time bar below
function fitTrack(s) {
  const wide = map.getSize().x > 700;
  map.flyToBounds(L.latLngBounds(s.track.map((t) => [t[1], t[2]])), {
    duration: 0.6,
    paddingTopLeft: [40, 110],
    paddingBottomRight: [wide ? 360 : 40, wide ? 90 : 260],
  });
}

// ---------- duration strip (dot histogram, fills up as swimmers land) ----------
const strip = $('strip'), sctx = strip.getContext('2d');
let stripDots = [];
function drawStrip() {
  const w = strip.clientWidth, h = strip.clientHeight, dpr = window.devicePixelRatio || 1;
  if (strip.width !== w * dpr) { strip.width = w * dpr; strip.height = h * dpr; }
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sctx.clearRect(0, 0, w, h);
  const [lo, hi] = [Math.floor(durDomain[0]) - 0.5, Math.ceil(Math.max(...state.swims.map((s) => s.dur)))];
  const x = (d) => 6 + ((d - lo) / (hi - lo)) * (w - 12);
  const sorted = [...state.swims].sort((a, b) => a.dur - b.dur);
  // bin width = dot pitch; shrink the pitch until the tallest column fits
  let step = 5.2, cols;
  for (;;) {
    cols = {};
    for (const s of sorted) { const c = Math.round(x(s.dur) / step); cols[c] = (cols[c] || 0) + 1; }
    if (4 + Math.max(...Object.values(cols)) * step <= h || step < 3) break;
    step -= 0.2;
  }
  const r = step / 2 - 0.3;
  cols = {};
  stripDots = [];
  const vis = new Set(visible());
  for (const s of sorted) {
    const cx = Math.round(x(s.dur) / step) * step;
    const n = (cols[cx] = (cols[cx] || 0) + 1);
    const cy = h - 2 - r - (n - 1) * step;
    stripDots.push({ s, x: cx, y: cy });
    const on = vis.has(s);
    const done = on && elapsed(s) >= s.dur;
    sctx.globalAlpha = !on ? 0.12 : done ? 1 : 0.35;
    sctx.fillStyle = done || !on ? colorOf(s) : 'transparent';
    sctx.strokeStyle = colorOf(s);
    sctx.lineWidth = 1;
    sctx.beginPath(); sctx.arc(cx, cy, r, 0, Math.PI * 2);
    done || !on ? sctx.fill() : sctx.stroke();
    if (s === state.focus) {
      sctx.globalAlpha = 1; sctx.strokeStyle = '#fff'; sctx.lineWidth = 1.5;
      sctx.beginPath(); sctx.arc(cx, cy, r + 2.2, 0, Math.PI * 2); sctx.stroke();
    }
  }
  sctx.globalAlpha = 1;
  if (state.color === 'spring') {
    $('capL').textContent = 'neaps'; $('capM').textContent = 'colour = tidal range'; $('capR').textContent = 'springs';
  } else if (state.color === 'org') {
    $('capL').textContent = hm(lo + 0.5) + ' h'; $('capM').innerHTML = `<span style="color:${ORG.cspf.color}">CS&amp;PF</span> · <span style="color:${ORG.csa.color}">CSA</span>`; $('capR').textContent = hm(hi) + ' h';
  } else if (state.color === 'boat') {
    $('capL').textContent = hm(lo + 0.5) + ' h'; $('capM').textContent = 'colour = pilot boat'; $('capR').textContent = hm(hi) + ' h';
  } else {
    $('capL').textContent = hm(lo + 0.5) + ' h'; $('capM').textContent = 'swim time'; $('capR').textContent = hm(hi) + ' h';
  }
}
strip.addEventListener('click', (ev) => {
  const b = strip.getBoundingClientRect(), px = ev.clientX - b.left, py = ev.clientY - b.top;
  let best = null, bd = 8;
  for (const d of stripDots) { const dd = Math.hypot(d.x - px, d.y - py); if (dd < bd) { bd = dd; best = d.s; } }
  if (best) select(best === state.focus ? null : best);
});

// ---------- list ----------
function renderList() {
  const q = state.query.toLowerCase();
  const rows = visible().filter((s) => !q || s.search.includes(q));
  const by = {
    date: (a, b) => a.startDate - b.startDate,
    time: (a, b) => a.dur - b.dur,
    name: (a, b) => a.name.localeCompare(b.name),
  }[state.sort];
  rows.sort(by);
  $('list').innerHTML = rows.length ? rows.map((s) => `
    <li data-id="${s.id}" class="${s === state.focus ? 'sel' : ''}">
      <span class="dot" style="background:${colorOf(s)}"></span>
      <span class="nm">${esc(s.name)}${s.team ? ` <small>· relay of ${s.team}</small>` : ''}</span>
      <span class="tm">${s.time.slice(0, 5)}</span>
      <span class="meta">${ORG[s.org].label} · ${fmtShort.format(s.startDate)} · ${esc(s.boat)} · ${s.landing}${s.partial ? ' · ⚠' : ''}</span>
    </li>`).join('') : '<li class="empty">No matches</li>';
  updateDone();
}
$('list').addEventListener('click', (ev) => {
  const li = ev.target.closest('li[data-id]');
  if (!li) return;
  const s = state.swims.find((x) => x.id === li.dataset.id);
  select(s === state.focus ? null : s, true);
});
let lastDone = -1;
function updateDone(force) {
  const done = new Set(visible().filter((s) => elapsed(s) >= s.dur).map((s) => s.id));
  if (!force && done.size === lastDone) return;
  lastDone = done.size;
  for (const li of $('list').children) li.classList.toggle('done', done.has(li.dataset.id));
}

// ---------- focus ----------
function select(s, fly) {
  state.focus = s || null;
  if (!s) state.only = false;
  history.replaceState(null, '', s ? `#${s.id}` : location.pathname);
  renderCard();
  renderList();
  if (s) {
    const li = $('list').querySelector(`li[data-id="${s.id}"]`);
    li?.scrollIntoView({ block: 'nearest' });
    if (fly) fitTrack(s);
    // jump the clock so the chosen swim is actually in the water
    const e = elapsed(s);
    if (e <= 0 || (e >= s.dur && !state.playing)) setT(offset(s));
  }
  syncScrub();
  draw(); drawStrip(); drawClock();
}
function renderCard() {
  const s = state.focus, card = $('card');
  if (!s) { card.style.display = 'none'; return; }
  const kind = `${ORG[s.org].label} · ` + (s.kind === 'solo' ? 'Solo' : `Relay · ${s.team ?? '?'} swimmers${s.legs > 1 ? ' · two-way' : ''}`);
  const kmh = (s.km / s.dur).toFixed(2);
  card.innerHTML = `
    <button class="close" aria-label="Close">×</button>
    <div class="kind">${kind}</div>
    <h3>${esc(s.name)}</h3>
    ${s.members || s.country ? `<div class="who">${esc([s.members, s.country].filter(Boolean).join(' · '))}</div>` : ''}
    <div class="time">${s.time}</div>
    <div class="grid">
      <div><div class="k">Start</div><div class="v">${fmtDate.format(s.startDate)}, ${fmtClock.format(s.startDate)}</div></div>
      <div><div class="k">Tide</div><div class="v">${hwLabel(s.hw)}</div></div>
      <div><div class="k">Pilot / boat</div><div class="v">${esc(s.pilots)}</div></div>
      <div><div class="k">Tidal range</div><div class="v">${springLabel(s.spring)} (${Math.round(s.spring * 100)}%)</div></div>
      <div><div class="k">Track</div><div class="v">${s.km.toFixed(1)} km · ${kmh} km/h</div></div>
      <div><div class="k">Landing</div><div class="v">${s.landing}</div></div>
    </div>
    ${s.partial ? '<div class="warn">⚠ AIS feed has gaps: the end is interpolated and the track is incomplete.</div>' : ''}
    <div class="actions">
      <button data-a="only" class="${state.only ? 'on' : ''}">${state.only ? 'Show swarm' : 'This crossing only'}</button>
      <button data-a="replay">Replay</button>
      <button data-a="zoom">Zoom</button>
    </div>`;
  card.style.display = 'block';
}
$('card').addEventListener('click', (ev) => {
  const s = state.focus;
  if (ev.target.closest('.close')) return select(null);
  const a = ev.target.closest('button')?.dataset.a;
  if (a === 'only') { state.only = !state.only; renderCard(); renderList(); syncScrub(); draw(); drawStrip(); }
  if (a === 'replay') { setT(offset(s)); play(true); }
  if (a === 'zoom') fitTrack(s);
});

// ---------- clock + time bar ----------
function drawClock() {
  const vis = visible();
  const inWater = vis.filter((s) => { const e = elapsed(s); return e > 0 && e < s.dur; }).length;
  const done = vis.filter((s) => elapsed(s) >= s.dur).length;
  const s = state.focus;
  if (state.align === 'hw') {
    $('clockk').textContent = 'Tidal phase Dover';
    $('clock').textContent = hwLabel(wrapHW(state.T));
  } else {
    $('clockk').textContent = 'Since start';
    $('clock').textContent = hm(Math.max(0, state.T));
  }
  let sub = `<b>${inWater}</b> in the water · <b>${done}</b> of ${vis.length} in France`;
  if (s) {
    const e = Math.max(0, Math.min(s.dur, elapsed(s)));
    const at = new Date(s.startDate.getTime() + e * 3600e3);
    sub = `${esc(s.name.length > 22 ? s.name.split(' ')[0] : s.name)}: <b>${fmtClock.format(at)}</b> · ${hm(e)} in the water`;
  }
  $('clocksub').innerHTML = sub;
  const [a, b] = range();
  $('barlabel').textContent = state.align === 'hw' ? `${hwLabel(state.T)}` : `${hm(state.T)} / ${hm(b)}`;
}
const scrub = $('scrub');
function syncScrub() {
  const [a, b] = range();
  scrub.value = Math.round(((state.T - a) / (b - a)) * 1000);
}
function setT(T) {
  const [a, b] = range();
  state.T = Math.max(a, Math.min(b, T));
  syncScrub();
  draw(); drawClock(); drawStrip(); updateDone();
}
scrub.addEventListener('input', () => {
  const [a, b] = range();
  setT(a + (scrub.value / 1000) * (b - a));
});

let lastFrame = 0;
function frame(ts) {
  if (!state.playing) return;
  const dt = lastFrame ? Math.min(0.1, (ts - lastFrame) / 1000) : 0;
  lastFrame = ts;
  const [, b] = range();
  setT(state.T + dt * state.speed);
  if (state.T >= b) return pause();
  requestAnimationFrame(frame);
}
function play(fromHere) {
  const [a, b] = range();
  if (!fromHere && state.T >= b - 1e-6) state.T = a;
  state.playing = true;
  lastFrame = 0;
  $('play').textContent = '❚❚';
  requestAnimationFrame(frame);
}
function pause() {
  state.playing = false;
  $('play').textContent = '▶';
  draw();
}
$('play').onclick = () => (state.playing ? pause() : play());
$('rew').onclick = () => setT(range()[0]);
$('speed').onchange = (ev) => (state.speed = +ev.target.value);

// ---------- controls ----------
function seg(id, key, after) {
  $(id).addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    for (const x of $(id).children) x.classList.toggle('on', x === b);
    state[key] = b.dataset.v;
    after?.();
  });
}
seg('align', 'align', () => {
  // keep roughly the same moment: map T onto the other clock
  state.T = range()[0];
  syncScrub(); draw(); drawClock(); drawStrip(); updateDone(true);
});
seg('org', 'org', () => {
  updateStats();
  if (state.focus && state.org !== 'all' && state.focus.org !== state.org) select(null);
  setT(state.T); renderList(); drawStrip();
});
seg('kind', 'kind', () => {
  if (state.focus && state.kind !== 'all' && state.focus.kind !== state.kind) select(null);
  setT(state.T); renderList();
});
seg('color', 'color', () => { draw(); drawStrip(); renderList(); });
$('q').addEventListener('input', (ev) => { state.query = ev.target.value; renderList(); });
$('sort').addEventListener('change', (ev) => { state.sort = ev.target.value; renderList(); });
document.addEventListener('keydown', (ev) => {
  if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
  if (ev.code === 'Space') { ev.preventDefault(); state.playing ? pause() : play(); }
  if (ev.key === 'Escape') select(null);
  if (ev.key === 'ArrowRight') setT(state.T + 1 / 6);
  if (ev.key === 'ArrowLeft') setT(state.T - 1 / 6);
});
window.addEventListener('resize', () => drawStrip());

// counts follow the body filter, not the solo/relay one
function updateStats() {
  const xs = state.swims.filter((s) => state.org === 'all' || s.org === state.org);
  $('nAll').textContent = xs.length;
  $('nSolo').textContent = xs.filter((s) => s.kind === 'solo').length;
  $('nRelay').textContent = xs.filter((s) => s.kind === 'relay').length;
}

function renderOG() {
  state.color = 'org';
  const n = (o) => state.swims.filter((s) => s.org === o).length;
  $('ogcard').innerHTML = `
    <div class="eyebrow">English Channel · season ${YEAR}</div>
    <h1>La Manche <em>${YEAR}</em></h1>
    <p>Every one of the ${state.swims.length} successful crossings, replayed as one swarm from the pilot boats' tracks.</p>
    <div class="legend">
      <span><i style="background:${ORG.cspf.color}"></i>CS&amp;PF · ${n('cspf')}</span>
      <span><i style="background:${ORG.csa.color}"></i>CSA · ${n('csa')}</span>
    </div>`;
  map.invalidateSize();
  // fixed frame for the 1200px card: Dover lands just right of the text column
  map.setView([50.945, 1.222], 10, { animate: false });
  // mid-swarm: the fan fully spread, half still in the water, the first ones landed
  state.T = 10.5;
  setTimeout(() => { hidden = false; cv.style.opacity = 1; draw(); window.ogReady = true; }, 400);
}

// ---------- load ----------
function trackKm(t) {
  let km = 0;
  for (let k = 1; k < t.length; k++) {
    const dy = (t[k][1] - t[k - 1][1]) * 111.2, dx = (t[k][2] - t[k - 1][2]) * 111.2 * Math.cos((t[k][1] * Math.PI) / 180);
    km += Math.hypot(dx, dy);
  }
  return km;
}
const quantile = (xs, q) => { const a = [...xs].sort((x, y) => x - y); return a[Math.floor(q * (a.length - 1))]; };

fetch(`data/tracks_${YEAR}.json`, { cache: 'no-cache' }) // revalidate: the file changes on every build
  .then((r) => r.json())
  .then((data) => {
    state.swims = data.swims.map((s) => ({
      ...s,
      dur: s.minutes / 60,
      startDate: new Date(s.start),
      km: trackKm(s.track),
      search: `${s.name} ${s.pilots} ${s.landing} ${s.members || ''} ${s.country || ''} ${ORG[s.org].label}`.toLowerCase(),
    }));
    const durs = state.swims.map((s) => s.dur);
    durDomain = [quantile(durs, 0.03), quantile(durs, 0.97)];
    const boats = Object.entries(state.swims.reduce((m, s) => ((m[s.boat] = (m[s.boat] || 0) + 1), m), {}))
      .sort((a, b) => b[1] - a[1]);
    boats.forEach(([b], i) => (boatColor[b] = BOAT_COLORS[i % BOAT_COLORS.length]));

    updateStats();

    if (!OG) map.fitBounds(L.latLngBounds(state.swims.flatMap((s) => s.track.map((t) => [t[1], t[2]]))), {
      paddingTopLeft: [30, 90], paddingBottomRight: [30, 80],
    });
    renderList();
    const pre = state.swims.find((s) => `#${s.id}` === location.hash);
    if (pre) select(pre, true);
    setT(range()[0]);
    drawStrip();
    if (OG) return renderOG();
    if (!pre) setTimeout(() => play(), 700);
  });
