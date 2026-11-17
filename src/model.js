// model.js — CKD–mineral and bone disorder (CKD-MBD) and secondary hyperparathyroidism.
// Pure functions only (no DOM, no globals mutated). Units:
//   eGFR mL/min/1.73 m² · phosphate & calcium mg/dL · PTH pg/mL · FGF23 RU/mL ·
//   calcitriol pg/mL · 25-OH vitamin D ng/mL · phosphate flows mg/day · time years.
//
// TEACHING TOOL — NOT FOR CLINICAL USE. See README.md for every assumption.

/** Default parameters. [phys] = standard physiology / guideline value;
 *  [assumption] = tuning choice of the simulator. */
export const DEFAULTS = Object.freeze({
  // --- kidney trajectory
  egfr0: 100,            // starting eGFR
  slope: 0.5,            // [phys] eGFR decline, mL/min/1.73 m² per year (healthy ageing ≈ 0.5–1)
  egfrFloor: 5,          // residual eGFR in kidney failure
  dialysis: false,       // haemodialysis (removes phosphate)
  G0: 1,                 // initial parathyroid gland mass (1 = normal)
  // --- inputs
  vitD25: 30,            // [phys] 25-OH vitamin D, ng/mL (≥ 30 replete; CKD patients are often deficient)
  pIntake: 1200,         // [phys] dietary phosphate, mg/day (typical Western diet)
  // --- treatments
  dietP: false,          // phosphate-restricted diet (→ 800 mg/day)
  binderNonCa: false,    // non-calcium phosphate binder (e.g. sevelamer, lanthanum)
  binderCa: false,       // calcium-based phosphate binder (carbonate/acetate)
  caSupplement: false,   // calcium supplements
  colecalciferol: false, // nutritional vitamin D (raises 25-OH D to ≈ 35 ng/mL)
  calcitriol: false,     // active vitamin D (calcitriol / analogues)
  calcimimetic: false,   // cinacalcet / etelcalcetide
  // --- physiology
  P_NORMAL: 3.5,         // [phys] serum phosphate set point, mg/dL
  CA_NORMAL: 9.5,        // [phys] total serum calcium set point, mg/dL
  PTH_NORMAL: 40,        // [phys] PTH, pg/mL (upper limit of normal ≈ 65)
  PTH_ULN: 65,           // [phys] upper limit of normal for PTH assays
  FGF23_NORMAL: 50,      // [phys] C-terminal FGF23, RU/mL
  CALCITRIOL_NORMAL: 40, // [phys] 1,25-(OH)₂ vitamin D, pg/mL
  FEP_NORMAL: 0.155,     // [phys] fractional excretion of phosphate at eGFR 100 (≈ 15 %)
  FEP_MAX: 0.6,          // [assumption] maximum fractional excretion of P the remnant nephrons can reach
  dialysisPRemoval: 340, // [phys] mg/day (≈ 800 mg per session, 3 sessions a week)
  binderEffect: 0.3,     // [assumption] fraction of absorbed P removed by one binder
  // --- slow processes
  kHyperplasia: 0.2,     // [assumption] gland growth per year per log-unit of PTH stimulus
  G_MAX: 6,              // [assumption] maximum gland mass (× normal)
  G_MAX_PTX: 1.2,        // [assumption] maximum regrowth of the remnant after parathyroidectomy
  ptx: false,            // parathyroidectomy performed
  caCorrection: 0.6,     // [assumption] fraction of a calcium deficit corrected by normal glands
  kRegression: 0.05,     // [assumption] gland involution per year (nodular hyperplasia regresses slowly)
  kCalc: 2,              // [assumption] calcification score per year per 10 units of Ca×P above 40
});

// ---------------------------------------------------------------- classification

export const G_STAGES = [
  { id: 'G1', min: 90 }, { id: 'G2', min: 60 }, { id: 'G3a', min: 45 },
  { id: 'G3b', min: 30 }, { id: 'G4', min: 15 }, { id: 'G5', min: -Infinity },
];
export const gStage = (egfr) => G_STAGES.find((s) => egfr >= s.min).id;

/** Range status helpers (KDIGO 2017 CKD-MBD targets, simplified). */
export const RANGES = {
  P: [2.5, 4.5],      // normal adult range
  Ca: [8.5, 10.2],    // normal adult range; avoid hypercalcaemia
  PTH_D: [130, 585],  // 2–9 × ULN on dialysis
};

/** Bone turnover label (renal osteodystrophy) from PTH in advanced CKD. */
export function boneTurnover(s, p) {
  if (s.egfr >= 30 && !s.dialysis) return 'normal';
  if (s.PTH > 9 * p.PTH_ULN) return 'high';
  if ((s.dialysis || s.egfr < 15) && s.PTH < 2 * p.PTH_ULN) return 'low';
  return 'normal';
}

// ---------------------------------------------------------------- quasi-steady physiology

/** Mineral metabolism at a given eGFR and gland mass G (hormones equilibrate in days,
 *  far faster than kidney function changes, so a steady state per time step is used). */
export function mineral(p, egfr, G) {
  const gfrDl = Math.max(0.1, egfr) * 14.4;                         // mL/min → dL/day
  const vitD25 = p.colecalciferol ? Math.max(p.vitD25, 35) : p.vitD25;
  const s25 = Math.sqrt(Math.min(1.1, vitD25 / 30));               // substrate for 1α-hydroxylase
  const renal = Math.pow(Math.min(1, egfr / 60), 0.7);              // 1α-hydroxylase mass (proximal tubule)
  const intake = p.dietP ? 800 : p.pIntake;
  const binder = (1 - (p.binderNonCa ? p.binderEffect : 0)) * (1 - (p.binderCa ? p.binderEffect : 0));
  const cinac = p.calcimimetic ? 0.5 : 1;
  let cal = p.CALCITRIOL_NORMAL, PTH = p.PTH_NORMAL, out = null;
  for (let i = 0; i < 40; i++) {                                     // fixed point: calcitriol ↔ PTH
    const calRel = cal / p.CALCITRIOL_NORMAL;
    const absorb = 0.55 + 0.1 * Math.min(2.5, calRel);               // calcitriol ↑ intestinal P absorption
    const load = Math.max(30, intake * absorb * binder - (p.dialysis ? p.dialysisPRemoval : 0));
    const fepNeeded = load / (gfrDl * p.P_NORMAL);
    const fep = Math.min(p.FEP_MAX, Math.max(0.03, fepNeeded));
    const P = Math.min(15, load / (gfrDl * fep));
    // FGF23 (osteocytes) rises as each remaining nephron must excrete more P; hyperphosphataemia
    // and reduced renal clearance of FGF23 raise it further in advanced CKD.
    const FGF23 = p.FGF23_NORMAL * Math.pow(Math.max(1, fepNeeded / p.FEP_NORMAL), 1.5)
      * Math.pow(Math.max(1, P / 4.5), 2) * Math.pow(Math.max(1, 30 / Math.max(1, egfr)), 0.7);
    const endo = p.CALCITRIOL_NORMAL * renal * s25 * Math.pow(p.FGF23_NORMAL / FGF23, 0.25) * Math.pow(PTH / p.PTH_NORMAL, 0.15);
    const calNew = endo + (p.calcitriol ? 30 : 0);
    const calR = calNew / p.CALCITRIOL_NORMAL;
    const caBase = p.CA_NORMAL + Math.log(calR) - 0.12 * Math.max(0, P - p.P_NORMAL)
      + (p.binderCa ? 0.5 : 0) + (p.caSupplement ? 0.4 : 0) + (p.dialysis ? 0.6 : 0); // dialysate Ca 2.5 mEq/L
    // PTH secretion needed: driven by low calcium (main), high phosphate and low calcitriol;
    // suppressed by a calcium load.
    const pthNeeded = p.PTH_NORMAL * (1 + 2 * Math.max(0, p.CA_NORMAL - caBase)) * Math.exp(-1.5 * Math.max(0, caBase - p.CA_NORMAL))
      * Math.pow(P / p.P_NORMAL, 0.6) * Math.pow(calR, -0.3);
    const ratio = Math.pow(G, 0.6) * cinac;                           // secretion relative to what is needed
    const PTHnew = pthNeeded * ratio;
    // Skeletal resistance to PTH grows as eGFR falls, so high PTH corrects calcium less in
    // advanced CKD; it resolves after a transplant (unmasking tertiary hypercalcaemia).
    const efficacy = Math.min(1, Math.pow(Math.max(1, egfr) / 60, 0.3));
    // PTH (bone resorption, renal Ca reabsorption) corrects part of the deficit; glands larger
    // than needed (autonomous secretion) push calcium above normal (tertiary hyperparathyroidism).
    const Ca = caBase + efficacy * (p.caCorrection * (p.CA_NORMAL - caBase) * Math.min(1, ratio) + 1.3 * Math.log(Math.max(1, ratio)));
    out = { egfr, P, Ca, PTH: PTHnew, FGF23, calcitriol: calNew, calcitriolEndo: endo, vitD25, fep, fepNeeded, load, caBase, pthNeeded, ratio, efficacy };
    if (Math.abs(calNew - cal) < 1e-6 && Math.abs(PTHnew - PTH) < 1e-6) break;
    cal = 0.5 * cal + 0.5 * calNew; PTH = 0.5 * PTH + 0.5 * PTHnew;
  }
  return out;
}

/** Full observation for a state {t, egfr, G, cac}. */
export function observe(t, egfr, G, cac, p) {
  const m = mineral(p, egfr, G);
  const s = { t, ...m, G, cac, dialysis: p.dialysis, CaxP: m.Ca * m.P, stage: gStage(egfr) };
  s.bone = boneTurnover(s, p);
  return s;
}

export function initialState(p = DEFAULTS) {
  return observe(0, p.egfr0, p.G0, 0, p);
}

/** One explicit Euler step (dt in years). eGFR declines linearly (floor = residual function);
 *  the parathyroid glands grow under sustained stimulus; vascular calcification only accumulates. */
export function step(s, p, dt) {
  const egfr = Math.max(p.egfrFloor, s.egfr - p.slope * dt);
  const cur = mineral(p, s.egfr, s.G);
  const stimulus = (cur.pthNeeded / p.PTH_NORMAL) * (p.calcimimetic ? 0.6 : 1);
  const gMax = p.ptx ? p.G_MAX_PTX : p.G_MAX;
  // Growth needs a sustained stimulus above 1.5 × normal; involution towards normal size is slow.
  const dG = p.kHyperplasia * Math.log(Math.max(1, stimulus / 1.5)) * Math.max(0, 1 - s.G / gMax)
    - p.kRegression * (s.G - 1);
  const G = Math.max(0.05, s.G + dG * dt);
  const caLoad = (p.binderCa ? 1 : 0) + (p.caSupplement ? 0.7 : 0) + (p.calcitriol ? 0.7 : 0);
  const dC = p.kCalc * Math.max(0, (cur.Ca * cur.P - 40) / 10) + 1.5 * caLoad + (p.dialysis ? 0.5 : 0);
  const cac = Math.min(100, s.cac + dC * dt);
  return observe(s.t + dt, egfr, G, cac, p);
}

export function withParams(over = {}) { return { ...DEFAULTS, ...over }; }

/** Treatment keys (switched off for the "no treatment" counterfactual). */
export const TREATMENTS = ['dietP', 'binderNonCa', 'binderCa', 'caSupplement', 'colecalciferol', 'calcitriol', 'calcimimetic'];
export const NO_TREATMENT = Object.freeze({ ...Object.fromEntries(TREATMENTS.map((k) => [k, false])), ptx: false });

// ---------------------------------------------------------------- scenario presets

/** Each preset: params at t = 0 and timed events ({ t: years, set: {...} }).
 *  Special event keys: `egfr` (sets current eGFR, e.g. a transplant), `G` (sets gland mass,
 *  e.g. parathyroidectomy). Names and expected behaviour live in i18n.js. */
const progression = { egfr0: 60, slope: 4, vitD25: 15 };
export const PRESETS = {
  healthy: { params: { egfr0: 100, slope: 0.5, vitD25: 30 }, events: [] },
  ckdUntreated: {
    params: { ...progression },
    events: [{ t: 12.5, set: { dialysis: true } }],
  },
  ckdGuideline: {
    params: { ...progression, colecalciferol: true },
    events: [
      { t: 6, set: { dietP: true } },
      { t: 8.5, set: { binderNonCa: true } },
      { t: 12.5, set: { dialysis: true } },
      { t: 13, set: { calcimimetic: true } },
    ],
  },
  calciumFirst: {
    params: { ...progression, caSupplement: true },
    events: [
      { t: 6, set: { calcitriol: true } },
      { t: 8.5, set: { binderCa: true } },
      { t: 12.5, set: { dialysis: true } },
    ],
  },
  dialysisSevereHPT: {
    params: { egfr0: 6, slope: 0, dialysis: true, vitD25: 15, G0: 4 },
    events: [
      { t: 1, set: { binderNonCa: true, colecalciferol: true, calcimimetic: true } },
      { t: 4, set: { G: 0.15, ptx: true, calcimimetic: false } },
    ],
  },
  transplantTertiary: {
    params: { egfr0: 6, slope: 0, dialysis: true, vitD25: 15, G0: 5 },
    events: [{ t: 2, set: { dialysis: false, egfr: 60, slope: 1 } }],
  },
};

/** Split an event's `set` into ordinary params and state overrides (egfr, G). */
export function splitSet(set) {
  const params = {}, state = {};
  for (const [k, v] of Object.entries(set)) (k === 'egfr' || k === 'G' ? state : params)[k] = v;
  return { params, state };
}

/** Simulate a preset including its timed events. `override` applies for the whole run
 *  (e.g. NO_TREATMENT for the counterfactual). */
export function simulatePreset(preset, years = 15, dt = 0.02, override = {}) {
  let p = { ...DEFAULTS, ...preset.params, ...override };
  let s = initialState(p);
  const out = [s];
  const pending = (preset.events || []).map((e) => ({ ...e }));
  const n = Math.round(years / dt);
  for (let i = 0; i < n; i++) {
    for (const ev of pending) {
      if (ev.done || s.t < ev.t - 1e-9) continue;
      ev.done = true;
      const { params, state } = splitSet(ev.set);
      p = { ...p, ...params, ...override };
      const G = override.ptx === false ? s.G : (state.G ?? s.G); // no parathyroidectomy in the counterfactual
      s = observe(s.t, state.egfr ?? s.egfr, G, s.cac, p);
    }
    s = step(s, p, dt);
    out.push(s);
  }
  return out;
}
