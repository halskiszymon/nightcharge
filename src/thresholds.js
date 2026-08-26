// Pure threshold logic — no I/O, no hardcoded numbers. Everything comes from config.thresholds.

export const LEVELS = ['0', 'I', 'II', 'III'];

export const toIndex = (label) => LEVELS.indexOf(String(label));
export const toLabel = (index) => LEVELS[index];

/**
 * min48 / avg72 over the hourly series, starting at the first hour >= fromIso.
 * Returns nulls when there is not enough data — callers must handle that.
 */
export function metrics(hourly, fromIso, th = {}) {
  const hours48 = th.minWindowHours ?? 48;
  const hours72 = th.avgWindowHours ?? 72;
  const start = hourly.time.findIndex((t) => t >= fromIso);
  if (start < 0) return { min48: null, avg72: null, start: -1, complete: false };

  const slice = (n) =>
    hourly.temperature_2m.slice(start, start + n).filter((v) => typeof v === 'number');

  const w48 = slice(hours48);
  const w72 = slice(hours72);
  const complete = w48.length === hours48 && w72.length === hours72;

  return {
    start,
    complete,
    min48: w48.length ? Math.min(...w48) : null,
    avg72: w72.length ? w72.reduce((a, b) => a + b, 0) / w72.length : null,
  };
}

/**
 * One step of the state machine. state = { level: '0'|'I'|'II'|'III', warmStreak: number }.
 * Transitions are always computed relative to state.level, never from scratch.
 */
export function decide(state, m, th) {
  const cur = toIndex(state.level);
  const warmStreak = m.avg72 > th.ItoZero_avg72 ? (state.warmStreak || 0) + 1 : 0;
  const next = (index, reason) => ({
    level: toLabel(index),
    warmStreak,
    changed: index !== cur,
    reason,
  });

  if (m.min48 < th.toIII_min48)
    return next(3, `48 h minimum of ${fmt(m.min48)}, below ${fmt(th.toIII_min48)}`);

  if (cur === 3) {
    return m.min48 > th.IIItoII_min48
      ? next(2, `minimum climbing to ${fmt(m.min48)}, the frost is easing`)
      : next(3, `still freezing, minimum ${fmt(m.min48)}`);
  }

  if (m.avg72 < th.toII_avg72)
    return next(2, `3-day average dropping to ${fmt(m.avg72)}`);

  if (cur === 2) {
    return m.avg72 > th.IItoI_avg72
      ? next(1, `3-day average rising to ${fmt(m.avg72)}`)
      : next(2, `3-day average ${fmt(m.avg72)}, inside the neutral band`);
  }

  if (cur === 1) {
    return warmStreak >= th.ItoZero_days
      ? next(0, `${warmStreak} days in a row with the average above ${fmt(th.ItoZero_avg72)}`)
      : next(1, `3-day average ${fmt(m.avg72)}`);
  }

  // cur === 0
  return m.avg72 < th.zeroToI_avg72
    ? next(1, `3-day average dropping to ${fmt(m.avg72)}`)
    : next(0, `warm, 3-day average ${fmt(m.avg72)}`);
}

/**
 * Full step: threshold decision + confirmation + dwell time.
 *
 * Confirmation and dwell are asymmetric. Raising the level goes through
 * immediately — cold hurts. Lowering must hold for confirmDaysDown days and
 * wait minDaysBetweenChanges since the previous change, as it only costs money.
 *
 * state = { level, warmStreak, lastChange, pending: { level, days } | null }
 */
export function step(state, m, th, todayIso) {
  const out = decide(state, m, th);
  const cur = toIndex(state.level);
  const target = toIndex(out.level);
  const base = { level: state.level, warmStreak: out.warmStreak, changed: false, held: false };

  if (target === cur)
    return { ...base, pending: null, lastChange: state.lastChange, reason: out.reason };

  const up = target > cur;
  const need = up ? (th.confirmDaysUp ?? 1) : (th.confirmDaysDown ?? 1);
  const pending =
    state.pending && state.pending.level === out.level
      ? { level: out.level, days: state.pending.days + 1 }
      : { level: out.level, days: 1 };

  if (pending.days < need)
    return {
      ...base,
      pending,
      lastChange: state.lastChange,
      held: true,
      reason: `${out.reason} — condition holding for ${pending.days}/${need} days`,
    };

  const dwell = up ? 0 : th.minDaysBetweenChanges || 0;
  const since = daysBetween(state.lastChange, todayIso);
  if (dwell > 0 && since !== null && since < dwell)
    return {
      ...base,
      pending,
      lastChange: state.lastChange,
      held: true,
      reason: `${out.reason} — last change ${since} days ago, dwell time is ${dwell} days`,
    };

  return {
    level: out.level,
    warmStreak: out.warmStreak,
    changed: true,
    held: false,
    pending: null,
    lastChange: todayIso,
    reason: out.reason,
  };
}

export function daysBetween(fromIso, toIso) {
  if (!fromIso) return null;
  const ms = new Date(`${toIso}T12:00:00Z`) - new Date(`${String(fromIso).slice(0, 10)}T12:00:00Z`);
  return Math.round(ms / 86400000);
}

export function fmt(v) {
  return `${Number(v).toFixed(1)} °C`;
}

/** Whether a local-time Date falls within the heating season. */
export function inSeason(date, season) {
  if (!season.enabled) return false;
  const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return season.start <= season.end
    ? md >= season.start && md <= season.end
    : md >= season.start || md <= season.end;
}

const pad = (n) => String(n).padStart(2, '0');
