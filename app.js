'use strict';

// Class definitions. Values in trip.json:
//   sig:  0 good, 1 fair, 2 poor, 3 no service
//   inet: 0 working, 1 degraded, 2 not working, null not tested
const CLASSES = {
  inet: [
    { label: 'Working', color: '--good' },
    { label: 'Degraded', color: '--warning' },
    { label: 'Not working', color: '--critical' },
    { label: 'Not tested', color: '--unknown' },
  ],
  sig: [
    { label: 'Good', color: '--good' },
    { label: 'Fair', color: '--warning' },
    { label: 'Poor', color: '--serious' },
    { label: 'No service', color: '--critical' },
  ],
  // Train speed, km/h: red = stopped, green = fast. Stops also get sized circles,
  // so the reading never depends on red vs green alone.
  spd: [
    { label: 'Stopped', color: '--spd0', max: 5 },
    { label: '5–30', color: '--spd1', max: 30 },
    { label: '30–60', color: '--spd2', max: 60 },
    { label: '60–90', color: '--spd3', max: 90 },
    { label: '≥ 90 km/h', color: '--spd4', max: Infinity },
  ],
};
// The class that means "no connectivity" in each mode: drawn thicker and on top.
const BAD = { inet: 2, sig: 3 };
const UNKNOWN = 3;  // index used for inet === null
// Train 22120 (Madgaon – Mumbai CSMT Tejas Express) halts with scheduled times
// (ConfirmTkt). Thane, Dadar and CSMT come after the log ends, so they're omitted.
const TRAIN = { number: '22120', name: 'Tejas Express', destination: 'Dadar' };
const HALTS = new Map([
  ['Madgaon', 'dep 12:50'], ['Karmali', '13:30'], ['Kudal', '14:48'],
  ['Ratnagiri', '18:05'], ['Chiplun', '19:40'], ['Panvel', '22:25'],
]);
const isKey = name => HALTS.has(name) || name === LAST_STATION();
const LAST_STATION = () => D.stations[D.stations.length - 1].name;

const $ = s => document.querySelector(s);
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const pct = x => (x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0) + '%';
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let D, N, START, mode = 'inet';
let map, trackLayer, dzLayer, stopLayer, hoverMarker;

fetch('data/trip.json')
  .then(r => r.json())
  .then(init)
  .catch(err => { $('#sub').textContent = 'Could not load data/trip.json: ' + err.message; });

// ---------------------------------------------------------------- helpers

function cls(kind, i) {
  if (kind === 'inet') return D.cols.inet[i] ?? UNKNOWN;
  if (kind === 'spd') return CLASSES.spd.findIndex(c => D.cols.v[i] < c.max);
  return D.cols.sig[i];
}

// Speed for every sample: GPS speed where there was a fix, otherwise distance
// over time across a ±30 s window (tunnels).
function computeSpeeds() {
  const { t, km, spd, interp } = D.cols;
  D.cols.v = t.map((_, i) => {
    if (spd[i] != null && !interp[i]) return spd[i];
    let a = i, b = i;
    while (a > 0 && t[i] - t[a - 1] <= 30) a--;
    while (b < N - 1 && t[b + 1] - t[i] <= 30) b++;
    return t[b] > t[a] ? Math.round(((km[b] - km[a]) / (t[b] - t[a])) * 3600) : 0;
  });
}

// Probable tunnels: runs without a GPS fix lasting >= 15 s while the train kept moving.
// D.tunnels = [{ i0, i1, km0, km1, t0, t1 }], D.cols.tun[i] = 1 inside one.
function computeTunnels() {
  const { t, km, interp } = D.cols;
  D.tunnels = [];
  D.cols.tun = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!interp[i]) continue;
    let j = i;
    while (j + 1 < N && interp[j + 1]) j++;
    const a = Math.max(0, i - 1), b = Math.min(N - 1, j + 1);  // last fix before, first fix after
    const dur = t[b] - t[a], dist = km[b] - km[a];
    if (dur >= 15 && dist / dur * 3600 > 10) {
      D.tunnels.push({ i0: a, i1: b, km0: km[a], km1: km[b], t0: t[a], t1: t[b] });
      for (let k = i; k <= j; k++) D.cols.tun[k] = 1;
    }
    i = j;
  }
}

// Stops: runs below 5 km/h lasting >= 60 s (moving blips under 60 s don't split a stop).
// D.stops = [{ i, t0, t1, km, halt, where }]
function computeStops() {
  const { t, km, v } = D.cols;
  const raw = [];
  for (let i = 0; i < N; i++) {
    if (v[i] >= 5) continue;
    let j = i;
    while (j + 1 < N && v[j + 1] < 5) j++;
    const prev = raw[raw.length - 1];
    if (prev && t[i] - t[prev.j] < 60) prev.j = j; else raw.push({ i, j });
    i = j;
  }
  D.stops = raw.filter(r => t[r.j] - t[r.i] + 5 >= 60).map(r => {
    const mid = (r.i + r.j) >> 1;
    const halt = D.stations.find(s => HALTS.has(s.name) && Math.abs(s.km - km[mid]) < 2);
    return { i: mid, t0: t[r.i], t1: t[r.j] + 5, km: km[mid], halt: halt?.name, where: between(km[mid]) };
  });
}

// Fraction of [km0, km1] that lies inside tunnels.
function tunnelShare(km0, km1) {
  if (km1 <= km0) return 0;
  let inside = 0;
  for (const tn of D.tunnels) inside += Math.max(0, Math.min(km1, tn.km1) - Math.max(km0, tn.km0));
  return inside / (km1 - km0);
}

// Time (s) represented by sample i, capped so logger restarts don't count.
function dt(i) { return i + 1 < N ? Math.min(30, D.cols.t[i + 1] - D.cols.t[i]) : 0; }

function ist(t, opts = {}) {
  return new Date((START + t) * 1000).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false, ...opts,
  });
}

function fmtDur(s) {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${Math.max(1, m)} min`;
}

// Distance travelled between sample i and i+1 (the weight of sample i).
function seg(i) { return i + 1 < N ? D.cols.km[i + 1] - D.cols.km[i] : 0; }

// Share of each class within [i0, i1), by distance (default) or by time.
function shares(kind, i0 = 0, i1 = N, byTime = false) {
  const w = CLASSES[kind].map(() => 0);
  for (let i = i0; i < i1; i++) w[cls(kind, i)] += byTime ? dt(i) : seg(i);
  const tot = w.reduce((a, b) => a + b, 0) || 1;
  return w.map(x => x / tot);
}

// Index of the sample nearest to a given km (km is non-decreasing).
function idxAtKm(k) {
  const km = D.cols.km;
  let lo = 0, hi = N - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (km[mid] < k) lo = mid + 1; else hi = mid; }
  return lo > 0 && Math.abs(km[lo - 1] - k) < Math.abs(km[lo] - k) ? lo - 1 : lo;
}

function between(k) {
  const s = D.stations;
  let a = null, b = null;
  for (const st of s) { if (st.km <= k) a = st; else { b = st; break; } }
  if (a && Math.abs(a.km - k) < 1.5) return `at ${a.name}`;
  if (b && Math.abs(b.km - k) < 1.5) return `at ${b.name}`;
  return a && b ? `${a.name} – ${b.name}` : (a || b).name;
}

// Runs of consecutive samples with the same class.
// Runs of consecutive samples with the same class in an array of classes.
function runsOf(c) {
  const out = [];
  let start = 0;
  for (let i = 1; i <= N; i++) {
    if (i === N || c[i] !== c[start]) {
      out.push({ i0: start, i1: i, c: c[start] });
      start = i;
    }
  }
  return out;
}

// Display classes for the map and route bands: blips shorter than 1 km and 2 min
// are absorbed into their surroundings so long stretches read as one clean run.
// Statistics and tables always use the raw classes.
const SMOOTH_KM = 1, SMOOTH_S = 120;
const displayCache = {};
function displayClasses(kind) {
  if (displayCache[kind]) return displayCache[kind];
  const { km, t } = D.cols;
  const c = Array.from({ length: N }, (_, i) => cls(kind, i));
  const len = r => km[Math.min(r.i1, N - 1)] - km[r.i0];
  for (let pass = 0; pass < 8; pass++) {
    const rs = runsOf(c);
    let changed = false;
    // Shortest blips first, so a blip is judged against settled neighbours.
    const order = rs.map((r, k) => k).sort((p, q) => len(rs[p]) - len(rs[q]));
    for (const k of order) {
      const r = rs[k];
      if (len(r) >= SMOOTH_KM || t[Math.min(r.i1, N - 1)] - t[r.i0] >= SMOOTH_S) continue;
      const a = rs[k - 1], b = rs[k + 1];
      if (!a && !b) continue;
      const into = !b ? a : !a ? b : a.c === b.c ? a : (len(a) >= len(b) ? a : b);
      if (into.c === r.c) continue;
      for (let i = r.i0; i < r.i1; i++) c[i] = into.c;
      r.c = into.c;
      changed = true;
    }
    if (!changed) break;
  }
  return (displayCache[kind] = c);
}

function runs(kind) { return runsOf(displayClasses(kind)); }

function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

// ---------------------------------------------------------------- init

function dayDiff(m) {
  const day = t => new Date(t * 1000).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
  return day(m.start) !== day(m.end);
}

function init(data) {
  D = data;
  N = D.cols.t.length;
  START = D.meta.start;
  computeSpeeds();
  computeTunnels();
  computeStops();
  const m = D.meta;
  const date = new Date(m.start * 1000).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric',
  });
  $('#sub').textContent =
    `${m.origin} → ${TRAIN.destination} · ${date} · ${Math.round(m.km)} km logged in ${fmtDur(m.end - m.start)} ` +
    `(${ist(0)}–${ist(m.end - m.start)} IST${dayDiff(m) ? ', next day' : ''}) · ${m.samples.toLocaleString('en-IN')} measurements`;

  renderKpis();
  initMap();
  renderLegend();
  renderRoute();
  renderSegments();
  renderDeadZones();
  renderSpeedChart();

  document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === b));
    mode = b.dataset.mode;
    drawTrack();
    drawDeadZonePins();
    drawStops();
    renderLegend();
  }));
  let rt;
  // Redraw the route chart whenever its container changes width (window resize, scrollbar, zoom).
  let lastW = 0;
  new ResizeObserver(([e]) => {
    const w = Math.round(e.contentRect.width);
    if (w === lastW) return;
    lastW = w;
    clearTimeout(rt);
    rt = setTimeout(() => { map.invalidateSize(); renderRoute(); }, 100);
  }).observe($('#route'));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    drawTrack(); renderLegend(); renderRoute(); renderSegments(); renderDeadZones(); renderSpeedChart();
  });
}

// ---------------------------------------------------------------- KPIs

function renderKpis() {
  const inetTested = shares('inet');
  const testedTot = 1 - inetTested[UNKNOWN];
  const working = inetTested[0] / (testedTot || 1);  // degraded doesn't count
  const sig = shares('sig');
  const dz = D.deadzones;
  const longest = dz.reduce((a, b) => (b.dur > (a?.dur ?? 0) ? b : a), null);
  const deadTime = dz.reduce((s, z) => s + z.dur, 0);
  const pings = [], losses = [];
  for (let i = 0; i < N; i++) {
    if (D.cols.ms[i] != null) pings.push(D.cols.ms[i]);
    if (D.cols.loss[i] != null && D.cols.ms[i] != null) losses.push(D.cols.loss[i]);
  }
  const loss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;

  const tiles = [
    [pct(working), 'of the route had working internet', `${pct(1 - working)} without`],
    [pct(sig[3]), 'of the route had no mobile service', `${Math.round(sig[3] * D.meta.km)} km in total`],
    [dz.length, 'dead zones of a minute or more', `${fmtDur(deadTime)} without internet`],
    [longest ? fmtDur(longest.dur) : '–', 'longest dead zone',
      longest ? `${(longest.km1 - longest.km0).toFixed(0)} km, ${longest.where}` : ''],
    [D.tunnels.length, 'probable tunnels (GPS lost)', tunnelSummary()],
    [`${median(pings)} ms`, 'median ping when connected', `90th percentile ${pings.sort((a, b) => a - b)[Math.floor(pings.length * 0.9)]} ms`],
    [`${loss.toFixed(1)}%`, 'packet loss when connected', `${pings.length.toLocaleString('en-IN')} ping tests`],
  ];
  $('#kpis').innerHTML = tiles.map(([v, l, d]) =>
    `<div class="kpi"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div><div class="d">${esc(d)}</div></div>`
  ).join('');
}

function tunnelSummary() {
  const km = D.tunnels.reduce((a, tn) => a + tn.km1 - tn.km0, 0);
  let w = 0, bad = 0;
  for (let i = 0; i < N; i++) if (D.cols.tun[i] && D.cols.inet[i] != null) { w += dt(i); if (D.cols.inet[i] === 2) bad += dt(i); }
  return `${km.toFixed(0)} km · internet down ${w ? pct(bad / w) : '–'} of the time inside`;
}

// ---------------------------------------------------------------- map

function initMap() {
  map = L.map('map', { preferCanvas: true, scrollWheelZoom: false, zoomSnap: 0.25 });
  const esri = name => `https://server.arcgisonline.com/ArcGIS/rest/services/${name}/MapServer/tile/{z}/{y}/{x}`;
  const base = {
    'Map': L.tileLayer(esri('World_Street_Map'), { maxZoom: 19, attribution: 'Tiles &copy; Esri' }),
    'Satellite': L.tileLayer(esri('World_Imagery'), { maxZoom: 18, attribution: 'Imagery &copy; Esri' }),
  };
  base['Map'].addTo(map);
  map.on('click', () => map.scrollWheelZoom.enable());
  // The canvas renderer needs a view before any vector layer is added.
  map.fitBounds(D.cols.lat.map((la, i) => [la, D.cols.lon[i]]), { padding: [20, 20] });

  // Tunnels: a wide dark tube under the coloured track, with a portal at each end.
  // Created before the track so the track is drawn on top of it.
  const tunnelLayer = L.layerGroup().addTo(map);
  for (const tn of D.tunnels) {
    const ll = [];
    for (let i = tn.i0; i <= tn.i1; i++) ll.push([D.cols.lat[i], D.cols.lon[i]]);
    const tip = `<b>Probable tunnel</b><br>${(tn.km1 - tn.km0).toFixed(1)} km · ${fmtDur(tn.t1 - tn.t0)} without GPS<br>` +
      `${ist(tn.t0)} IST · ${esc(between((tn.km0 + tn.km1) / 2))}`;
    L.polyline(ll, { color: '#2b2b29', weight: 22, opacity: 0.85, lineCap: 'butt' })
      .bindTooltip(tip, { sticky: true }).addTo(tunnelLayer);
    for (const p of [ll[0], ll[ll.length - 1]]) {
      L.circleMarker(p, { radius: 4, color: '#ffffff', weight: 1.5, fillColor: '#2b2b29', fillOpacity: 1, interactive: false })
        .addTo(tunnelLayer);
    }
  }
  trackLayer = L.layerGroup().addTo(map);
  drawTrack();
  // Re-adding the overlay puts it on top; redraw the track over it.
  map.on('overlayadd', () => { drawTrack(); drawDeadZonePins(); drawStops(); });

  // Only the 22120 halts and the point where the log ends are marked.
  for (const s of D.stations.filter(s => isKey(s.name))) {
    const halt = HALTS.has(s.name);
    const passed = ist(D.cols.t[idxAtKm(s.km)]);
    L.circleMarker([s.lat, s.lon], {
      radius: halt ? 6 : 5, color: '#ffffff', weight: 2, fillColor: '#1a1a19', fillOpacity: 1,
    }).bindTooltip(halt ? `<b>${esc(s.name)}</b>` : `${esc(s.name)} · log ends`, {
      className: 'stn', permanent: true, direction: halt ? 'right' : 'left', offset: [halt ? 9 : -9, 0],
    }).bindPopup(halt
      ? `<b>${esc(s.name)}</b> · ${TRAIN.number} halt<br>Scheduled ${HALTS.get(s.name)} · passed ${passed} IST`
      : `<b>${esc(s.name)}</b><br>Log ends here, ${passed} IST`
    ).addTo(map);
  }
  dzLayer = L.layerGroup().addTo(map);
  drawDeadZonePins();
  stopLayer = L.layerGroup().addTo(map);
  drawStops();

  L.control.layers(base, { 'Tunnels (GPS lost)': tunnelLayer }, { position: 'topright' }).addTo(map);
  hoverMarker = L.circleMarker([0, 0], { radius: 8, color: '#0b0b0b', weight: 2, fillOpacity: 0 });
}

function drawTrack() {
  trackLayer.clearLayers();
  const { lat, lon } = D.cols;
  const coords = (i0, i1) => {
    const c = [];
    for (let i = i0; i <= Math.min(i1, N - 1); i++) c.push([lat[i], lon[i]]);
    return c;
  };
  // Casing underneath so the coloured line reads on any background.
  const bad = BAD[mode];
  L.polyline(coords(0, N - 1), { color: css('--casing'), weight: 8, opacity: 0.9, interactive: false }).addTo(trackLayer);
  // Draw the no-connectivity runs last, wider and with their own casing, so they read at any zoom.
  const rs = runs(mode).sort((a, b) => (a.c === bad) - (b.c === bad));
  for (const r of rs) {
    const isBad = r.c === bad;
    if (isBad) {
      L.polyline(coords(r.i0, r.i1), { color: css('--casing'), weight: 11, opacity: 1, interactive: false }).addTo(trackLayer);
    }
    L.polyline(coords(r.i0, r.i1), {
      color: css(CLASSES[mode][r.c].color), weight: isBad ? 8 : 4, opacity: 1, lineCap: isBad ? 'round' : 'butt',
    }).on('mousemove', e => {
      const i = nearestIndex(e.latlng, r.i0, r.i1);
      showTip(e.originalEvent.clientX, e.originalEvent.clientY, i);
    }).on('mouseout', hideTip).addTo(trackLayer);
  }
}

// Speed view: a circle at every stop, area proportional to how long the train stood.
function stopRadius(z) { return 4 + Math.sqrt((z.t1 - z.t0) / 60) * 2.2; }
function drawStops() {
  stopLayer.clearLayers();
  if (mode !== 'spd') return;
  for (const z of D.stops.slice().sort((a, b) => (b.t1 - b.t0) - (a.t1 - a.t0))) {
    L.circleMarker([D.cols.lat[z.i], D.cols.lon[z.i]], {
      radius: stopRadius(z), color: '#ffffff', weight: 1.5, fillColor: css('--spd0'), fillOpacity: 0.85,
    }).bindTooltip(
      `<b>Stopped ${fmtDur(z.t1 - z.t0)}</b> · ${ist(z.t0)}–${ist(z.t1)} IST<br>` +
      (z.halt ? `${esc(z.halt)} · ${TRAIN.number} halt` : `${esc(z.where)} · unscheduled`),
      { direction: 'top' },
    ).addTo(stopLayer);
  }
}

// Numbered pins on the 10 longest dead zones, matching the table ranks.
function drawDeadZonePins() {
  dzLayer.clearLayers();
  if (mode === 'spd') return;
  const top = D.deadzones.slice().sort((a, b) => b.dur - a.dur).slice(0, 10);
  top.forEach((z, k) => {
    const i = idxAtKm((z.km0 + z.km1) / 2);
    L.marker([D.cols.lat[i], D.cols.lon[i]], {
      icon: L.divIcon({ className: 'dz-pin', html: `${k + 1}`, iconSize: [22, 22] }),
      title: `Dead zone ${k + 1}: ${fmtDur(z.dur)}, ${z.where}`,
      zIndexOffset: 1000 - k,
    }).on('click', () => {
      showAllDead = showAllDead || k >= 10;
      renderDeadZones();
      const tr = document.querySelector(`#dead tr[data-k="${k}"]`);
      zoomTo(idxAtKm(z.km0), idxAtKm(z.km1), tr, false);
    }).addTo(dzLayer);
  });
}

function nearestIndex(ll, i0, i1) {
  let best = i0, bd = Infinity;
  for (let i = i0; i < Math.min(i1 + 1, N); i++) {
    const d = (D.cols.lat[i] - ll.lat) ** 2 + (D.cols.lon[i] - ll.lng) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

function renderLegend() {
  const byTime = mode === 'spd';
  const sh = shares(mode, 0, N, byTime);
  const items = CLASSES[mode].map((c, k) => ({ ...c, share: sh[k] }))
    .filter((c, k) => !(mode === 'inet' && k === UNKNOWN && c.share < 0.005));
  $('#legend').innerHTML = items.map(c =>
    `<span><i class="sw" style="background:var(${c.color})"></i>${c.label} <b>${pct(c.share)}</b></span>`
  ).join('') + `<span style="color:var(--muted)">share of ${byTime ? 'time' : 'distance'}</span>` +
    (mode === 'spd' ? `<span><i class="stop-key"></i>stop ≥ 1 min (size = duration)</span>`
      : `<span><i class="dz-key">1</i>longest dead zones</span>`) +
    `<span><i class="tun-key"></i>tunnel (GPS lost)</span>`;
}

// ---------------------------------------------------------------- tooltip

function showTip(x, y, i) {
  const c = D.cols;
  const inet = c.inet[i];
  const rows = [
    ['Time', ist(c.t[i]) + ' IST'],
    ['Distance', `${c.km[i].toFixed(1)} km`],
    ['Internet', CLASSES.inet[inet ?? UNKNOWN].label + (c.ms[i] != null ? ` · ${c.ms[i]} ms` : '')],
    ['Signal', c.sig[i] === 3 ? 'No service' : `${CLASSES.sig[c.sig[i]].label} · ${c.rsrp[i]} dBm`],
    ['Band', c.band[i] || '–'],
    ['Train speed', c.v[i] < 5 ? 'stopped' : `${c.v[i]} km/h` + (c.interp[i] ? ' (estimated)' : '')],
    ...(c.tun[i] ? [['Location', 'in a tunnel (GPS lost)']] : []),
  ];
  const tip = $('#tip');
  tip.innerHTML = `<div class="h">${esc(between(c.km[i]))}</div>` +
    rows.map(([k, v]) => `<div class="r"><span>${k}</span><b>${esc(v)}</b></div>`).join('');
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(x + 14, innerWidth - w - 8) + 'px';
  tip.style.top = (y + h + 20 > innerHeight ? y - h - 14 : y + 14) + 'px';
  hoverMarker.setLatLng([c.lat[i], c.lon[i]]).setStyle({ color: css('--text') });
  if (!map.hasLayer(hoverMarker)) hoverMarker.addTo(map);
}

function hideTip() {
  $('#tip').hidden = true;
  if (map && map.hasLayer(hoverMarker)) map.removeLayer(hoverMarker);
}

// ---------------------------------------------------------------- route chart

function renderRoute() {
  const el = $('#route');
  const W = el.clientWidth;
  if (!W) return;
  const narrow = W < 600;
  const ml = narrow ? 80 : 88, mr = narrow ? 12 : 44;
  const pw = W - ml - mr;
  const total = D.meta.km;
  const x = k => ml + (k / total) * pw;

  const bandH = 18, gap = 6;
  const yInet = 0, ySig = bandH + gap, ySpd = 2 * (bandH + gap), yTun = 3 * (bandH + gap), tunH = bandH;
  const yStn = yTun + tunH + 8;
  const chartTop = yStn + 44, chartH = narrow ? 150 : 190;
  const H = chartTop + chartH + 26;
  const yMin = -130, yMax = -65;
  const y = v => chartTop + (1 - (Math.max(yMin, Math.min(yMax, v)) - yMin) / (yMax - yMin)) * chartH;

  const parts = [];
  // Bands: merge runs, 1px minimum so short dead spots stay visible.
  for (const [kind, y0, label] of [['inet', yInet, 'Internet'], ['sig', ySig, 'Signal'], ['spd', ySpd, 'Train speed']]) {
    parts.push(`<text class="rowlabel" x="0" y="${y0 + 13}">${label}</text>`);
    for (const r of runs(kind)) {
      const k0 = D.cols.km[r.i0], k1 = D.cols.km[Math.min(r.i1, N - 1)];
      const wpx = Math.max(1, x(k1) - x(k0));
      parts.push(`<rect x="${x(k0).toFixed(1)}" y="${y0}" width="${wpx.toFixed(1)}" height="${bandH}" fill="var(${CLASSES[kind][r.c].color})"/>`);
    }
  }
  // Stops of 2 min or more: red ticks over the speed band (a stop covers ~0 km, so it'd be invisible otherwise).
  for (const z of D.stops) {
    if (z.t1 - z.t0 < 120) continue;
    parts.push(`<rect x="${(x(z.km) - 1.5).toFixed(1)}" y="${ySpd - 2}" width="3" height="${bandH + 4}" rx="1" fill="var(--spd0)" stroke="var(--surface)" stroke-width="1"/>`);
  }
  parts.push(`<text class="rowlabel" x="0" y="${yTun + 13}">Tunnels</text>`);
  parts.push(`<rect x="${ml}" y="${yTun}" width="${pw}" height="${tunH}" fill="var(--grid)"/>`);
  for (const tn of D.tunnels) {
    parts.push(`<rect x="${x(tn.km0).toFixed(1)}" y="${yTun}" width="${Math.max(1.5, x(tn.km1) - x(tn.km0)).toFixed(1)}" height="${tunH}" fill="var(--text)"/>`);
  }
  // Station ticks + non-overlapping labels.
  let lastLabelEnd = -Infinity;
  for (const s of D.stations) {
    const sx = x(s.km);
    if (!isKey(s.name)) continue;
    parts.push(`<line x1="${sx}" x2="${sx}" y1="${yStn - 4}" y2="${chartTop + chartH}" stroke="var(--grid)" stroke-width="1"/>`);
    parts.push(`<line x1="${sx}" x2="${sx}" y1="${yStn - 4}" y2="${yStn + 3}" stroke="var(--text-2)" stroke-width="1.5"/>`);
    // Skip a label if it would collide with the previous one (≈6 px per character).
    const name = s.name.replace(' Road', ' Rd');
    const w = name.length * 6.2;
    const anchor = sx - w / 2 < ml - 10 ? 'start' : sx + w / 2 > ml + pw + mr ? 'end' : 'middle';
    const x0 = anchor === 'start' ? sx : anchor === 'end' ? sx - w : sx - w / 2;
    if (x0 > lastLabelEnd + 8) {
      parts.push(`<text class="stn-label" x="${sx}" y="${yStn + 16}" text-anchor="${anchor}">${esc(name)}</text>`);
      lastLabelEnd = x0 + w;
    }
  }
  // RSRP gridlines and threshold labels.
  for (let v = -70; v >= -130; v -= 10) {
    const thr = v === -100 || v === -110;
    parts.push(`<line x1="${ml}" x2="${ml + pw}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1" ${thr ? 'stroke-dasharray="4 3"' : ''}/>`);
    parts.push(`<text x="${ml - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`);
  }
  parts.push(`<text x="${ml - 8}" y="${chartTop - 10}" text-anchor="end">dBm</text>`);
  for (const [v, t] of [[-82, 'good'], [-105, 'fair'], [-120, 'poor']]) {
    if (!narrow) parts.push(`<text x="${ml + pw + 6}" y="${y(v) + 4}">${t}</text>`);
  }
  // RSRP line, averaged per pixel-ish bin, broken where there was no service.
  const bins = Math.max(50, Math.round(pw / 5));
  const sum = new Float64Array(bins), cnt = new Uint32Array(bins);
  for (let i = 0; i < N; i++) {
    const v = D.cols.rsrp[i];
    if (v == null) continue;
    const b = Math.min(bins - 1, Math.floor((D.cols.km[i] / total) * bins));
    sum[b] += v; cnt[b]++;
  }
  let d = '', pen = false;
  for (let b = 0; b < bins; b++) {
    if (!cnt[b]) { pen = false; continue; }
    const px = ml + ((b + 0.5) / bins) * pw, py = y(sum[b] / cnt[b]);
    d += `${pen ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`;
    pen = true;
  }
  parts.push(`<path d="${d}" fill="none" stroke="var(--line)" stroke-width="1.5" stroke-linejoin="round"/>`);
  // km axis.
  const step = total > 400 ? (narrow ? 200 : 100) : 50;
  for (let k = 0; k <= total; k += step) {
    parts.push(`<text x="${x(k)}" y="${chartTop + chartH + 18}" text-anchor="middle">${k} km</text>`);
  }
  // Crosshair + hit area.
  parts.push(`<line id="xh" y1="0" y2="${chartTop + chartH}" stroke="var(--text)" stroke-width="1" visibility="hidden"/>`);
  parts.push(`<circle id="xd" r="4" fill="var(--line)" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>`);
  parts.push(`<rect id="hit" x="${ml}" y="0" width="${pw}" height="${chartTop + chartH}" fill="transparent"/>`);

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Internet, signal class and RSRP along the route">${parts.join('')}</svg>`;

  const svg = el.querySelector('svg'), xh = svg.querySelector('#xh'), xd = svg.querySelector('#xd');
  const hit = svg.querySelector('#hit');
  const move = (cx, cy) => {
    const r = svg.getBoundingClientRect();
    const k = Math.max(0, Math.min(total, ((cx - r.left - ml) / pw) * total));
    const i = idxAtKm(k);
    const px = x(D.cols.km[i]);
    xh.setAttribute('x1', px); xh.setAttribute('x2', px); xh.setAttribute('visibility', 'visible');
    if (D.cols.rsrp[i] != null) {
      xd.setAttribute('cx', px); xd.setAttribute('cy', y(D.cols.rsrp[i])); xd.setAttribute('visibility', 'visible');
    } else xd.setAttribute('visibility', 'hidden');
    showTip(cx, cy, i);
  };
  hit.addEventListener('pointermove', e => move(e.clientX, e.clientY));
  hit.addEventListener('pointerleave', () => {
    xh.setAttribute('visibility', 'hidden'); xd.setAttribute('visibility', 'hidden'); hideTip();
  });
}

// ---------------------------------------------------------------- tables

function stackBar(sh, kind) {
  return `<div class="bar" aria-hidden="true">` + sh.map((s, k) => s > 0.002
    ? `<i style="width:${(s * 100).toFixed(1)}%;background:var(${CLASSES[kind][k].color})"></i>` : '').join('') + `</div>`;
}

function renderSegments() {
  const km = D.cols.km;
  const rows = [];
  const s = D.stations.filter(st => isKey(st.name));
  for (let j = 0; j + 1 < s.length; j++) {
    const a = s[j], b = s[j + 1];
    const i0 = idxAtKm(a.km), i1 = idxAtKm(b.km);
    if (i1 <= i0) continue;
    const sh = shares('inet', i0, i1);
    const tested = 1 - sh[UNKNOWN];
    const working = tested ? sh[0] / tested : 0;
    const sig = shares('sig', i0, i1);
    rows.push({ a, b, i0, i1, sh, working, nosvc: sig[3], dist: km[i1] - km[i0] });
  }
  $('#segments').innerHTML =
    `<thead><tr><th>Stretch</th><th class="n">km</th><th class="n">Internet</th><th style="width:34%">Internet by distance</th><th class="n">No service</th></tr></thead><tbody>` +
    rows.map((r, k) => `<tr class="click" data-k="${k}">
      <td>${esc(r.a.name)} → ${esc(r.b.name)}</td>
      <td class="n">${r.dist.toFixed(0)}</td>
      <td class="n"><b>${pct(r.working)}</b></td>
      <td>${stackBar(r.sh, 'inet')}</td>
      <td class="n">${r.nosvc >= 0.005 ? pct(r.nosvc) : '–'}</td>
    </tr>`).join('') + '</tbody>';
  $('#segments').querySelectorAll('tr.click').forEach(tr => tr.addEventListener('click', () => {
    const r = rows[tr.dataset.k];
    zoomTo(r.i0, r.i1, tr);
  }));
}

function causeTag(z) {
  const inTunnel = tunnelShare(z.km0, z.km1) >= 0.5;
  const label = inTunnel ? 'tunnel' : z.cause;
  const sw = inTunnel ? '<i class="tun-key"></i>'
    : `<i class="sw" style="background:var(${z.cause === 'no service' ? '--critical' : '--warning'})"></i>`;
  return `<span class="tag">${sw}${esc(label)}</span>`;
}

let showAllDead = false;
function renderDeadZones() {
  const dz = D.deadzones.slice().sort((a, b) => b.dur - a.dur);
  const list = showAllDead ? dz : dz.slice(0, 10);
  $('#dead').innerHTML =
    `<thead><tr><th>#</th><th>Where</th><th class="n">From (IST)</th><th class="n">Duration</th><th class="n">km</th><th>Cause</th></tr></thead><tbody>` +
    list.map((z, k) => `<tr class="click" data-k="${k}">
      <td>${k + 1}</td>
      <td>${esc(z.where)}</td>
      <td class="n">${ist(z.t0 - START)}</td>
      <td class="n"><b>${fmtDur(z.dur)}</b></td>
      <td class="n">${(z.km1 - z.km0).toFixed(1)}</td>
      <td>${causeTag(z)}</td>
    </tr>`).join('') + '</tbody>';
  $('#dead').querySelectorAll('tr.click').forEach(tr => tr.addEventListener('click', () => {
    const z = list[tr.dataset.k];
    zoomTo(idxAtKm(z.km0), idxAtKm(z.km1), tr);
  }));
  const more = $('#more');
  more.hidden = dz.length <= 10;
  more.textContent = showAllDead ? 'Show top 10' : `Show all ${dz.length}`;
  more.onclick = () => { showAllDead = !showAllDead; renderDeadZones(); };
}

function zoomTo(i0, i1, tr, scroll = true) {
  document.querySelectorAll('tr.sel').forEach(r => r.classList.remove('sel'));
  if (tr) tr.classList.add('sel');
  const ll = [];
  for (let i = Math.max(0, i0 - 3); i <= Math.min(N - 1, i1 + 3); i++) ll.push([D.cols.lat[i], D.cols.lon[i]]);
  if (scroll) $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' });
  map.fitBounds(ll, { padding: [40, 40], maxZoom: 14 });
}

// ---------------------------------------------------------------- speed vs internet

// For each speed band: time spent, and how the internet behaved (time-weighted, tested samples only).
function renderSpeedChart() {
  const bins = CLASSES.spd.map(() => ({ time: 0, inet: [0, 0, 0] }));
  for (let i = 0; i < N; i++) {
    const b = bins[cls('spd', i)], w = dt(i);
    b.time += w;
    const n = D.cols.inet[i];
    if (n != null) b.inet[n] += w;
  }
  const total = bins.reduce((a, b) => a + b.time, 0);
  $('#speedchart').innerHTML =
    `<thead><tr><th>Train speed</th><th class="n">Time</th><th class="n">Internet</th><th style="width:45%">Internet by time</th></tr></thead><tbody>` +
    bins.map((b, k) => {
      const tested = b.inet[0] + b.inet[1] + b.inet[2];
      const sh = tested ? b.inet.map(x => x / tested) : [0, 0, 0];
      return `<tr>
        <td><span class="tag"><i class="sw" style="background:var(${CLASSES.spd[k].color})"></i>${k === 0 ? 'Stopped <span class="muted">(&lt; 5 km/h)</span>' : CLASSES.spd[k].label.replace(' km/h', '') + ' km/h'}</span></td>
        <td class="n">${fmtDur(b.time)} <span class="muted">(${pct(b.time / total)})</span></td>
        <td class="n"><b>${tested ? pct(sh[0]) : '–'}</b></td>
        <td>${stackBar(sh, 'inet')}</td>
      </tr>`;
    }).join('') + '</tbody>';
  const halts = D.stops.filter(z => z.halt), other = D.stops.filter(z => !z.halt);
  const sum = a => fmtDur(a.reduce((x, z) => x + z.t1 - z.t0, 0));
  $('#stopsummary').textContent =
    `${D.stops.length} stops of a minute or more: ${halts.length} at ${TRAIN.number} halts (${sum(halts)}) ` +
    `and ${other.length} unscheduled (${sum(other)}). Switch the map to Train speed to see them.`;
}
