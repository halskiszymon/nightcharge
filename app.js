// Main screen: reads config.json, data/state.json, data/forecast.json from the same origin.

const $ = (id) => document.getElementById(id);
const fmt1 = (v) => v.toFixed(1);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function json(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function daysAgo(iso) {
  if (!iso) return null;
  return Math.round((Date.now() - new Date(`${iso}T12:00:00`)) / 86400000);
}

function seasonCost(state, config) {
  // total kWh from history: each stretch at a level × kWh/day × heater count
  const hist = state.history || [];
  if (!hist.length && !state.lastChange) return null;
  const per = config.heaters.kwhPerDay;
  const n = config.heaters.count;
  let kwh = 0;
  for (let i = 0; i < hist.length; i++) {
    const to = hist[i + 1]?.date ?? new Date().toISOString().slice(0, 10);
    const days = Math.max(0, daysAgo(hist[i].date) - (daysAgo(to) ?? 0));
    kwh += (per[hist[i].to] ?? 0) * n * days;
  }
  return kwh * config.cost.pricePerKwhNight;
}

function forecastRows(fc, state, config) {
  const byDay = new Map();
  fc.hourly.time.forEach((t, i) => {
    const d = t.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(fc.hourly.temperature_2m[i]);
  });

  const th = config.thresholds;
  // nearest threshold relevant to the current level
  const level = state.level;
  const trigger =
    level === 'III' ? { v: th.IIItoII_min48, label: `min > ${fmt1(th.IIItoII_min48)} °C → II` } :
    level === 'II' ? { v: th.toIII_min48, label: `min < ${fmt1(th.toIII_min48)} °C → III` } :
    level === 'I' ? { v: th.toII_avg72, label: `avg < ${fmt1(th.toII_avg72)} °C → II` } :
    { v: th.zeroToI_avg72, label: `avg < ${fmt1(th.zeroToI_avg72)} °C → I` };

  let html = '';
  let i = 0;
  for (const [day, temps] of byDay) {
    if (i++ >= 5) break;
    const min = Math.min(...temps);
    const avg = temps.reduce((a, b) => a + b) / temps.length;
    const d = new Date(`${day}T12:00:00`);
    const hit = level === 'III' || level === 'II' ? min < th.toIII_min48 : avg < th.toII_avg72;
    html += `<div class="row"><span class="t">${DAYS[d.getDay()]} ${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}</span>` +
      `<span class="${hit ? 'cold' : ''}">min ${fmt1(min)} °C · avg ${fmt1(avg)} °C</span></div>`;
  }
  html += `<div class="row"><span class="t">change trigger</span><span>${trigger.label}</span></div>`;
  return html;
}

async function main() {
  let config, state, fc;
  try {
    [config, state] = await Promise.all([json('config.json'), json('data/state.json')]);
  } catch (e) {
    $('action').textContent = 'Cannot load state. Check whether the workflow has run yet.';
    return;
  }

  $('level').textContent = state.level;
  $('level').classList.toggle('off', state.level === '0');
  $('since').textContent = state.lastChange
    ? `since ${state.lastChange} (${daysAgo(state.lastChange)} days ago)`
    : 'no changes yet';

  const checkedToday = state.lastCheck?.date === new Date().toISOString().slice(0, 10);
  const stale = state.lastCheck && daysAgo(state.lastCheck.date) > 2;
  if (stale) {
    $('stale').style.display = 'block';
    $('stale').textContent = `⚠ Last check: ${state.lastCheck.date}. The workflow may have failed.`;
  }

  const changedToday = state.lastChange && daysAgo(state.lastChange) === 0;
  const a = $('action');
  if (changedToday) {
    a.textContent = `Today: turn the knobs to ${state.level} before 22:00.`;
    a.className = 'todo';
  } else {
    a.textContent = 'Nothing to do.';
    a.className = 'ok';
  }

  const hist = (state.history || []).slice().reverse();
  if (hist.length)
    $('hist').innerHTML = hist
      .map((h) => `<div class="row"><span class="t">${h.date}</span><span>${h.from} → ${h.to}</span></div>`)
      .join('');

  const cost = seasonCost(state, config);
  if (cost !== null && cost > 0) {
    $('costCard').hidden = false;
    $('cost').textContent = `~${Math.round(cost)} ${config.cost.currency} (${config.cost.pricePerKwhNight} ${config.cost.currency}/kWh, night tariff)`;
  }

  try {
    fc = await json('data/forecast.json');
    $('fc').innerHTML = forecastRows(fc, state, config);
  } catch {
    $('fc').innerHTML = '<div class="sub">no saved forecast</div>';
  }
}

main();
