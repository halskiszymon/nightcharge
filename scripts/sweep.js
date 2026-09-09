// Grid search over threshold variants. Looks for a set that yields 3–6 changes
// in every season with the smallest heating deficit.
import { evaluate, config, counts } from './backtest.js';


const grid = {
  band_II: [[2, 8], [3, 8], [3, 9], [4, 9]],
  band_III: [[-8, -3], [-9, -2], [-10, -2]],
  band_0: [[16, 10], [15, 11]],
  confirmDaysDown: [4, 5, 6],
};

const real = process.argv.includes('--real');
const combos = [];
for (const [toII, IItoI] of grid.band_II)
  for (const [toIII, IIItoII] of grid.band_III)
    for (const [ItoZero, zeroToI] of grid.band_0)
      for (const confirmDaysDown of grid.confirmDaysDown)
        combos.push({
          ...config.thresholds,
          toII_avg72: toII, IItoI_avg72: IItoI,
          toIII_mean24: toIII, IIItoII_mean24: IIItoII,
          ItoZero_avg72: ItoZero, zeroToI_avg72: zeroToI,
          confirmDaysDown,
        });

const results = [];
for (const th of combos) {
  const rows = await evaluate(th, { real });
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
    `| II ${t.toII_avg72}/${t.IItoI_avg72}  III ${t.toIII_mean24}/${t.IIItoII_mean24}  ` +
    `0 ${t.ItoZero_avg72}/${t.zeroToI_avg72}  confirm ${t.confirmDaysDown}d`);
};
ok.slice(0, 15).forEach(show);
console.log('\n— closest misses (by |total-13|):');
results.filter((r) => !r.ok)
  .sort((a, b) => Math.abs(a.c.reduce((x, y) => x + y) - 13) - Math.abs(b.c.reduce((x, y) => x + y) - 13))
  .slice(0, 5).forEach(show);
