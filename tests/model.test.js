// Run with:  node --test   (or: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/model.js';

const P = (o = {}) => M.withParams(o);
const at = (traj, years, dt = 0.02) => traj[Math.round(years / dt)];
const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('healthy steady state: P 3.5, Ca 9.5, PTH 40, FGF23 50, calcitriol 40', () => {
  const s = M.initialState(P());
  assert.ok(near(s.P, 3.5, 0.01) && near(s.Ca, 9.5, 0.01));
  assert.ok(near(s.PTH, 40, 0.5) && near(s.FGF23, 50, 0.5) && near(s.calcitriol, 40, 0.5));
  assert.ok(near(s.fep, 0.155, 0.002), 'FEP ≈ 15 %');
  assert.equal(s.stage, 'G1');
});

test('as eGFR falls, FGF23 rises first and keeps phosphate normal until late', () => {
  const at60 = M.mineral(P({ vitD25: 15 }), 60, 1), at30 = M.mineral(P({ vitD25: 15 }), 30, 1), at15 = M.mineral(P({ vitD25: 15 }), 15, 1);
  assert.ok(at60.FGF23 > 1.8 * 50, 'FGF23 already ~2× at eGFR 60');
  assert.ok(near(at60.P, 3.5, 0.01) && near(at30.P, 3.5, 0.01), 'phosphate normal in G3');
  assert.ok(at15.P > 4.5, 'hyperphosphataemia in G4–G5');
  assert.ok(at30.fep > at60.fep, 'remnant nephrons excrete a larger fraction');
});

test('the cascade: ↓ eGFR → ↓ calcitriol → ↓ calcium → ↑ PTH', () => {
  const vals = [90, 60, 45, 30, 20, 10].map((e) => M.mineral(P({ vitD25: 15 }), e, 1));
  for (let i = 1; i < vals.length; i++) {
    assert.ok(vals[i].calcitriol < vals[i - 1].calcitriol);
    assert.ok(vals[i].PTH > vals[i - 1].PTH);
  }
  assert.ok(vals[5].Ca < 8.5, 'hypocalcaemia at eGFR 10');
});

test('FGF23 inhibits 1α-hydroxylase: more FGF23 → less calcitriol', () => {
  const lo = M.mineral(P(), 45, 1), hi = M.mineral(P({ pIntake: 2000 }), 45, 1);
  assert.ok(hi.FGF23 > lo.FGF23 && hi.calcitriol < lo.calcitriol);
});

test('treatments act in the expected direction', () => {
  const base = P({ vitD25: 15 }), e = 15;
  const b = M.mineral(base, e, 1);
  assert.ok(M.mineral({ ...base, binderNonCa: true }, e, 1).P < b.P, 'binder ↓ P');
  assert.ok(M.mineral({ ...base, dietP: true }, e, 1).P < b.P, 'diet ↓ P');
  assert.ok(M.mineral({ ...base, colecalciferol: true }, e, 1).calcitriol > b.calcitriol, 'colecalciferol ↑ calcitriol substrate');
  const cal = M.mineral({ ...base, calcitriol: true }, e, 1);
  assert.ok(cal.PTH < b.PTH && cal.Ca > b.Ca && cal.P > b.P, 'calcitriol ↓ PTH but ↑ Ca and ↑ P');
  const cin = M.mineral({ ...base, calcimimetic: true }, e, 1);
  assert.ok(cin.PTH < b.PTH && cin.Ca < b.Ca, 'calcimimetic ↓ PTH and ↓ Ca');
  assert.ok(M.mineral({ ...base, binderCa: true }, e, 1).Ca > M.mineral({ ...base, binderNonCa: true }, e, 1).Ca, 'Ca-based binder adds calcium');
});

test('values stay finite and positive in extreme settings', () => {
  const p = P({ egfr0: 100, slope: 30, pIntake: 3000, vitD25: 2, calcitriol: true, binderCa: true, caSupplement: true });
  const tr = M.simulatePreset({ params: p, events: [] }, 15, 0.05);
  for (const s of tr) for (const k of ['egfr', 'P', 'Ca', 'PTH', 'FGF23', 'calcitriol', 'G', 'cac']) assert.ok(Number.isFinite(s[k]) && s[k] >= 0, `${k}=${s[k]}`);
  assert.ok(tr.at(-1).egfr >= M.DEFAULTS.egfrFloor && tr.at(-1).cac <= 100);
});

test('vascular calcification only accumulates', () => {
  const tr = M.simulatePreset(M.PRESETS.calciumFirst, 15);
  for (let i = 1; i < tr.length; i++) assert.ok(tr[i].cac >= tr[i - 1].cac - 1e-12);
});

test('KDIGO G staging boundaries', () => {
  assert.equal(M.gStage(90), 'G1'); assert.equal(M.gStage(59.9), 'G3a'); assert.equal(M.gStage(30), 'G3b');
  assert.equal(M.gStage(14.9), 'G5');
});

// ---------- presets ----------

test('preset healthy: stable for 15 years', () => {
  const tr = M.simulatePreset(M.PRESETS.healthy, 15);
  assert.ok(tr.every((s) => near(s.P, 3.5, 0.05) && near(s.Ca, 9.5, 0.05) && s.PTH < 65 && s.cac === 0));
});

test('preset untreated CKD: secondary hyperparathyroidism, late hyperphosphataemia, hypocalcaemia, high turnover', () => {
  const tr = M.simulatePreset(M.PRESETS.ckdUntreated, 15);
  assert.ok(at(tr, 8).PTH > 3 * 65, 'PTH already raised in G3b–G4');
  assert.ok(at(tr, 8).P <= 4.5, 'P still normal at eGFR ≈ 28');
  assert.ok(at(tr, 12.4).P > 6 && at(tr, 12.4).Ca < 8.5, 'hyperP and hypoCa near kidney failure');
  assert.ok(at(tr, 15).PTH > 9 * 65 && at(tr, 15).bone === 'high');
  assert.ok(at(tr, 15).G > 2, 'gland hyperplasia');
});

test('preset guideline: P kept normal, PTH in the dialysis target, little calcification', () => {
  const tr = M.simulatePreset(M.PRESETS.ckdGuideline, 15);
  const cf = M.simulatePreset(M.PRESETS.ckdGuideline, 15, 0.02, M.NO_TREATMENT);
  assert.ok(tr.every((s) => s.P < 4.6), 'phosphate controlled throughout');
  const end = at(tr, 15);
  assert.ok(end.PTH >= 130 && end.PTH <= 585, `PTH ${end.PTH} within 2–9 × ULN`);
  assert.ok(end.cac < 5 && at(cf, 15).cac > end.cac);
  assert.ok(end.G < at(cf, 15).G, 'less hyperplasia than untreated');
});

test('preset calcium-first: hypercalcaemia on dialysis, over-suppressed PTH (adynamic), most calcification', () => {
  const tr = M.simulatePreset(M.PRESETS.calciumFirst, 15);
  const g = M.simulatePreset(M.PRESETS.ckdGuideline, 15);
  const end = at(tr, 15);
  assert.ok(end.Ca > 10.2, `Ca ${end.Ca}`);
  assert.ok(end.PTH < 2 * 65 && end.bone === 'low');
  assert.ok(end.cac > 5 * at(g, 15).cac && end.cac > 25);
});

test('preset severe HPT on dialysis: binder + calcimimetic bring PTH into range; parathyroidectomy shrinks the glands', () => {
  const tr = M.simulatePreset(M.PRESETS.dialysisSevereHPT, 15);
  assert.ok(tr[0].PTH > 1000 && tr[0].P > 5.5);
  assert.ok(at(tr, 3).PTH < 585 && at(tr, 3).P < 4.6);
  assert.ok(at(tr, 4.5).G < 0.5, 'gland removed');
  assert.ok(at(tr, 15).G < 1.25, 'remnant regrowth capped');
});

test('preset transplant: phosphate normalises but autonomous glands cause hypercalcaemia (tertiary HPT)', () => {
  const tr = M.simulatePreset(M.PRESETS.transplantTertiary, 15);
  const after = at(tr, 3);
  assert.ok(after.P < 4.5 && after.egfr > 50);
  assert.ok(after.Ca > 10.2, `Ca ${after.Ca}`);
  assert.ok(after.PTH > 2 * 65, 'PTH stays high');
  assert.ok(at(tr, 15).G < after.G, 'glands involute slowly');
});

test('model functions are pure', () => {
  const p = P({ egfr0: 40 });
  const copy = JSON.stringify(p);
  const a = M.simulatePreset(M.PRESETS.ckdGuideline, 3);
  const b = M.simulatePreset(M.PRESETS.ckdGuideline, 3);
  M.mineral(p, 40, 1);
  assert.equal(JSON.stringify(p), copy);
  assert.deepEqual(a, b);
});
