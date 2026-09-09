// Decides whether a scheduled run should proceed. Actions cron can be hours
// late, so instead of matching the exact hour we accept any run at or after
// the configured local hour; check.js dedupes a second run on the same day.
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const hour = Number(
  new Intl.DateTimeFormat('en-GB', { timeZone: config.location.timezone, hour: '2-digit', hour12: false })
    .format(new Date())
);
console.log(`run=${hour >= config.check.localHour}`);
