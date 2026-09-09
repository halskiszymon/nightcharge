# NightCharge

Watches the charge-level setting of night storage heaters (Stiebel Eltron ETS)
and sends a notification **only when the knob actually needs turning** — a few
times a season, not every day.

Once a day in the evening a GitHub Actions workflow fetches the Open-Meteo
forecast for Kraków, computes the 72 h average, the coldest 24 h mean within
48 h, and the 48 h minimum, runs them through threshold logic with hysteresis,
and — if the recommended level changed — notifies you via ntfy.sh. State lives in [data/state.json](data/state.json); a PWA on GitHub
Pages shows the current status.

## Setup in fifteen minutes

1. **Fork the repo** (Fork button on GitHub). It must stay **public** —
   free Pages and Actions require it.

2. **Pick an ntfy topic** — a long random string, e.g. `heaters-a8f3k2m9x7`.
   The topic works like a password: anyone who knows it can read and send
   your notifications.

3. **Add the secret**: Settings → Secrets and variables → Actions →
   New repository secret → name `NTFY_TOPIC`, value: your topic.

4. **Install ntfy on your iPhone** (App Store: "ntfy"), open it, `+` →
   Subscribe to topic → enter your topic.

5. **Enable Actions**: Actions tab → "I understand… enable them"
   (forks have them disabled by default).

6. **Test notification**: Actions → "Check forecast" → Run workflow →
   set force to `notify` → Run. Your phone should buzz within ~30 s.
   The `change` option simulates a full level-change notification.

7. **Enable Pages**: Settings → Pages → Source: "Deploy from a branch" →
   branch `main`, folder `/ (root)` → Save. Shortly after, the page is live at
   `https://YOURLOGIN.github.io/REPONAME/`.

8. **Add to home screen**: open the page in Safari → Share button →
   "Add to Home Screen".

## Tuning the thresholds

Thresholds live in [config.json](config.json) — the code has no hardcoded
numbers. Two ways to change them:

- **From your phone**: the Settings screen in the PWA. Requires a GitHub
  token (below).
- **From GitHub**: edit `config.json` in the browser and commit.

How to read them: every transition has **separate entry and exit thresholds**
(hysteresis). Level II engages when the 72 h average drops below +3 °C and
disengages only above +9 °C. Level III is driven by the **coldest 24 h mean**
within the next 48 h (below −9 °C in, above −2 °C out) — a storage heater
responds to daily energy, not to one cold hour — plus an emergency trigger at
a 48 h minimum below −16 °C. On top of that, lowering must "hold" for
`confirmDaysDown` consecutive evenings and is postponed while days 4–7 of the
forecast dip back under the entry threshold. Raising is immediate, because a
cold flat hurts more than a few extra złoty.

If in practice the heaters can't keep up (cold mornings) — raise `toII_avg72`
/ `toIII_mean24` by 1–2 °C. If it overheats and wastes electricity — lower the
exit thresholds (`IItoI_avg72`, `IIItoII_mean24`). After any change, run the
backtest (below) and check how many changes per season come out.

## Token for saving from the PWA

The settings screen writes `config.json` through the GitHub Contents API.
It needs a token:

GitHub → Settings → Developer settings → Fine-grained tokens → Generate new →
Repository access: **this repo only** → Permissions → Contents: **Read and
write**.

You paste the token once in the PWA; it lands in the phone's `localStorage`
and goes nowhere else. **Risk**: anyone with the token can write to this repo
(and only this one). Don't paste it anywhere else, set an expiry date, and
revoke it in the same settings if it leaks. Without a token the screen is
read-only.

## Backtest

Checks how many level changes the thresholds would have produced on real
weather from the last three seasons (Open-Meteo Archive API, cached in
`data/archive/`):

```bash
npm run backtest
```

```bash
node scripts/backtest.js --sweep     # compare threshold variants
```

```bash
node scripts/backtest.js --set toII_avg72=2 --set IItoI_avg72=8   # custom thresholds
```

```bash
node scripts/backtest.js --real   # decide from archived real forecasts, not hindsight
```

Target: 3–6 changes per season. The thresholds in `config.json` yield
**5 / 3 / 5** on perfect hindsight and **7 / 3 / 5** on archived real
forecasts (2023/24, 2024/25, 2025/26). The seven is an honest outlier: winter
2023/24 had two separate deep-frost waves in December and January, each worth
its pair of notifications, and every change that season was at least 11 days
apart.

## Tests

```bash
npm test
```

The most important case: weather oscillating around a threshold must not
make the level flap.

## How it works inside

- [src/thresholds.js](src/thresholds.js) — pure logic: metrics, hysteresis,
  confirmation, dwell time. Zero I/O.
- [scripts/check.js](scripts/check.js) — the daily run: forecast → decision
  → notification → state commit. If Open-Meteo doesn't respond, the workflow
  fails visibly (red cross), state stays untouched, and the next day it tries
  again normally.
- [scripts/guard.js](scripts/guard.js) — Actions cron runs in UTC and can be
  hours late, so the workflow fires at 16:00 and 17:00 UTC and the guard
  accepts any run at or after 18:00 Warsaw time (handles DST); check.js skips
  a duplicate run on the same day. If the run itself fails, you get an ntfy
  alert.
- Outside the season (May 1 – September 14) nothing happens and nothing is
  sent. On September 15 you get a "watching again, leave the heaters at 0"
  notification — the first real 0 → I change comes from the forecast, usually
  late September or early October. On April 30 you get "turn everything to 0".
