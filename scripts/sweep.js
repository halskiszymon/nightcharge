// Grid search over threshold variants. Looks for a set that yields 3–6 changes
// in every season with the smallest heating deficit.
import { evaluate, config, counts } from './backtest.js';


const grid = {
  avgWindowHours: [72, 120, 168],
  minWindowHours: [48, 72],
  band_II: [[1, 7], [0, 8], [0, 9], [-1, 9], [-1, 10], [-2, 10]],
  band_III: [[-10, -4], [-12, -3], [-13, -2], [-14, -1]],
  band_0: [[15, 11], [16, 10], [17, 9], [18, 8]],
  confirmDaysDown: [1, 2, 3, 4],
  minDaysBetweenChanges: [0, 7, 14],
};

const combos = [];
for (const avgWindowHours of grid.avgWindowHours)
  for (const minWindowHours of grid.minWindowHours)
    for (const [toII, IItoI] of grid.band_II)
      for (const [toIII, IIItoII] of grid.band_III)
        for (const [ItoZero, zeroToI] of grid.band_0)
          for (const confirmDaysDown of grid.confirmDaysDown)
            for (const minDaysBetweenChanges of grid.minDaysBetweenChanges)
              combos.push({
                ...config.thresholds,
                avgWindowHours, minWindowHours,
                toII_avg72: toII, IItoI_avg72: IItoI,
                toIII_min48: toIII, IIItoII_min48: IIItoII,
                ItoZero_avg72: ItoZero, zeroToI_avg72: zeroToI,
                confirmDaysUp: 1, confirmDaysDown, minDaysBetweenChanges,
              });

const results = [];
for (const th of combos) {
  const rows = await evaluate(th);
  const c = counts(rows);
  const all = rows.flatMap((r) => r.days);
  const under = all.reduce((s, d) => s + Math.max(0, d.deficit), 0);        // kWh that were missing
  const over = all.reduce((s, d) => s + d.drawn, 0) * config.cost.pricePerKwhNight / 3; // zł/season
  results.push({ th, c, under, over, ok: c.every((n) => n >= 3 && n <= 6) });
}

const ok = results.filter((r) => r.ok).sort((a, b) => a.under - b.under || a.over - b.over);
console.log(`${combos.length} variants, ${ok.length} hit 3–6 changes in every season\n`);
const show = (r) => {
  const t = r.th;
  console.log(
    `changes ${r.c.join('/')}  deficit ${String(Math.round(r.under)).padStart(4)} kWh  cost ${String(Math.round(r.over)).padStart(4)} zł/season  ` +
    `| avg${t.avgWindowHours}h min${t.minWindowHours}h  II ${t.toII_avg72}/${t.IItoI_avg72}  ` +
    `III ${t.toIII_min48}/${t.IIItoII_min48}  0 ${t.ItoZero_avg72}/${t.zeroToI_avg72}  ` +
    `confirm ${t.confirmDaysDown}d  dwell ${t.minDaysBetweenChanges}d`);
};
ok.slice(0, 15).forEach(show);
console.log('\n— closest misses (by |total-13|):');
results.filter((r) => !r.ok)
  .sort((a, b) => Math.abs(a.c.reduce((x, y) => x + y) - 13) - Math.abs(b.c.reduce((x, y) => x + y) - 13))
  .slice(0, 5).forEach(show);
