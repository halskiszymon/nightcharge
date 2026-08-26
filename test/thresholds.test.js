import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, step, metrics, inSeason, toIndex } from '../src/thresholds.js';

const TH = {
  toIII_min48: -12, IIItoII_min48: -3,
  toII_avg72: 1, IItoI_avg72: 7,
  ItoZero_avg72: 16, ItoZero_days: 3, zeroToI_avg72: 10,
  confirmDaysUp: 1, confirmDaysDown: 4,
  minDaysBetweenChanges: 0,
  avgWindowHours: 72, minWindowHours: 48,
};

const m = (min48, avg72) => ({ min48, avg72, complete: true });

const freshState = () => ({ level: 'I', warmStreak: 0, lastChange: null, pending: null });

function runDays(state, series) {
  const out = [];
  let day = 0;
  for (const [min48, avg72] of series) {
    const r = step(state, m(min48, avg72), TH, `2025-01-${String(++day).padStart(2, '0')}`);
    state = { ...state, level: r.level, warmStreak: r.warmStreak, pending: r.pending };
    if (r.changed) state.lastChange = r.lastChange;
    out.push(r.level);
  }
  return out;
}

test('hysteresis: avg72 oscillating around the II threshold does not flap', () => {
  // oscillation 0.5–1.5 °C around the entry threshold toII_avg72=1; exit only above 7
  const series = Array.from({ length: 20 }, (_, i) => [-2, i % 2 ? 0.5 : 1.5]);
  const levels = runDays(freshState(), series);
  const changes = levels.filter((l, i) => l !== (levels[i - 1] ?? 'I')).length;
  assert.equal(changes, 1, `expected 1 change (I→II), got ${changes}: ${levels.join(',')}`);
  assert.equal(levels.at(-1), 'II');
});

test('hysteresis: min48 oscillating around the III threshold does not flap', () => {
  const series = Array.from({ length: 20 }, (_, i) => [i % 2 ? -12.5 : -11.5, -6]);
  const state = { ...freshState(), level: 'II' };
  const levels = runDays(state, series);
  const changes = levels.filter((l, i) => l !== (levels[i - 1] ?? 'II')).length;
  assert.equal(changes, 1, `expected 1 change (II→III): ${levels.join(',')}`);
  assert.equal(levels.at(-1), 'III');
});

test('raising the level is immediate, lowering needs confirmation', () => {
  let r = step(freshState(), m(-2, 0.5), TH, '2025-01-01');
  assert.equal(r.level, 'II');
  assert.equal(r.changed, true);

  // II → I: a single warm day is not enough
  let state = { level: 'II', warmStreak: 0, lastChange: '2025-01-01', pending: null };
  r = step(state, m(2, 8), TH, '2025-01-02');
  assert.equal(r.level, 'II');
  assert.equal(r.held, true);
});

test('II → I only after confirmDaysDown warm days', () => {
  const state = { level: 'II', warmStreak: 0, lastChange: null, pending: null };
  const levels = runDays(state, Array.from({ length: 6 }, () => [2, 8]));
  assert.deepEqual(levels, ['II', 'II', 'II', 'I', 'I', 'I']);
});

test('breaking the warm streak resets confirmation', () => {
  const state = { level: 'II', warmStreak: 0, lastChange: null, pending: null };
  const levels = runDays(state, [[2, 8], [2, 8], [2, 6], [2, 8], [2, 8], [2, 8], [2, 8]]);
  assert.equal(levels[5], 'II', 'streak broken on day 3, counter restarts');
  assert.equal(levels[6], 'I');
});

test('I → 0 requires ItoZero_days days above the threshold', () => {
  const state = { level: 'I', warmStreak: 0, lastChange: null, pending: null };
  const levels = runDays(state, Array.from({ length: 10 }, () => [12, 17]));
  assert.equal(levels[0], 'I');
  assert.ok(levels.at(-1) === '0');
  const firstZero = levels.indexOf('0');
  assert.ok(firstZero >= TH.ItoZero_days - 1, `0 appeared too early, day ${firstZero + 1}`);
});

test('transitions are computed from the last state, not from scratch', () => {
  // state III, avg72 high, but min48 still freezing → stays III
  const r = decide({ level: 'III', warmStreak: 0 }, m(-13, 2), TH);
  assert.equal(r.level, 'III');
});

test('frost overrides everything, regardless of state', () => {
  for (const level of ['0', 'I', 'II']) {
    const r = decide({ level, warmStreak: 0 }, m(-13, 2), TH);
    assert.equal(r.level, 'III', `from ${level} at min48=-13 it must go to III`);
  }
});

test('dwell time blocks lowering but not raising', () => {
  const th = { ...TH, minDaysBetweenChanges: 7, confirmDaysDown: 1 };
  const state = { level: 'II', warmStreak: 0, lastChange: '2025-01-01', pending: null };
  let r = step(state, m(2, 8), th, '2025-01-03');
  assert.equal(r.level, 'II');
  assert.equal(r.held, true);
  r = step(state, m(-13, -5), th, '2025-01-03');
  assert.equal(r.level, 'III', 'raising ignores dwell time');
});

test('metrics: incomplete window flagged as complete=false', () => {
  const hourly = {
    time: Array.from({ length: 60 }, (_, i) => `2025-01-01T${String(i % 24).padStart(2, '0')}:00`),
    temperature_2m: Array.from({ length: 60 }, () => 0),
  };
  hourly.time.forEach((_, i) => {
    hourly.time[i] = new Date(Date.UTC(2025, 0, 1, i)).toISOString().slice(0, 16);
  });
  const r = metrics(hourly, '2025-01-01T00:00', TH);
  assert.equal(r.complete, false, '60 h < 72 h');
  assert.equal(r.min48, 0);
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
