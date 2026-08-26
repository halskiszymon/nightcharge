// Simple energy balance model: how many kWh the flat needs at a given daily mean
// and how much the heaters deliver at a given level. Used to score thresholds, not to control.

export const UA_KW_PER_K = 3.9 / 40; // 3.9 kW of losses at ΔT = 40 K
export const INDOOR_C = 19;
export const FREE_GAINS_KWH = 5; // people, appliances, sun

export function demandKwh(meanOutdoorC) {
  return Math.max(0, UA_KW_PER_K * (INDOOR_C - meanOutdoorC) * 24 - FREE_GAINS_KWH);
}

/** kWh delivered per day at a given level, for the whole flat. */
export function supplyKwh(level, heaters) {
  return (heaters.kwhPerDay[level] ?? 0) * heaters.count;
}

/** Cheapest level that covers demand (smallest sufficient one). */
export function idealLevel(meanOutdoorC, heaters) {
  const need = demandKwh(meanOutdoorC);
  for (const l of ['0', 'I', 'II', 'III']) if (supplyKwh(l, heaters) >= need) return l;
  return 'III';
}

export const CORE_STANDING_LOSS = 0.05; // ~5% of stored heat per day leaks through the casing

/**
 * Daily core balance. The heater charges at night up to the level's target,
 * so surplus from the previous day reduces the draw instead of being wasted.
 * Returns { soc, drawn, served, deficit } — drawn is electricity actually used.
 */
export function coreDay(soc, level, meanOutdoorC, heaters) {
  const target = supplyKwh(level, heaters);
  const drawn = Math.max(0, target - soc);
  let charged = soc + drawn;

  const need = demandKwh(meanOutdoorC);
  const served = Math.min(charged, need);
  charged -= served;

  return {
    soc: charged * (1 - CORE_STANDING_LOSS),
    drawn,
    served,
    deficit: need - served,
    need,
  };
}
