// Of the two cron firings (17:30 and 18:30 UTC), lets through the one that
// lands at the configured local hour — handling CET/CEST without guessing.
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const hour = Number(
  new Intl.DateTimeFormat('en-GB', { timeZone: config.location.timezone, hour: '2-digit', hour12: false })
    .format(new Date())
);
// window [localHour, localHour+1] — Actions cron can be late and slip past the
// full hour; a duplicate same-day run is filtered out by check.js
const ok = hour === config.check.localHour || hour === config.check.localHour + 1;
console.log(`run=${ok}`);
