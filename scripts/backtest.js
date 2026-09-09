// Backtests the thresholds against real weather from the Open-Meteo Archive API.
//   node scripts/backtest.js                       — thresholds from config.json
//   node scripts/backtest.js --real                — decisions from archived real
//                                                    forecasts (Previous Runs API)
//                                                    instead of perfect hindsight
//   node scripts/backtest.js --preset presets/x.json
//   node scripts/backtest.js --set toII_avg72=2 --set IItoI_avg72=6
//   node scripts/backtest.js --sweep               — grid of variants, summary table
//   node scripts/backtest.js --detail              — day-by-day list of changes

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { step, metrics, inSeason } from '../src/thresholds.js';
import { demandKwh, supplyKwh, coreDay } from '../src/energy.js';

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

const ARCHIVE_DIR = new URL('../data/archive/', import.meta.url);
const SEASONS = [
  ['2023-2024', '2023-09-15', '2024-04-30'],
  ['2024-2025', '2024-09-15', '2025-04-30'],
  ['2025-2026', '2025-09-15', '2026-04-30'],
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));

const memo = new Map();
async function archive(key, from, to) {
  if (memo.has(key)) return memo.get(key);
  const file = new URL(`${key}.json`, ARCHIVE_DIR);
  if (existsSync(file)) {
    const h = JSON.parse(readFileSync(file)).hourly;
    memo.set(key, h);
    return h;
  }
  const { latitude, longitude, timezone } = config.location;
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${latitude}&longitude=${longitude}` +
    `&start_date=${from}&end_date=${to}&hourly=temperature_2m&timezone=${encodeURIComponent(timezone)}`;
  process.stderr.write(`fetching ${key}...\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo Archive ${res.status} for ${key}`);
  const json = await res.json();
  mkdirSync(new URL('.', file), { recursive: true });
  writeFileSync(file, JSON.stringify(json));
  memo.set(key, json.hourly);
  return json.hourly;
}

// Replaces observed temps with what the forecast said N days earlier, so the
// backtest sees the same (imperfect) data the evening decision would have seen.
function pseudoForecast(obs, prev, start) {
  const day0 = obs.time[start].slice(0, 10);
  const temps = [];
  for (let o = 0; o < 168 && start + o < obs.time.length; o++) {
    const i = start + o;
    const lead = Math.round((new Date(obs.time[i].slice(0, 10)) - new Date(day0)) / 86400000);
    let v = lead >= 1 && lead <= 4 ? prev[`temperature_2m_previous_day${lead}`][i] : null;
    if (v === null || v === undefined) v = obs.temperature_2m[i]; // lead 0 + archive gaps
    temps.push(v);
  }
  return { time: obs.time.slice(start, start + temps.length), temperature_2m: temps };
}

function runSeason(hourly, from, to, th, season, prev = null) {
  const state = { level: '0', lastChange: null, pending: null };
  let soc = 0;
  const changes = [];
  const days = [];
  let skipped = 0;

  for (let d = new Date(`${from}T12:00:00`); d <= new Date(`${to}T12:00:00`); d.setDate(d.getDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    if (!inSeason(d, season)) continue;

    const startAt = `${day}T20:00`;
    const source = prev ? pseudoForecast(hourly, prev, hourly.time.findIndex((t) => t >= startAt)) : hourly;
    const m = metrics(source, startAt, th);
    if (!m.complete) { skipped++; continue; }
    // energy accounting below needs indices into the observed series
    const obsStart = hourly.time.findIndex((t) => t >= startAt);

    const before = state.level;
    const out = step(state, m, th, day);
    state.level = out.level;
    state.pending = out.pending;
    if (out.changed) state.lastChange = day;

    const mean24 = mean(hourly.temperature_2m.slice(obsStart, obsStart + 24));
    const e = coreDay(soc, out.level, mean24, config.heaters);
    soc = e.soc;
    days.push({ day, level: out.level, min48: m.min48, avg72: m.avg72, mean24, ...e });
    if (out.changed) changes.push({ day, from: before, to: out.level, reason: out.reason, ...m });
  }
  return { changes, days, skipped };
}

function levelDays(days) {
  const tally = { '0': 0, I: 0, II: 0, III: 0 };
  for (const d of days) tally[d.level]++;
  return tally;
}

const PREV_VARS = [1, 2, 3, 4].map((d) => `temperature_2m_previous_day${d}`);

async function prevRuns(key, from, to) {
  const cacheKey = `prev-${key}`;
  if (memo.has(cacheKey)) return memo.get(cacheKey);
  const file = new URL(`${cacheKey}.json`, ARCHIVE_DIR);
  if (existsSync(file)) {
    const h = JSON.parse(readFileSync(file)).hourly;
    memo.set(cacheKey, h);
    return h;
  }
  const { latitude, longitude, timezone } = config.location;
  const url =
    `https://previous-runs-api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&hourly=${PREV_VARS.join(',')}&start_date=${from}&end_date=${to}&timezone=${encodeURIComponent(timezone)}`;
  process.stderr.write(`fetching archived forecasts for ${key}...\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo Previous Runs ${res.status} for ${key}`);
  const json = await res.json();
  mkdirSync(new URL('.', file), { recursive: true });
  writeFileSync(file, JSON.stringify(json));
  memo.set(cacheKey, json.hourly);
  return json.hourly;
}

async function evaluate(th, { detail = false, real = false } = {}) {
  const rows = [];
  for (const [key, from, to] of SEASONS) {
    const hourly = await archive(key, from, to);
    // must cover the archive file's exact range so indices line up
    const prev = real ? await prevRuns(key, hourly.time[0].slice(0, 10), hourly.time.at(-1).slice(0, 10)) : null;
    const r = runSeason(hourly, from, to, th, config.season, prev);
    rows.push({ key, ...r });
    if (detail) {
      console.log(`\n── season ${key} — ${r.changes.length} changes`);
      for (const c of r.changes)
        console.log(
          `   ${c.day}  ${c.from.padStart(3)} → ${c.to.padEnd(3)}  ` +
          `min48 ${c.min48.toFixed(1).padStart(5)}  avg72 ${c.avg72.toFixed(1).padStart(5)}  ${c.reason}`
        );
      const t = levelDays(r.days);
      const deficit = r.days.reduce((a, d) => a + Math.max(0, d.deficit), 0);
      const worst = Math.max(...r.days.map((d) => d.deficit));
      const kwh = r.days.reduce((a, d) => a + d.drawn, 0);
      console.log(
        `   days per level: 0=${t['0']}  I=${t.I}  II=${t.II}  III=${t.III}  ` +
        `| drawn ${Math.round(kwh)} kWh (~${Math.round(kwh * config.cost.pricePerKwhNight)} zł)  ` +
        `deficit ${Math.round(deficit)} kWh, worst day ${Math.round(worst)} kWh`);
    }
  }
  return rows;
}

function counts(rows) {
  return rows.map((r) => r.changes.length);
}

const PRESETS = {
  'config.json': config.thresholds,
};

export { evaluate, archive, SEASONS, config, counts };

const main = async () => {
  if (flag('sweep')) {
    console.log('thresholds                        23/24  24/25  25/26  total');
    for (const [name, th] of Object.entries(PRESETS)) {
      const c = counts(await evaluate(th, { real: flag('real') }));
      const flagChar = c.every((n) => n >= 3 && n <= 6) ? ' ✓' : '';
      console.log(
        `${name.padEnd(32)} ${c.map((n) => String(n).padStart(5)).join('  ')}  ${String(c.reduce((a, b) => a + b, 0)).padStart(5)}${flagChar}`
      );
    }
    return;
  }

  let th = { ...config.thresholds };
  const preset = opt('preset');
  if (preset) th = { ...th, ...JSON.parse(readFileSync(preset)).thresholds ?? JSON.parse(readFileSync(preset)) };
  for (let i = 0; i < args.length; i++)
    if (args[i] === '--set') {
      const [k, v] = args[i + 1].split('=');
      th[k] = Number(v);
    }

  console.log('thresholds:', JSON.stringify(th));
  const rows = await evaluate(th, { detail: flag('detail') || args.filter((x) => x !== '--real').length === 0, real: flag('real') });
  const c = counts(rows);
  console.log(`\nchanges per season: ${c.join(', ')}  (target: 3–6)`);
};

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((e) => { console.error(e.message); process.exit(1); });
