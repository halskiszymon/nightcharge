# NightCharge

Watches the charge-level setting of night storage heaters (Stiebel Eltron ETS)
and sends a notification **only when the knob actually needs turning** — a few
times a season, not every day.

Once a day at 19:30 a GitHub Actions workflow fetches the Open-Meteo forecast
for Kraków, computes `min48` and `avg72`, runs them through threshold logic
with hysteresis, and — if the recommended level changed — notifies you via
ntfy.sh. State lives in [data/state.json](data/state.json); a PWA on GitHub
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
(hysteresis), e.g. level II engages when the 72 h average drops below +1 °C
but disengages only above +7 °C. On top of that, lowering the level must
"hold" for `confirmDaysDown` consecutive evenings — a single warm day changes
nothing. Raising is immediate, because a cold flat hurts more than a few
extra złoty.

If in practice the heaters can't keep up (cold mornings) — lower `toII_avg72`
/ `toIII_min48` by 1–2 °C. If it overheats and wastes electricity — raise the
exit thresholds (`IItoI_avg72`, `IIItoII_min48`). After any change, run the
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
node scripts/backtest.js --set toII_avg72=2 --set IItoI_avg72=6   # custom thresholds
```

Target: 3–6 changes per season. The thresholds in `config.json` yield
**5 / 5 / 7** (2023/24, 2024/25, 2025/26 — the seven covers two separate cold
snaps in January and February 2026, each worth a notification).

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
- [scripts/guard.js](scripts/guard.js) — Actions cron runs in UTC, so the
  workflow fires at 17:30 and 18:30 UTC and the guard lets through only the
  run landing at 19:xx Warsaw time (handles DST).
- Outside the season (May 1 – September 14) nothing happens and nothing is
  sent. On September 15 and April 30 you get the boundary notifications.
