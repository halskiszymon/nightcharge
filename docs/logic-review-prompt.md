# Review request: storage-heater charge-level advisor logic

You are asked to review the decision logic of a small home-heating advisor
and find mistakes, questionable assumptions, or risks. Be critical. The spec
below is self-contained — you do not need the code.

## Setting

Flat in Kraków, Poland: 84 m², old masonry building (insulated), second floor
of four, ceilings 3.3 m (~277 m³). Estimated heat loss ~3.9 kW at −20 °C
outdoor / +20 °C indoor (more than half of it ventilation).

Heating: three Stiebel Eltron ETS 400 night storage heaters (4 kW each,
220 kg core, ~30 kWh usable storage per heater per day). Each heater has one
manual knob: charge level **0 / I / II / III**, deciding how much the core
charges during the next cheap-tariff window. Tariff G12: cheap electricity
22:00–06:00 and 13:00–15:00. A knob change takes effect only at the next
charging window, so the decision is made **each evening (~18:00–19:00),
before 22:00**, from a weather forecast.

Owner's hard requirement: the system must recommend a change only **3–6 times
per heating season**. It notifies only on an actual change; a daily or weekly
notification cadence is a design failure.

## Decision inputs

Computed each evening from an hourly `temperature_2m` forecast (Open-Meteo,
7 days) starting at the first forecast hour >= now:

- `min48` — minimum temperature over the next 48 hours
- `avg72` — mean temperature over the next 72 hours

## State machine

Persistent state: `level` (0/I/II/III), `warmStreak` (consecutive evenings
with avg72 above the warm threshold), `pending` (candidate transition and how
many consecutive evenings it has held), date of last change.

Step 1 — raw target from thresholds (evaluated top to bottom, first match
wins; `cur` is the stored level):

1. `min48 < −12` → **III** (from any level)
2. `cur == III` → **II** if `min48 > −3`, else stay III
3. `avg72 < +1` → **II** (from 0, I, or II)
4. `cur == II` → **I** if `avg72 > +7`, else stay II
5. `cur == I` → **0** if `warmStreak >= 3` (avg72 > +16 for 3 consecutive
   evenings), else stay I
6. `cur == 0` → **I** if `avg72 < +10`, else stay 0

Every adjacent pair has separate entry/exit thresholds (hysteresis):
II↔I band is +1/+7 °C on avg72, III↔II band is −12/−3 °C on min48,
0↔I band is +10/+16 °C on avg72.

Step 2 — confirmation and dwell, asymmetric by design:

- **Raising** the level (more heat) fires **immediately** (confirmDaysUp = 1).
  Rationale: a cold flat hurts; overcharging only costs money.
- **Lowering** must produce the same raw target for **4 consecutive evenings**
  (confirmDaysDown = 4); a single differing evening resets the counter.
- A dwell time (minimum days between changes, lowering only) exists but is
  currently **disabled** (0 days).

Notification is sent only when the confirmed level differs from the stored
level. It states new level, old level, a human-readable reason, and reminds
to turn all three knobs before 22:00 (the kitchen heater is kept one level
lower than the rooms).

## Season

Heating season: September 15 – April 30. Outside it: level 0, no evaluation,
no notifications. One fixed notification at each boundary ("season starts,
set I" / "season ends, set 0"), with a 5-day slack window in case the daily
job misses the exact date.

## Calibration evidence

Backtested against real Kraków weather (Open-Meteo archive) for seasons
2023/24, 2024/25, 2025/26, replaying the evening decision with observed
weather as a perfect forecast. Result: **5 / 5 / 7 changes per season**
(target 3–6; the 7 includes two separate January/February 2026 cold snaps).
The owner's original thresholds (III at min48 < −8 exit > −5; II at avg72 < +3
exit > +5; 0↔I at +14/+12; no confirmation days) produced 24 / 18 / 17
changes and were rejected.

A crude energy model was used to score variants, not to control anything:
UA = 0.0975 kW/K, indoor 19 °C, free gains 5 kWh/day, supply 30/60/90 kWh/day
for the whole flat at I/II/III, core carryover day to day with 5 %/day
standing loss. It implies level III is only physically needed below roughly
−9 °C daily mean, which is why the III trigger sits at min48 < −12 rather
than the owner's original −8.

## What to verify (answer each point)

1. **Physics**: Is ~30 kWh/day usable storage per ETS 400 plausible, and is
   the linear mapping level I/II/III → 1/3, 2/3, 3/3 of full charge a fair
   model of how these knobs actually behave?
2. **Thresholds vs climate**: Given Kraków winters, are the bands
   (+1/+7 avg72 for II, −12/−3 min48 for III, +10/+16 for 0) sensible? Any
   band you would move, and why?
3. **Comfort risk**: With raising immediate but lowering needing 4 evenings,
   is there any realistic weather sequence where the flat is left cold for
   days? (Note rule 1 overrides everything.)
4. **Rule interaction**: I→0 requires warmStreak ≥ 3 *and then* 4 confirmation
   evenings on top — about 6 warm days total. Intended layering or an
   accidental double condition worth simplifying?
5. **min48 as the III trigger**: is a 48 h minimum the right variable for
   "charge to maximum", or would a coldest-daily-mean variable be more robust?
   Consider forecast error at the 48 h horizon.
6. **Hysteresis under forecast noise**: the backtest used perfect hindsight.
   Real forecasts wobble day to day. Could that realistically push changes
   per season well above 6, and would you widen anything to compensate?
7. **Blind spots**: anything the two metrics miss that matters for storage
   heaters — wind, sun gain, humidity, tariff-window length, multi-day cold
   snaps longer than the 72 h window?

Format: verdict per point (agree / disagree + why), then a short list of
concrete changes you would make, each with the expected effect on the
3–6-changes-per-season requirement.
