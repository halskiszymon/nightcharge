// Backtests the thresholds against real weather from the Open-Meteo Archive API.
//   node scripts/backtest.js                       — thresholds from config.json
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

function runSeason(hourly, from, to, th, season) {
  const state = { level: '0', warmStreak: 0, lastChange: null, pending: null };
  let soc = 0;
  const changes = [];
  const days = [];
  let skipped = 0;

  for (let d = new Date(`${from}T12:00:00`); d <= new Date(`${to}T12:00:00`); d.setDate(d.getDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    if (!inSeason(d, season)) continue;

    const m = metrics(hourly, `${day}T20:00`, th);
    if (!m.complete) { skipped++; continue; }

    const before = state.level;
    const out = step(state, m, th, day);
    state.level = out.level;
    state.warmStreak = out.warmStreak;
    state.pending = out.pending;
    if (out.changed) state.lastChange = day;

    const mean24 = mean(hourly.temperature_2m.slice(m.start, m.start + 24));
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

async function evaluate(th, { detail = false } = {}) {
  const rows = [];
  for (const [key, from, to] of SEASONS) {
    const hourly = await archive(key, from, to);
    const r = runSeason(hourly, from, to, th, config.season);
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

const ORIGINAL = {
  toIII_min48: -8, IIItoII_min48: -5, toII_avg72: 3, IItoI_avg72: 5,
  ItoZero_avg72: 14, ItoZero_days: 3, zeroToI_avg72: 12,
  confirmDaysUp: 1, confirmDaysDown: 1, minDaysBetweenChanges: 0,
  avgWindowHours: 72, minWindowHours: 48,
};

const PRESETS = {
  'original (from the brief)': ORIGINAL,
  'config.json (recommended)': config.thresholds,
};

export { evaluate, archive, SEASONS, config, counts };

const main = async () => {
  if (flag('sweep')) {
    console.log('thresholds                        23/24  24/25  25/26  total');
    for (const [name, th] of Object.entries(PRESETS)) {
      const c = counts(await evaluate(th));
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
  const rows = await evaluate(th, { detail: flag('detail') || args.length === 0 });
  const c = counts(rows);
  console.log(`\nchanges per season: ${c.join(', ')}  (target: 3–6)`);
};

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((e) => { console.error(e.message); process.exit(1); });
