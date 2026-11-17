// ui.js — DOM, animation loop, explanations and language switch.
// All physiology lives in model.js; all text lives in i18n.js.
import * as M from './model.js';
import { LineChart } from './charts.js';
import { DICT, LANGS } from './i18n.js';

const DT = 0.02; // years per step (≈ 1 week)
const $ = (id) => document.getElementById(id);
const ULN = M.DEFAULTS.PTH_ULN;

// ---------------------------------------------------------------- language
let lang = pickLang();
function pickLang() {
  const q = new URLSearchParams(location.search).get('lang');
  if (q && DICT[q]) return q;
  try { const s = localStorage.getItem('mbd-lang'); if (s && DICT[s]) return s; } catch { /* storage unavailable */ }
  return (navigator.language || 'es').toLowerCase().startsWith('es') ? 'es' : 'en';
}
const T = (key, args) => { const v = DICT[lang][key] ?? DICT.es[key] ?? key; return typeof v === 'function' ? v(args || {}) : v; };
const nf = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString(LANGS[lang], { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
const big = (v) => nf(v, v < 10 ? 1 : 0);

function updateUrl() {
  const url = new URL(location.href);
  url.searchParams.set('lang', lang);
  if (activePreset) url.searchParams.set('preset', activePreset); else url.searchParams.delete('preset');
  history.replaceState(null, '', url);
}

function setLang(l) {
  lang = l;
  try { localStorage.setItem('mbd-lang', l); } catch { /* ignore */ }
  updateUrl(); applyStaticText(); setupCharts(); syncControls(); renderLog(); setPlaying(playing);
  $('cycle').replaceChildren();
  render(true);
}

function applyStaticText() {
  document.documentElement.lang = lang;
  document.title = T('doc.title');
  document.querySelector('meta[name="description"]').setAttribute('content', T('doc.desc'));
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.innerHTML = T(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', T(el.dataset.i18nAria)));
  $('normals-list').innerHTML = T('normals.list').map((li) => `<li>${li}</li>`).join('');
  document.querySelectorAll('[data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
  document.querySelectorAll('.btn.preset').forEach((b) => { b.textContent = T(`p.${b.dataset.key}`); });
  $('btn-link').textContent = T('deeplink');
  if (A.svg) { A.svg.setAttribute('aria-label', T('g.aria')); A.static.forEach(([el, key]) => { el.textContent = T(key); }); }
}

// ---------------------------------------------------------------- state
const ui = { speed: 1, horizon: 15, showCf: true };
let params = { ...M.DEFAULTS };
let cfP = { ...M.DEFAULTS, ...M.NO_TREATMENT };
let state, cfState, hist, cfHist, playing = false, treatedEver = false;
let activePreset = null, pendingEvents = [], prev = null, logEntries = [];

// ---------------------------------------------------------------- controls
const SLIDERS = [
  { id: 's-slope', key: 'slope', out: 'o-slope', label: 'name.slope', fmt: (v) => `${nf(v, 1)} mL/min${T('u.peryear')}` },
  { id: 's-vitd', key: 'vitD25', out: 'o-vitd', label: 'name.vitD25', fmt: (v) => `${nf(v)} ng/mL` },
  { id: 'a-egfr0', key: 'egfr0', out: 'o-egfr0', label: 'a.egfr0', fmt: (v) => `${nf(v)} mL/min`, resets: true },
  { id: 'a-pIntake', key: 'pIntake', out: 'o-pIntake', label: 'a.pIntake', fmt: (v) => `${nf(v)} ${T('u.mgday')}` },
  { id: 'a-binder', key: 'binderEffect', out: 'o-binder', label: 'a.binder', fmt: (v) => `−${nf(v * 100)} %` },
  { id: 'a-kH', key: 'kHyperplasia', out: 'o-kH', label: 'a.kH', fmt: (v) => `${nf(v, 2)}${T('u.peryear')}` },
  { id: 'a-kCalc', key: 'kCalc', out: 'o-kCalc', label: 'a.kCalc', fmt: (v) => `${nf(v, 2)}${T('u.peryear')}` },
];
const UI_SLIDERS = [
  { id: 's-speed', key: 'speed', out: 'o-speed', fmt: (v) => `${nf(v, 2)} ${T('u.yps')}` },
  { id: 'a-horizon', key: 'horizon', out: 'o-horizon', fmt: (v) => `${nf(v)} ${T('u.years')}` },
];
const TOGGLES = [...M.TREATMENTS, 'dialysis'];

function syncControls() {
  for (const s of SLIDERS) { $(s.id).value = params[s.key]; $(s.out).textContent = s.fmt(params[s.key]); }
  for (const s of UI_SLIDERS) { $(s.id).value = ui[s.key]; $(s.out).textContent = s.fmt(ui[s.key]); }
  for (const k of TOGGLES) $(`t-${k}`).checked = !!params[k];
  $('t-cf').checked = ui.showCf;
  document.querySelectorAll('.btn.preset').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.key === activePreset)));
  $('preset-expect').innerHTML = activePreset ? `${T('expected')} ${T(`pe.${activePreset}`)}` : '';
  $('btn-link').hidden = !activePreset;
}

function setupControls() {
  for (const s of SLIDERS) {
    let before = null;
    $(s.id).addEventListener('input', (e) => {
      if (!before) before = state;
      params = { ...params, [s.key]: +e.target.value };
      cfP = { ...cfP, [s.key]: +e.target.value };
      $(s.out).textContent = s.fmt(params[s.key]);
      if (s.resets) { clearPreset(); reset(); before = null; return; }
      apply({}, {}, null);
    });
    $(s.id).addEventListener('change', () => {
      if (s.resets || !before) { before = null; return; }
      const b = before, a = state, v = params[s.key];
      before = null; clearPreset();
      addLog(a.t, () => T('log.change', { what: `${T(s.label)} → ${s.fmt(v)}`, p0: nf(b.PTH), p1: nf(a.PTH), c0: nf(b.Ca, 1), c1: nf(a.Ca, 1) }));
    });
  }
  for (const s of UI_SLIDERS) {
    $(s.id).addEventListener('input', (e) => {
      ui[s.key] = +e.target.value; $(s.out).textContent = s.fmt(ui[s.key]);
      if (s.key === 'horizon') { setPlaying(playing); render(true); }
    });
  }
  for (const k of TOGGLES) {
    $(`t-${k}`).addEventListener('change', (e) => { pendingEvents = []; clearPreset(); act({ [k]: e.target.checked }); });
  }
  $('btn-tx').addEventListener('click', () => { pendingEvents = []; clearPreset(); act({ dialysis: false, slope: 1, egfr: 60 }); });
  $('btn-ptx').addEventListener('click', () => { pendingEvents = []; clearPreset(); act({ G: 0.15, ptx: true }); });
  $('t-cf').addEventListener('change', (e) => { ui.showCf = e.target.checked; render(true); });
  $('btn-play').addEventListener('click', () => setPlaying(!playing));
  $('btn-reset').addEventListener('click', () => { if (activePreset) loadPreset(activePreset, false); else reset(); });
  $('btn-defaults').addEventListener('click', () => {
    const keep = Object.fromEntries([...TOGGLES, 'slope', 'vitD25', 'egfr0', 'ptx'].map((k) => [k, params[k]]));
    params = { ...M.DEFAULTS, ...keep };
    cfP = { ...cfP, ...Object.fromEntries(Object.keys(M.DEFAULTS).filter((k) => !(k in keep) && !TOGGLES.includes(k)).map((k) => [k, M.DEFAULTS[k]])) };
    ui.horizon = 15; syncControls(); apply({}, {}, () => T('log.defaults'));
  });
  $('btn-link').addEventListener('click', async () => {
    const url = new URL(location.href); url.searchParams.set('preset', activePreset); url.searchParams.set('lang', lang);
    try { await navigator.clipboard.writeText(url.toString()); $('btn-link').textContent = T('copied'); } catch { /* clipboard unavailable */ }
    setTimeout(() => { $('btn-link').textContent = T('deeplink'); }, 1500);
  });
  const row = $('presets');
  for (const key of Object.keys(M.PRESETS)) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn preset'; b.dataset.key = key;
    b.addEventListener('click', () => loadPreset(key));
    row.appendChild(b);
  }
  document.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select, button, summary')) return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); }
  });
}

function clearPreset() { if (activePreset) { activePreset = null; syncControls(); updateUrl(); } }

function describeSet(set) {
  const parts = [];
  if ('egfr' in set) parts.push(T('name.tx'));
  if ('G' in set) parts.push(T('name.ptx'));
  for (const [k, v] of Object.entries(set)) {
    if (['egfr', 'G', 'ptx', 'slope'].includes(k)) continue;
    if (typeof v === 'boolean') parts.push(`${T(`name.${k}`)} ${T(v ? 'on' : 'off')}`);
  }
  return parts.join(', ');
}

function loadPreset(key, autoplay = true) {
  const pr = M.PRESETS[key];
  const keepAdv = { pIntake: params.pIntake, binderEffect: params.binderEffect, kHyperplasia: params.kHyperplasia, kCalc: params.kCalc };
  params = { ...M.DEFAULTS, ...keepAdv, ...pr.params };
  cfP = { ...params, ...M.NO_TREATMENT };
  activePreset = key;
  syncControls(); reset();
  pendingEvents = (pr.events || []).map((e) => ({ ...e }));
  for (const ev of pendingEvents) addLog(0, () => T('log.scheduled', { what: describeSet(ev.set), t: nf(ev.t, 1) }));
  updateUrl(); setPlaying(autoplay);
}

function setPlaying(on) {
  const done = state.t >= ui.horizon - 1e-9;
  playing = on && !done;
  const b = $('btn-play');
  b.textContent = playing ? T('pause') : (done ? T('end') : T('play'));
  b.setAttribute('aria-pressed', String(playing));
}

// ---------------------------------------------------------------- simulation
function reset() {
  cfP = { ...params, ...M.NO_TREATMENT };
  state = M.initialState(params);
  cfState = M.initialState(cfP);
  hist = [state]; cfHist = [cfState];
  treatedEver = M.TREATMENTS.some((k) => params[k]);
  pendingEvents = [];
  prev = { stage: state.stage, hyperP: state.P > 4.5, ca: caStatus(state), pthBand: pthBand(state), fgf: state.FGF23 > 100, bone: state.bone, calc: calcBand(state) };
  logEntries = [];
  const s0 = state;
  addLog(0, () => T('log.start', { e: nf(s0.egfr), p: nf(s0.P, 1), ca: nf(s0.Ca, 1), pth: nf(s0.PTH) }));
  setPlaying(false); render(true);
}
const caStatus = (s) => (s.Ca < 8.5 ? 'low' : s.Ca > 10.2 ? 'high' : 'ok');
const pthBand = (s) => (s.PTH > 9 * ULN ? 9 : s.PTH > 2 * ULN ? 2 : 0);
const calcBand = (s) => (s.cac >= 50 ? 50 : s.cac >= 25 ? 25 : s.cac >= 10 ? 10 : 0);

/** Apply param changes (`set`) and state overrides (egfr, G) at the current time; vessels/hormones respond at once. */
function apply(set, stateSet, what) {
  const before = state;
  params = { ...params, ...set };
  const cfSet = Object.fromEntries(Object.entries(set).filter(([k]) => !M.TREATMENTS.includes(k) && k !== 'ptx'));
  cfP = { ...cfP, ...cfSet };
  if (M.TREATMENTS.some((k) => set[k])) treatedEver = true;
  state = M.observe(state.t, stateSet.egfr ?? state.egfr, stateSet.G ?? state.G, state.cac, params);
  cfState = M.observe(cfState.t, stateSet.egfr ?? cfState.egfr, cfState.G, cfState.cac, cfP);
  hist.push(state); cfHist.push(cfState);
  if (what) { const a = state; addLog(a.t, () => T('log.change', { what: what(), p0: nf(before.PTH), p1: nf(a.PTH), c0: nf(before.Ca, 1), c1: nf(a.Ca, 1) }), 'tx'); }
  syncControls(); checkTransitions(); render(true);
}
function act(set) {
  const { params: ps, state: st } = M.splitSet(set);
  apply(ps, st, () => describeSet(set));
}

function stepOnce() {
  for (const ev of pendingEvents) {
    if (ev.done || state.t < ev.t - 1e-9) continue;
    ev.done = true;
    act(ev.set);
  }
  state = M.step(state, params, DT);
  cfState = M.step(cfState, cfP, DT);
  hist.push(state); cfHist.push(cfState);
  checkTransitions();
}

function checkTransitions() {
  const s = state;
  if (s.stage !== prev.stage) { const a = prev.stage, b = s.stage; addLog(s.t, () => T('log.stage', { a, b })); }
  const hp = s.P > 4.5;
  if (hp !== prev.hyperP) { const p = s.P, e = s.egfr; addLog(s.t, hp ? () => T('log.hyperP', { p: nf(p, 1), e: nf(e) }) : () => T('log.hyperPEnd', { p: nf(p, 1) }), hp ? 'warn' : 'tx'); }
  const cs = caStatus(s);
  if (cs !== prev.ca) { const c = s.Ca; addLog(s.t, () => T(cs === 'low' ? 'log.hypoCa' : cs === 'high' ? 'log.hyperCa' : 'log.caOk', { c: nf(c, 1) }), cs === 'ok' ? 'tx' : 'warn'); }
  const pb = pthBand(s);
  if (pb > prev.pthBand) addLog(s.t, () => T('log.pth', { x: pb }), 'warn');
  if (!prev.fgf && s.FGF23 > 100 && s.P <= 4.5) addLog(s.t, () => T('log.fgf'));
  if (s.bone !== prev.bone) { const b = s.bone; addLog(s.t, () => T('log.bone', { b: T(`bone.${b}`) }), b === 'normal' ? 'tx' : 'warn'); }
  const cb = calcBand(s);
  if (cb > prev.calc) { const c = s.cac; addLog(s.t, () => T('log.calc', { c: nf(c) }), 'warn'); }
  prev = { stage: s.stage, hyperP: hp, ca: cs, pthBand: Math.max(prev.pthBand, pb), fgf: prev.fgf || s.FGF23 > 100, bone: s.bone, calc: Math.max(prev.calc, cb) };
}

function addLog(t, make, cls = '') { logEntries.push({ t, make, cls }); $('log').prepend(logItem(logEntries.at(-1))); }
function logItem(e) {
  const li = document.createElement('li');
  if (e.cls) li.className = e.cls;
  li.innerHTML = `<b>${T('log.year', { t: nf(e.t, 1) })}</b> · ${e.make()}`;
  return li;
}
function renderLog() { $('log').replaceChildren(...logEntries.slice().reverse().map(logItem)); }

// ---------------------------------------------------------------- axis schematic
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};
const A = {};
function organ(x, y, w, h, key) {
  const g = svgEl('g', { class: 'organ' }, A.svg);
  svgEl('rect', { x, y, width: w, height: h, rx: 12, class: 'box' }, g);
  const t = svgEl('text', { x: x + 12, y: y + 22, class: 'title' }, g);
  A.static.push([t, key]);
  return { g, x, y, w, h, val: (i) => svgEl('text', { x: x + 12, y: y + 42 + i * 17, class: 'val' }, g) };
}
function arrow(d, labelXY, anchor = 'middle') {
  const path = svgEl('path', { d, class: 'axis-arrow flat', 'marker-end': 'url(#ah)' }, A.svg);
  const label = svgEl('text', { x: labelXY[0], y: labelXY[1], 'text-anchor': anchor, class: 'arrow-label flat' }, A.svg);
  return { path, label };
}
function buildSchematic() {
  A.svg = svgEl('svg', { viewBox: '0 0 640 430', role: 'img' });
  A.static = [];
  $('axis').appendChild(A.svg);
  const defs = svgEl('defs', {}, A.svg);
  const mk = svgEl('marker', { id: 'ah', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 12, markerHeight: 12, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' }, defs);
  svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'var(--muted)' }, mk);
  // organs
  A.pth = organ(230, 8, 180, 92, 'o.pth');
  A.glands = [[282, 70], [358, 70], [282, 88], [358, 88]].map(([cx, cy]) => svgEl('ellipse', { cx, cy, rx: 10, ry: 7, class: 'gland' }, A.pth.g));
  A.pthSize = svgEl('text', { x: 320, y: 50, 'text-anchor': 'middle', class: 'val' }, A.pth.g);
  A.kid = organ(10, 160, 180, 120, 'o.kidney'); A.kidEgfr = A.kid.val(0); A.kidHyd = A.kid.val(1); A.kidFep = A.kid.val(2);
  A.bone = organ(450, 160, 180, 120, 'o.bone'); A.boneTag = svgEl('text', { x: 462, y: 210, class: 'bone-tag normal' }, A.bone.g); A.boneFgf = A.bone.val(2);
  A.blood = organ(250, 175, 140, 90, 'o.blood'); A.bP = A.blood.val(0); A.bCa = A.blood.val(1); A.bCaxP = A.blood.val(2);
  A.gut = organ(10, 330, 180, 90, 'o.gut'); A.gutAbs = A.gut.val(0); A.gutTxt = A.gut.val(1);
  A.ves = organ(450, 330, 180, 90, 'o.vessel'); A.vesTxt = A.ves.val(0);
  A.vWall = svgEl('circle', { cx: 590, cy: 385, r: 26, class: 'vessel-wall' }, A.ves.g);
  A.vCalc = svgEl('circle', { cx: 590, cy: 385, r: 22, class: 'vessel-calc', 'stroke-width': 0 }, A.ves.g);
  A.vLumen = svgEl('circle', { cx: 590, cy: 385, r: 16, class: 'vessel-lumen' }, A.ves.g);
  A.static.push([A.gutTxt, 'o.absorb']);
  // hormone arrows
  A.aFGF = arrow('M450,195 C400,140 240,140 190,195', [262, 140]);       // bone → kidney: FGF23
  A.aCalPTH = arrow('M150,160 C170,110 210,70 228,60', [128, 112], 'start'); // kidney → parathyroid: calcitriol (−)
  A.aCalGut = arrow('M100,280 L100,328', [108, 308], 'start');               // kidney → gut: calcitriol
  A.aPTHbone = arrow('M412,60 C470,80 520,120 540,158', [486, 98], 'start');  // parathyroid → bone: PTH
  A.aGutBlood = arrow('M190,370 C240,370 280,320 300,267', [222, 330]);     // gut → blood: Ca, P absorption
  A.aBloodVes = arrow('M360,267 C380,320 420,370 448,372', [415, 318]);     // blood → vessel: Ca×P
  A.aBloodPTH = arrow('M350,175 L350,104', [358, 140], 'start');            // blood → parathyroid: Ca, P stimulus
}

function setArrow(a, ratio, text, invert = false) {
  const lr = Math.log(Math.max(1e-3, ratio));
  const dir = Math.abs(lr) < 0.1 ? 'flat' : (lr > 0) !== invert ? 'up' : 'down';
  const w = Math.min(10, 2 + 2.2 * Math.abs(lr));
  a.path.setAttribute('class', `axis-arrow ${dir}`);
  a.path.setAttribute('stroke-width', w.toFixed(1));
  a.label.setAttribute('class', `arrow-label ${dir}`);
  a.label.textContent = text;
}

function drawSchematic(s) {
  const fgfR = s.FGF23 / 50, calR = s.calcitriol / 40, pthR = s.PTH / 40;
  setArrow(A.aFGF, fgfR, `FGF23 ×${big(fgfR)}`);
  setArrow(A.aCalPTH, calR, `calcitriol ${nf(s.calcitriol)}`);
  setArrow(A.aCalGut, calR, `${nf(s.calcitriol)} pg/mL`);
  setArrow(A.aPTHbone, pthR, `PTH ${nf(s.PTH)}`);
  setArrow(A.aGutBlood, s.caBase > 0 ? Math.exp(s.caBase - 9.5) : 1, '');
  setArrow(A.aBloodVes, s.CaxP / 33, `Ca×P ${nf(s.CaxP)}`);
  setArrow(A.aBloodPTH, s.pthNeeded / 40, '');
  A.kidEgfr.textContent = `${T('o.gfr')} ${nf(s.egfr)} · ${s.stage}${s.dialysis ? ` · ${T('o.hd')}` : ''}`;
  A.kidHyd.textContent = `${T('o.hydrox')} ${nf(100 * Math.min(1, s.calcitriolEndo / 40))} %`;
  A.kidFep.textContent = `${T('o.phosphaturia')} ${nf(s.fep * 100)} %`;
  A.boneTag.textContent = T(`boneShort.${s.bone}`);
  A.boneTag.setAttribute('class', `bone-tag ${s.bone}`);
  A.boneFgf.textContent = `FGF23 ${nf(s.FGF23)} RU/mL`;
  A.bP.textContent = `P ${nf(s.P, 1)} mg/dL`; A.bCa.textContent = `Ca ${nf(s.Ca, 1)} mg/dL`; A.bCaxP.textContent = `Ca×P ${nf(s.CaxP)}`;
  A.gutAbs.textContent = `Ca ${s.caBase >= 9.4 ? '≈' : '↓'} · P ${nf(s.load)} ${T('u.mgday')}`;
  A.vesTxt.textContent = T('o.calc', { v: nf(s.cac) });
  const r = Math.min(2.2, Math.max(0.3, Math.sqrt(s.G)));
  A.glands.forEach((g) => { g.setAttribute('rx', (8 * r).toFixed(1)); g.setAttribute('ry', (5.5 * r).toFixed(1)); g.setAttribute('class', `gland ${s.G > 1.5 ? 'big' : ''}`); });
  A.pthSize.textContent = T('o.size', { v: nf(s.G, 1) });
  A.vCalc.setAttribute('stroke-width', (s.cac / 100 * 8).toFixed(1));
}

// ---------------------------------------------------------------- explanations
function renderCycle(s) {
  const tertiary = s.Ca > 10.2 && s.ratio > 1.3;
  const items = [
    [s.egfr < 60, T('cy.1', { e: nf(s.egfr) })],
    [s.FGF23 > 75, T('cy.2', { f: big(s.FGF23 / 50), fep: nf(s.fep * 100) })],
    [s.calcitriolEndo < 32, T('cy.3', { c: nf(s.calcitriol) })],
    [s.caBase < 9.2 && s.Ca < 9.4, T('cy.4', { ca: nf(s.Ca, 1) })],
    [s.PTH > ULN, T(tertiary ? 'cy.5t' : 'cy.5', { p: nf(s.PTH), x: nf(s.PTH / ULN, 1), ca: nf(s.Ca, 1) })],
    [s.P > 4.5, T('cy.6', { p: nf(s.P, 1) })],
    [s.G > 1.3, T('cy.7', { g: nf(s.G, 1) })],
    [s.bone !== 'normal' || s.cac > 5, T('cy.8', { b: T(`bone.${s.bone}`), c: nf(s.cac) })],
  ];
  const ol = $('cycle');
  if (!ol.children.length) items.forEach(() => ol.appendChild(document.createElement('li')));
  items.forEach(([on, html], i) => { const li = ol.children[i]; li.classList.toggle('on', on); if (li.innerHTML !== html) li.innerHTML = html; });
  const parts = [];
  if (params.binderCa || params.caSupplement) parts.push(T('tn.binderCa'));
  if (params.calcitriol) parts.push(T('tn.calcitriol'));
  if (params.calcimimetic) parts.push(T('tn.calcimimetic'));
  if (params.binderNonCa || params.dietP) parts.push(T('tn.binderNonCa'));
  if (params.colecalciferol) parts.push(T('tn.colecalciferol'));
  if (params.dialysis) parts.push(T('tn.dialysis'));
  if (tertiary) parts.push(T('tn.tertiary'));
  const tn = $('treat-note');
  tn.hidden = !parts.length;
  const html = parts.map((p) => `<p>${p}</p>`).join('');
  if (tn.innerHTML !== html) tn.innerHTML = html;
}

function renderTiles(s) {
  const tiles = [
    [T('tile.egfr'), `${nf(s.egfr)}<small>mL/min</small>`, `<span class="stage-chip st-${s.stage}">${s.stage}</span>${s.dialysis ? ` ${T('tile.dialysis')}` : ''}`],
    [T('tile.P'), `${nf(s.P, 1)}<small>mg/dL</small>`, chip(s.P, 2.5, 4.5)],
    [T('tile.Ca'), `${nf(s.Ca, 1)}<small>mg/dL</small>`, chip(s.Ca, 8.5, 10.2)],
    [T('tile.PTH'), `${nf(s.PTH)}<small>pg/mL</small>`, T('tile.uln', { v: nf(s.PTH / ULN, 1) })],
    [T('tile.FGF23'), `${nf(s.FGF23)}<small>RU/mL</small>`, T('tile.xnorm', { v: big(s.FGF23 / 50) })],
    [T('tile.cal'), `${nf(s.calcitriol)}<small>pg/mL</small>`, T('tile.xnorm', { v: nf(s.calcitriol / 40, 2) })],
    [T('tile.cac'), `${nf(s.cac)}<small>/100</small>`, `Ca×P ${nf(s.CaxP)}`],
    [T('tile.bone'), `<span style="font-size:1rem">${T(`boneShort.${s.bone}`)}</span>`, T(`boneSub.${s.bone}`)],
  ];
  $('tiles').innerHTML = tiles.map(([k, v, d]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join('');
}
const chip = (v, lo, hi) => { const st = v < lo ? 'low' : v > hi ? 'high' : 'ok'; return `<span class="st ${st}">${T(`st.${st}`)}</span>`; };

function renderTargets(s) {
  const vitD = params.colecalciferol ? Math.max(params.vitD25, 35) : params.vitD25;
  const pthLo = s.dialysis ? 130 : 0, pthHi = s.dialysis ? 585 : ULN * 2;
  const rows = [
    [T('tg.P'), nf(s.P, 1), T('tg.P.t'), chip(s.P, 2.5, 4.5)],
    [T('tg.Ca'), nf(s.Ca, 1), T('tg.Ca.t'), chip(s.Ca, 8.5, 10.2)],
    [T('tg.PTH'), nf(s.PTH), s.dialysis ? T('tg.PTH.tD') : T('tg.PTH.tN'), s.dialysis ? chip(s.PTH, pthLo, pthHi) : chip(s.PTH, 0, s.egfr < 30 ? ULN * 4 : ULN * 2)],
    [T('tg.D'), nf(vitD), T('tg.D.t'), chip(vitD, 30, 1e9)],
    [T('tg.CaxP'), nf(s.CaxP), T('tg.CaxP.t'), chip(s.CaxP, 0, 55)],
  ];
  const th = T('tg.th');
  $('targets').innerHTML = `<table class="ix"><thead><tr>${th.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr><td>${r[0]}</td><td class="now">${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td></tr>`).join('')}</tbody></table>`;
}

// ---------------------------------------------------------------- charts
let charts = null;
const hoverAll = (t) => Object.values(charts).forEach((c) => c.setHover(t));
function setupCharts() {
  const time = {
    onHover: hoverAll,
    labels: () => ({ x: T('x.years'), noTx: T('hover.noTx') }),
    hoverX: (y) => T('hover.year', { v: nf(y, 1) }),
    xTicks: (span) => (span <= 10 ? 2 : span <= 20 ? 3 : 5),
  };
  const defs = {
    egfr: ['c-egfr', { title: T('c.egfr'), unit: 'mL/min', yMax: 110, fmt: (v) => `${nf(v)} mL/min`,
      bands: [{ from: 90, to: 999, label: 'G1', cls: 'b-G1' }, { from: 60, to: 90, label: 'G2', cls: 'b-G2' }, { from: 45, to: 60, label: 'G3a', cls: 'b-G3a' },
        { from: 30, to: 45, label: 'G3b', cls: 'b-G3b' }, { from: 15, to: 30, label: 'G4', cls: 'b-G4' }, { from: 0, to: 15, label: 'G5', cls: 'b-G5' }] }],
    P: ['c-P', { title: T('c.P'), unit: 'mg/dL', yMax: (m) => Math.max(8, Math.ceil(m + 0.5)), fmt: (v) => `${nf(v, 1)} mg/dL`,
      bands: [{ from: 2.5, to: 4.5, label: '', cls: 'b-normal' }] }],
    Ca: ['c-Ca', { title: T('c.Ca'), unit: 'mg/dL', yMin: 6.5, yMax: 11.5, fmt: (v) => `${nf(v, 1)} mg/dL`, tickFmt: (v) => nf(v, 1),
      bands: [{ from: 8.5, to: 10.2, label: '', cls: 'b-normal' }] }],
    PTH: ['c-PTH', { title: T('c.PTH'), unit: 'pg/mL', log: true, yMin: 5, yMax: (m) => (m > 2500 ? 10000 : 3000), fmt: (v) => `${nf(v)} pg/mL`, tickFmt: (v) => nf(v),
      bands: [{ from: 130, to: 585, label: T('band.target'), cls: 'b-target' }], refs: [{ y: 65, label: () => T('ref.uln') }] }],
    FGF23: ['c-FGF23', { title: T('c.FGF23'), unit: 'RU/mL', log: true, yMin: 30, yMax: (m) => (m > 9000 ? 30000 : 10000), fmt: (v) => `${nf(v)} RU/mL`, tickFmt: (v) => nf(v),
      refs: [{ y: 50, label: () => T('ref.normal') }] }],
    cal: ['c-cal', { title: T('c.cal'), unit: 'pg/mL', yMax: (m) => Math.max(60, Math.ceil(m / 10) * 10), fmt: (v) => `${nf(v)} pg/mL`, refs: [{ y: 40, label: () => T('ref.normal') }] }],
    G: ['c-G', { title: T('c.G'), unit: '×', yMax: (m) => Math.max(3, Math.ceil(m)), fmt: (v) => `×${nf(v, 1)}`, tickFmt: (v) => nf(v), refs: [{ y: 1, label: () => T('ref.normal') }] }],
    cac: ['c-cac', { title: T('c.cac'), unit: '/100', yMax: (m) => Math.max(20, Math.ceil(m / 10) * 10), fmt: (v) => `${nf(v)}/100` }],
  };
  charts = {};
  for (const [k, [id, o]] of Object.entries(defs)) { $(id).replaceChildren(); charts[k] = new LineChart($(id), { ...time, ...o }); }
}

function renderCharts() {
  const cfOn = ui.showCf && treatedEver;
  $('cf-legend').hidden = !cfOn;
  const every = Math.max(1, Math.ceil(hist.length / 600));
  const thin = (h) => h.filter((_, i) => i % every === 0 || i === h.length - 1);
  const H = thin(hist), C = thin(cfHist);
  const mk = (h, f, cls) => h.map((s) => [s.t, f(s), cls?.(s)]);
  const both = (f, colour) => {
    const main = { pts: mk(H, f, colour), cls: 's-main' };
    return cfOn ? [{ pts: mk(C, f), cls: 's-cf', dashed: true }, main] : [main];
  };
  const x = ui.horizon;
  charts.egfr.update([{ pts: mk(H, (s) => s.egfr, (s) => `st-${s.stage}`), cls: 's-main' }], x);
  charts.P.update(both((s) => s.P), x);
  charts.Ca.update(both((s) => s.Ca), x);
  charts.PTH.update(both((s) => s.PTH), x);
  charts.FGF23.update(both((s) => s.FGF23), x);
  charts.cal.update(both((s) => s.calcitriol), x);
  charts.G.update(both((s) => s.G), x);
  charts.cac.update(both((s) => s.cac), x);
}

function renderTable() {
  if (!document.querySelector('.table-view').open) return;
  const cfOn = treatedEver;
  const rows = [];
  for (let y = 0; y <= state.t + 1e-9; y += 0.5) { const r = hist.find((h) => h.t >= y - DT / 2); if (r) rows.push(r); }
  if (rows.at(-1) !== state) rows.push(state);
  const cfAt = (t) => cfHist.find((c) => Math.abs(c.t - t) < DT / 2);
  const th = T('th').filter((_, i) => i !== 6 || cfOn);
  $('data-table').innerHTML = `<div class="table-wrap"><table><thead><tr>${th.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
    rows.map((s) => `<tr><td>${nf(s.t, 1)}</td><td>${nf(s.egfr)}</td><td>${s.stage}</td><td>${nf(s.P, 1)}</td><td>${nf(s.Ca, 1)}</td><td>${nf(s.PTH)}</td>${cfOn ? `<td>${cfAt(s.t) ? nf(cfAt(s.t).PTH) : ''}</td>` : ''}<td>${nf(s.FGF23)}</td><td>${nf(s.calcitriol)}</td><td>×${nf(s.G, 1)}</td><td>${nf(s.cac)}</td><td>${T(`bone.${s.bone}`)}</td></tr>`).join('')}</tbody></table></div>`;
}

// ---------------------------------------------------------------- render loop
let lastUi = 0, lastTable = 0;
function render(force = false) {
  $('clock').textContent = T('clock', { y: nf(state.t, 1) });
  const now = performance.now();
  if (force || now - lastUi > 120) {
    lastUi = now;
    drawSchematic(state); renderCycle(state); renderTiles(state); renderTargets(state); renderCharts();
    if (force || now - lastTable > 1000) { lastTable = now; renderTable(); }
  }
}

let lastTs = null, acc = 0;
function frame(ts) {
  const dtSec = lastTs == null ? 0 : Math.min(0.1, (ts - lastTs) / 1000);
  lastTs = ts;
  if (playing) {
    acc += dtSec * ui.speed;
    while (acc >= DT && state.t < ui.horizon - 1e-9) { stepOnce(); acc -= DT; }
    if (state.t >= ui.horizon - 1e-9) { acc = 0; setPlaying(false); addLog(state.t, () => T('log.end')); render(true); }
    render();
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- boot
setupControls();
buildSchematic();
setupCharts();
applyStaticText();
document.querySelector('.table-view').addEventListener('toggle', renderTable);
syncControls();
reset();
const qp = new URLSearchParams(location.search).get('preset');
if (qp && M.PRESETS[qp]) loadPreset(qp);
requestAnimationFrame(frame);

// small hook for automated checks (no effect on the app)
window.__sim = {
  get state() { return state; }, get hist() { return hist; }, get cfHist() { return cfHist; }, get params() { return params; },
  get lang() { return lang; }, get preset() { return activePreset; }, setLang, loadPreset, setPlaying,
  runTo(y) { setPlaying(false); const end = Math.min(y, ui.horizon); while (state.t < end - 1e-9) stepOnce(); render(true); },
};
