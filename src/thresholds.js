// Pure threshold logic — no I/O, no hardcoded numbers. Everything comes from config.thresholds.

export const LEVELS = ['0', 'I', 'II', 'III'];

export const toIndex = (label) => LEVELS.indexOf(String(label));
export const toLabel = (index) => LEVELS[index];

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

/**
 * Decision inputs from an hourly series, starting at the first hour >= fromIso:
 *   min48      — minimum over the next 48 h (emergency trigger only)
 *   coldMean24 — coldest rolling 24 h mean within the next 48 h (level III driver;
 *                a storage heater responds to daily energy, not to a single cold hour)
 *   avg72      — mean over the next 72 h (II/I/0 driver)
 *   outlookMin — lowest complete-day mean over days 4–7, used to hold a lowering
 *                when cold returns right behind it; Infinity when unavailable
 * Returns complete=false when the 48/72 h windows are short — callers must handle it.
 */
export function metrics(hourly, fromIso, th = {}) {
  const hoursMin = th.minWindowHours ?? 48;
  const hoursAvg = th.avgWindowHours ?? 72;
  const start = hourly.time.findIndex((t) => t >= fromIso);
  if (start < 0) return { start: -1, complete: false, min48: null, avg72: null, coldMean24: null, outlookMin: Infinity };

  const slice = (from, n) =>
    hourly.temperature_2m.slice(start + from, start + from + n).filter((v) => typeof v === 'number');

  const w48 = slice(0, hoursMin);
  const w72 = slice(0, hoursAvg);
  const complete = w48.length === hoursMin && w72.length === hoursAvg;

  let coldMean24 = Infinity;
  if (w48.length >= 24)
    for (let s = 0; s + 24 <= w48.length; s++) coldMean24 = Math.min(coldMean24, mean(w48.slice(s, s + 24)));

  let outlookMin = Infinity;
  for (let d = 3; d < 7; d++) {
    const w = slice(d * 24, 24);
    if (w.length === 24) outlookMin = Math.min(outlookMin, mean(w));
  }

  return {
    start,
    complete,
    min48: w48.length ? Math.min(...w48) : null,
    avg72: w72.length ? mean(w72) : null,
    coldMean24: Number.isFinite(coldMean24) ? coldMean24 : null,
    outlookMin,
  };
}

/**
 * One step of the state machine. state = { level: '0'|'I'|'II'|'III' }.
 * Transitions are always computed relative to state.level, never from scratch.
 */
export function decide(state, m, th) {
  const cur = toIndex(state.level);
  const next = (index, reason) => ({ level: toLabel(index), changed: index !== cur, reason });

  if (m.min48 < th.emergencyMin48)
    return next(3, `extreme frost, 48 h minimum of ${fmt(m.min48)}`);

  if (m.coldMean24 < th.toIII_mean24)
    return next(3, `coldest day ahead averages ${fmt(m.coldMean24)}, below ${fmt(th.toIII_mean24)}`);

  if (cur === 3) {
    return m.coldMean24 > th.IIItoII_mean24
      ? next(2, `coldest day ahead averages ${fmt(m.coldMean24)}, the frost is easing`)
      : next(3, `still freezing, coldest day ahead averages ${fmt(m.coldMean24)}`);
  }

  if (m.avg72 < th.toII_avg72)
    return next(2, `3-day average dropping to ${fmt(m.avg72)}`);

  if (cur === 2) {
    return m.avg72 > th.IItoI_avg72
      ? next(1, `3-day average rising to ${fmt(m.avg72)}`)
      : next(2, `3-day average ${fmt(m.avg72)}, inside the neutral band`);
  }

  if (cur === 1) {
    return m.avg72 > th.ItoZero_avg72
      ? next(0, `warm spell, 3-day average ${fmt(m.avg72)}`)
      : next(1, `3-day average ${fmt(m.avg72)}`);
  }

  // cur === 0
  return m.avg72 < th.zeroToI_avg72
    ? next(1, `3-day average dropping to ${fmt(m.avg72)}`)
    : next(0, `warm, 3-day average ${fmt(m.avg72)}`);
}

/** Would the band being left re-trigger within the day 4–7 outlook? */
function coldReturns(cur, m, th) {
  if (!Number.isFinite(m.outlookMin)) return false;
  if (cur === 3) return m.outlookMin < th.toIII_mean24;
  if (cur === 2) return m.outlookMin < th.toII_avg72;
  if (cur === 1) return m.outlookMin < th.zeroToI_avg72;
  return false;
}

/**
 * Full step: threshold decision + confirmation + outlook hold + dwell time.
 *
 * All damping is asymmetric. Raising the level goes through after
 * confirmDaysUp evenings (default: immediately) — cold hurts. Lowering must
 * hold for confirmDaysDown evenings, is held while days 4–7 show the cold
 * returning, and respects minDaysBetweenChanges — it only costs money.
 *
 * state = { level, lastChange, pending: { level, days } | null }
 */
export function step(state, m, th, todayIso) {
  const out = decide(state, m, th);
  const cur = toIndex(state.level);
  const target = toIndex(out.level);
  const base = { level: state.level, changed: false, held: false, lastChange: state.lastChange };

  if (target === cur) return { ...base, pending: null, reason: out.reason };

  const up = target > cur;
  const need = up ? (th.confirmDaysUp ?? 1) : (th.confirmDaysDown ?? 1);
  const pending =
    state.pending && state.pending.level === out.level
      ? { level: out.level, days: state.pending.days + 1 }
      : { level: out.level, days: 1 };

  if (pending.days < need)
    return { ...base, pending, held: true, reason: `${out.reason} — condition holding for ${pending.days}/${need} days` };

  if (!up && coldReturns(cur, m, th))
    return { ...base, pending, held: true, reason: `${out.reason} — but cold returns within a week (day 4–7 low of ${fmt(m.outlookMin)}), holding` };

  const dwell = up ? 0 : th.minDaysBetweenChanges || 0;
  const since = daysBetween(state.lastChange, todayIso);
  if (dwell > 0 && since !== null && since < dwell)
    return { ...base, pending, held: true, reason: `${out.reason} — last change ${since} days ago, dwell time is ${dwell} days` };

  return { level: out.level, changed: true, held: false, pending: null, lastChange: todayIso, reason: out.reason };
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
