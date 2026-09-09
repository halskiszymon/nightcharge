import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, step, metrics, inSeason, toIndex } from '../src/thresholds.js';

const TH = {
  emergencyMin48: -16,
  toIII_mean24: -9, IIItoII_mean24: -2,
  toII_avg72: 3, IItoI_avg72: 9,
  ItoZero_avg72: 16, zeroToI_avg72: 10,
  confirmDaysUp: 1, confirmDaysDown: 5,
  minDaysBetweenChanges: 0,
  avgWindowHours: 72, minWindowHours: 48,
};

const m = (coldMean24, avg72, { min48 = coldMean24, outlookMin = Infinity } = {}) =>
  ({ min48, avg72, coldMean24, outlookMin, complete: true });

const freshState = () => ({ level: 'I', lastChange: null, pending: null });

function runDays(state, series) {
  const out = [];
  let day = 0;
  for (const metricsOfDay of series) {
    const r = step(state, metricsOfDay, TH, `2025-01-${String(++day).padStart(2, '0')}`);
    state = { ...state, level: r.level, pending: r.pending };
    if (r.changed) state.lastChange = r.lastChange;
    out.push(r.level);
  }
  return out;
}

test('hysteresis: avg72 oscillating around the II threshold does not flap', () => {
  // oscillation 2.5-3.5 °C around the entry threshold toII_avg72=3; exit only above 9
  const series = Array.from({ length: 20 }, (_, i) => m(0, i % 2 ? 2.5 : 3.5));
  const levels = runDays(freshState(), series);
  const changes = levels.filter((l, i) => l !== (levels[i - 1] ?? 'I')).length;
  assert.equal(changes, 1, `expected 1 change (I→II), got ${changes}: ${levels.join(',')}`);
  assert.equal(levels.at(-1), 'II');
});

test('hysteresis: coldest day mean oscillating around the III threshold does not flap', () => {
  const series = Array.from({ length: 20 }, (_, i) => m(i % 2 ? -9.5 : -8.5, -6));
  const state = { ...freshState(), level: 'II' };
  const levels = runDays(state, series);
  const changes = levels.filter((l, i) => l !== (levels[i - 1] ?? 'II')).length;
  assert.equal(changes, 1, `expected 1 change (II→III): ${levels.join(',')}`);
  assert.equal(levels.at(-1), 'III');
});

test('raising the level is immediate, lowering needs confirmation', () => {
  let r = step(freshState(), m(-1, 2), TH, '2025-01-01');
  assert.equal(r.level, 'II');
  assert.equal(r.changed, true);

  // II → I: a single warm day is not enough
  const state = { level: 'II', lastChange: '2025-01-01', pending: null };
  r = step(state, m(5, 10), TH, '2025-01-02');
  assert.equal(r.level, 'II');
  assert.equal(r.held, true);
});

test('II → I only after confirmDaysDown warm days', () => {
  const state = { level: 'II', lastChange: null, pending: null };
  const levels = runDays(state, Array.from({ length: 7 }, () => m(5, 10)));
  assert.deepEqual(levels, ['II', 'II', 'II', 'II', 'I', 'I', 'I']);
});

test('breaking the warm streak resets confirmation', () => {
  const state = { level: 'II', lastChange: null, pending: null };
  const days = [m(5, 10), m(5, 10), m(5, 8), m(5, 10), m(5, 10), m(5, 10), m(5, 10), m(5, 10)];
  const levels = runDays(state, days);
  assert.equal(levels[6], 'II', 'streak broken on day 3, counter restarts');
  assert.equal(levels[7], 'I');
});

test('lowering is held while cold returns in the day 4-7 outlook', () => {
  const state = { level: 'II', lastChange: null, pending: null };
  // warm enough to leave II, but the outlook dips back under the entry threshold
  const warmButColdLater = m(5, 10, { outlookMin: 1 });
  const levels = runDays(state, Array.from({ length: 8 }, () => warmButColdLater));
  assert.ok(levels.every((l) => l === 'II'), `held at II, got ${levels.join(',')}`);
  // once the outlook clears, the confirmed lowering goes through
  const r = step({ level: 'II', lastChange: null, pending: { level: 'I', days: 5 } }, m(5, 10), TH, '2025-02-01');
  assert.equal(r.level, 'I');
});

test('I → 0 uses the warm threshold with down-confirmation', () => {
  const state = { level: 'I', lastChange: null, pending: null };
  const levels = runDays(state, Array.from({ length: 8 }, () => m(14, 17)));
  assert.equal(levels[0], 'I');
  assert.equal(levels.at(-1), '0');
  assert.ok(levels.indexOf('0') >= TH.confirmDaysDown - 1);
});

test('transitions are computed from the last state, not from scratch', () => {
  // state III, avg72 mild, but the coldest day ahead still freezing → stays III
  const r = decide({ level: 'III' }, m(-5, 2), TH);
  assert.equal(r.level, 'III');
});

test('frost overrides everything, regardless of state', () => {
  for (const level of ['0', 'I', 'II']) {
    const r = decide({ level }, m(-10, 2), TH);
    assert.equal(r.level, 'III', `from ${level} at coldMean24=-10 it must go to III`);
  }
});

test('extreme 48 h minimum forces III even when day means look mild', () => {
  const r = decide({ level: 'I' }, m(-4, 0, { min48: -17 }), TH);
  assert.equal(r.level, 'III');
});

test('dwell time blocks lowering but not raising', () => {
  const th = { ...TH, minDaysBetweenChanges: 7, confirmDaysDown: 1 };
  const state = { level: 'II', lastChange: '2025-01-01', pending: null };
  let r = step(state, m(5, 10), th, '2025-01-03');
  assert.equal(r.level, 'II');
  assert.equal(r.held, true);
  r = step(state, m(-10, -5), th, '2025-01-03');
  assert.equal(r.level, 'III', 'raising ignores dwell time');
});

test('metrics: incomplete window flagged as complete=false', () => {
  const hourly = {
    time: Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2025, 0, 1, i)).toISOString().slice(0, 16)),
    temperature_2m: Array.from({ length: 60 }, () => 0),
  };
  const r = metrics(hourly, '2025-01-01T00:00', TH);
  assert.equal(r.complete, false, '60 h < 72 h');
  assert.equal(r.min48, 0);
  assert.equal(r.coldMean24, 0);
});

test('metrics: coldMean24 sees a cold day that min48 alone would overstate', () => {
  // one -13 °C night spike inside otherwise 0 °C weather
  const temps = Array.from({ length: 96 }, (_, i) => (i >= 24 && i < 30 ? -13 : 0));
  const hourly = {
    time: Array.from({ length: 96 }, (_, i) => new Date(Date.UTC(2025, 0, 1, i)).toISOString().slice(0, 16)),
    temperature_2m: temps,
  };
  const r = metrics(hourly, '2025-01-01T00:00', TH);
  assert.equal(r.min48, -13);
  assert.ok(r.coldMean24 > -4, `short spike keeps the day mean mild, got ${r.coldMean24}`);
});

test('metrics: outlookMin is the lowest complete-day mean of days 4-7', () => {
  const temps = Array.from({ length: 168 }, (_, i) => (i >= 96 && i < 120 ? -6 : 4));
  const hourly = {
    time: Array.from({ length: 168 }, (_, i) => new Date(Date.UTC(2025, 0, 1, i)).toISOString().slice(0, 16)),
    temperature_2m: temps,
  };
  const r = metrics(hourly, '2025-01-01T00:00', TH);
  assert.equal(r.outlookMin, -6);
});

test('inSeason: season spanning New Year', () => {
  const season = { enabled: true, start: '09-15', end: '04-30' };
  assert.equal(inSeason(new Date(2025, 0, 15), season), true);   // Jan 15
  assert.equal(inSeason(new Date(2025, 6, 15), season), false);  // Jul 15
  assert.equal(inSeason(new Date(2025, 8, 15), season), true);   // Sep 15
  assert.equal(inSeason(new Date(2025, 3, 30), season), true);   // Apr 30
  assert.equal(inSeason(new Date(2025, 4, 1), season), false);   // May 1
});

test('level ordering', () => {
  assert.ok(toIndex('0') < toIndex('I') && toIndex('I') < toIndex('II') && toIndex('II') < toIndex('III'));
});
