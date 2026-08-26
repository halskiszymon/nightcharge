// Daily run: forecast → decision → notification (if any) → state save.
// Run from GitHub Actions. Exits non-zero on failure — the workflow must see it.
//   FORCE=notify  — send a test notification regardless of the decision
//   FORCE=change  — treat today's decision as a change (tests the full path)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { step, metrics, inSeason, fmt, daysBetween } from '../src/thresholds.js';
import { notify, changeMessage } from '../src/notify.js';

const ROOT = new URL('../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('config.json', ROOT)));
const STATE_FILE = new URL('data/state.json', ROOT);
const FORECAST_FILE = new URL('data/forecast.json', ROOT);

const topic = process.env.NTFY_TOPIC;
const force = process.env.FORCE || '';

function loadState() {
  if (!existsSync(STATE_FILE))
    return { level: '0', warmStreak: 0, lastChange: null, pending: null, history: [], seasonStartNotified: null, seasonEndNotified: null };
  return JSON.parse(readFileSync(STATE_FILE));
}

function saveState(state) {
  mkdirSync(new URL('data/', ROOT), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function localNow() {
  // Date in the configured timezone, regardless of the runner's TZ
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: config.location.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return {
    iso: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    date: new Date(Number(get('year')), Number(get('month')) - 1, Number(get('day'))),
  };
}

async function fetchForecast() {
  const { latitude, longitude, timezone } = config.location;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&hourly=temperature_2m&forecast_days=7&timezone=${encodeURIComponent(timezone)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.error(`Open-Meteo, attempt ${attempt}/3: ${e.message}`);
      if (attempt === 3) throw new Error(`Open-Meteo unavailable: ${e.message}`);
      await new Promise((r) => setTimeout(r, 15_000 * attempt));
    }
  }
}

function shiftMd(md, days) {
  const d = new Date(2001, Number(md.slice(0, 2)) - 1, Number(md.slice(3)) + days);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function seasonBoundary(state, now) {
  const season = config.season;
  if (!season.enabled) return null;
  const md = now.iso.slice(5);
  const year = now.iso.slice(0, 4);
  // a few days of slack in case cron does not fire exactly on the boundary day
  const within = (from, days) => md >= from && md <= shiftMd(from, days);
  if (within(season.start, 5) && state.seasonStartNotified !== year)
    return {
      kind: 'start',
      mark: () => (state.seasonStartNotified = year),
      title: 'Heating season starts',
      message: `Set the heaters to level I before ${config.check.knobDeadline}. The kitchen can stay at 0.`,
      newLevel: 'I',
    };
  if (within(season.end, 5) && state.seasonEndNotified !== year)
    return {
      kind: 'end',
      mark: () => (state.seasonEndNotified = year),
      title: 'Heating season ends',
      message: 'Turn all heaters down to 0. See you in September.',
      newLevel: '0',
    };
  return null;
}

const main = async () => {
  const state = loadState();
  const now = localNow();

  const boundary = seasonBoundary(state, now);
  if (boundary) {
    await notify({ topic, title: boundary.title, message: boundary.message, priority: 'high', tags: ['calendar'] });
    boundary.mark();
    if (state.level !== boundary.newLevel) {
      state.history.push({ date: now.iso, from: state.level, to: boundary.newLevel, reason: boundary.title });
      state.level = boundary.newLevel;
      state.lastChange = now.iso;
    }
    state.pending = null;
    saveState(state);
    console.log(`Season boundary (${boundary.kind}) — notification sent.`);
    return;
  }

  // FORCE bypasses the season gate so notifications can be tested in summer
  if (!inSeason(now.date, config.season) && !force) {
    // GitHub disables scheduled workflows after 60 days without repo activity;
    // an occasional summer commit keeps the cron alive until September
    if (!state.keepalive || daysBetween(state.keepalive, now.iso) >= 45) {
      state.keepalive = now.iso;
      saveState(state);
      console.log('Keepalive — state touched so the scheduled workflow stays enabled.');
    } else {
      console.log('Outside the heating season — nothing to do.');
    }
    return;
  }

  if (state.lastCheck?.date === now.iso && !force) {
    console.log('Already ran today — skipping so confirmation days are not counted twice.');
    return;
  }

  const forecast = await fetchForecast();
  const m = metrics(forecast.hourly, `${now.iso}T${String(now.hour).padStart(2, '0')}:00`, config.thresholds);
  if (!m.complete) throw new Error('Incomplete forecast — not enough hours in the window. State untouched.');

  const before = state.level;
  const out = step(state, m, config.thresholds, now.iso);
  state.warmStreak = out.warmStreak;
  state.pending = out.pending ?? null;

  const changed = out.changed || force === 'change';
  if (changed) {
    const to = out.changed ? out.level : before;
    const msg = changeMessage({ from: before, to, reason: out.reason, config });
    if (force === 'change' && !out.changed) {
      msg.title = `[TEST] ${msg.title}`;
      msg.message = `This is a manually forced test.\n${msg.message}`;
    }
    await notify({ topic, ...msg });
    if (out.changed) {
      state.level = out.level;
      state.lastChange = now.iso;
      state.history.push({ date: now.iso, from: before, to: out.level, reason: out.reason });
    }
    console.log(`Change ${before} → ${to}: ${out.reason}`);
  } else {
    console.log(`No change (${state.level}). min48=${fmt(m.min48)}, avg72=${fmt(m.avg72)}. ${out.reason}`);
  }

  if (force === 'notify' && !changed) {
    await notify({
      topic,
      title: '[TEST] Notifications work',
      message: `Current level: ${state.level}. min48=${fmt(m.min48)}, avg72=${fmt(m.avg72)}.`,
      tags: ['white_check_mark'],
    });
  }

  state.lastCheck = { date: now.iso, min48: m.min48, avg72: m.avg72, reason: out.reason };
  saveState(state);

  // forecast dump for the PWA — 5 days, slimmed down
  mkdirSync(new URL('data/', ROOT), { recursive: true });
  writeFileSync(FORECAST_FILE, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    hourly: {
      time: forecast.hourly.time.slice(0, 120),
      temperature_2m: forecast.hourly.temperature_2m.slice(0, 120),
    },
  }) + '\n');
};

main().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});
