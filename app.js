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
};
const UNKNOWN = 3;  // index used for inet === null
// Main stations: used for map labels, chart labels and the station-to-station table.
const MAJOR = new Set(['Madgaon', 'Thivim', 'Sawantwadi Road', 'Kudal', 'Kankavli', 'Vaibhavwadi Road',
  'Rajapur Road', 'Ratnagiri', 'Sangameshwar Road', 'Chiplun', 'Khed', 'Veer', 'Mangaon', 'Roha', 'Pen', 'Panvel', 'Nilaje']);

const $ = s => document.querySelector(s);
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const pct = x => (x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0) + '%';
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let D, N, START, mode = 'inet';
let map, trackLayer, hoverMarker;

fetch('data/trip.json')
  .then(r => r.json())
  .then(init)
  .catch(err => { $('#sub').textContent = 'Could not load data/trip.json: ' + err.message; });

// ---------------------------------------------------------------- helpers

function cls(kind, i) {
  if (kind === 'inet') return D.cols.inet[i] ?? UNKNOWN;
  return D.cols.sig[i];
}

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

// Distance-weighted share of each class within [i0, i1).
function shares(kind, i0 = 0, i1 = N) {
  const w = [0, 0, 0, 0];
  for (let i = i0; i < i1; i++) w[cls(kind, i)] += seg(i);
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
function runs(kind) {
  const out = [];
  let start = 0;
  for (let i = 1; i <= N; i++) {
    if (i === N || cls(kind, i) !== cls(kind, start)) {
      out.push({ i0: start, i1: i, c: cls(kind, start) });
      start = i;
    }
  }
  return out;
}

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
  const m = D.meta;
  const date = new Date(m.start * 1000).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric',
  });
  $('#sub').textContent =
    `${m.origin} → ${m.destination} · ${date} · ${Math.round(m.km)} km in ${fmtDur(m.end - m.start)} ` +
    `(${ist(0)}–${ist(m.end - m.start)} IST${dayDiff(m) ? ', next day' : ''}) · ${m.samples.toLocaleString('en-IN')} measurements`;

  renderKpis();
  initMap();
  renderLegend();
  renderRoute();
  renderSegments();
  renderDeadZones();

  document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === b));
    mode = b.dataset.mode;
    drawTrack();
    renderLegend();
  }));
  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(renderRoute, 150); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    drawTrack(); renderLegend(); renderRoute(); renderSegments(); renderDeadZones();
  });
}

// ---------------------------------------------------------------- KPIs

function renderKpis() {
  const inetTested = shares('inet');
  const testedTot = 1 - inetTested[UNKNOWN];
  const working = (inetTested[0] + inetTested[1]) / (testedTot || 1);
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
    [`${median(pings)} ms`, 'median ping when connected', `90th percentile ${pings.sort((a, b) => a - b)[Math.floor(pings.length * 0.9)]} ms`],
    [`${loss.toFixed(1)}%`, 'packet loss when connected', `${pings.length.toLocaleString('en-IN')} ping tests`],
  ];
  $('#kpis').innerHTML = tiles.map(([v, l, d]) =>
    `<div class="kpi"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div><div class="d">${esc(d)}</div></div>`
  ).join('');
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
  L.control.layers(base, null, { position: 'topright' }).addTo(map);
  map.on('click', () => map.scrollWheelZoom.enable());
  // The canvas renderer needs a view before any vector layer is added.
  map.fitBounds(D.cols.lat.map((la, i) => [la, D.cols.lon[i]]), { padding: [20, 20] });

  trackLayer = L.layerGroup().addTo(map);
  drawTrack();

  const labelled = new Set(['Madgaon', 'Thivim', 'Kudal', 'Kankavli', 'Ratnagiri', 'Chiplun', 'Khed', 'Roha', 'Panvel']);
  for (const s of D.stations) {
    L.circleMarker([s.lat, s.lon], {
      radius: MAJOR.has(s.name) ? 4 : 2.5, color: '#1a1a19', weight: 1.5, fillColor: '#ffffff', fillOpacity: 1,
    }).bindTooltip(s.name, {
      className: 'stn', permanent: labelled.has(s.name), direction: 'right', offset: [6, 0],
    }).addTo(map);
  }
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
  L.polyline(coords(0, N - 1), { color: css('--casing'), weight: 9, opacity: 0.9, interactive: false }).addTo(trackLayer);
  for (const r of runs(mode)) {
    L.polyline(coords(r.i0, r.i1), {
      color: css(CLASSES[mode][r.c].color), weight: 5, opacity: 1, lineCap: 'butt',
    }).on('mousemove', e => {
      const i = nearestIndex(e.latlng, r.i0, r.i1);
      showTip(e.originalEvent.clientX, e.originalEvent.clientY, i);
    }).on('mouseout', hideTip).addTo(trackLayer);
  }
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
  const sh = shares(mode);
  const items = CLASSES[mode].map((c, k) => ({ ...c, share: sh[k] }))
    .filter((c, k) => !(mode === 'inet' && k === UNKNOWN && c.share < 0.005));
  $('#legend').innerHTML = items.map(c =>
    `<span><i class="sw" style="background:var(${c.color})"></i>${c.label} <b>${pct(c.share)}</b></span>`
  ).join('') + `<span style="color:var(--muted)">share of distance</span>`;
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
    ['Speed', c.spd[i] != null ? `${c.spd[i]} km/h` : (c.interp[i] ? 'no GPS (tunnel?)' : '–')],
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
  const ml = narrow ? 64 : 78, mr = narrow ? 12 : 44;
  const pw = W - ml - mr;
  const total = D.meta.km;
  const x = k => ml + (k / total) * pw;

  const bandH = 18, gap = 6;
  const yInet = 0, ySig = bandH + gap;
  const yStn = ySig + bandH + 8;
  const chartTop = yStn + 44, chartH = narrow ? 150 : 190;
  const H = chartTop + chartH + 26;
  const yMin = -130, yMax = -65;
  const y = v => chartTop + (1 - (Math.max(yMin, Math.min(yMax, v)) - yMin) / (yMax - yMin)) * chartH;

  const parts = [];
  // Bands: merge runs, 1px minimum so short dead spots stay visible.
  for (const [kind, y0, label] of [['inet', yInet, 'Internet'], ['sig', ySig, 'Signal']]) {
    parts.push(`<text class="rowlabel" x="0" y="${y0 + 13}">${label}</text>`);
    for (const r of runs(kind)) {
      const k0 = D.cols.km[r.i0], k1 = D.cols.km[Math.min(r.i1, N - 1)];
      const wpx = Math.max(1, x(k1) - x(k0));
      parts.push(`<rect x="${x(k0).toFixed(1)}" y="${y0}" width="${wpx.toFixed(1)}" height="${bandH}" fill="var(${CLASSES[kind][r.c].color})"/>`);
    }
  }
  // Station ticks + non-overlapping labels.
  let lastLabelEnd = -Infinity;
  for (const s of D.stations.filter(s => MAJOR.has(s.name))) {
    const sx = x(s.km);
    parts.push(`<line x1="${sx}" x2="${sx}" y1="${yStn - 4}" y2="${chartTop + chartH}" stroke="var(--grid)" stroke-width="1"/>`);
    parts.push(`<line x1="${sx}" x2="${sx}" y1="${yStn - 4}" y2="${yStn + 2}" stroke="var(--muted)" stroke-width="1"/>`);
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
  const s = D.stations.filter(st => MAJOR.has(st.name));
  for (let j = 0; j + 1 < s.length; j++) {
    const a = s[j], b = s[j + 1];
    const i0 = idxAtKm(a.km), i1 = idxAtKm(b.km);
    if (i1 <= i0) continue;
    const sh = shares('inet', i0, i1);
    const tested = 1 - sh[UNKNOWN];
    const working = tested ? (sh[0] + sh[1]) / tested : 0;
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
      <td><span class="tag"><i class="sw" style="background:var(${z.cause === 'no service' ? '--critical' : '--warning'})"></i>${esc(z.cause)}</span></td>
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

function zoomTo(i0, i1, tr) {
  document.querySelectorAll('tr.sel').forEach(r => r.classList.remove('sel'));
  tr.classList.add('sel');
  const ll = [];
  for (let i = Math.max(0, i0 - 3); i <= Math.min(N - 1, i1 + 3); i++) ll.push([D.cols.lat[i], D.cols.lon[i]]);
  $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' });
  map.fitBounds(ll, { padding: [40, 40], maxZoom: 14 });
}
