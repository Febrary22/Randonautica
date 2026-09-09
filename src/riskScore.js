'use strict';

/**
 * SIMPLIFIED prototype stand-in for the full server-side risk score in docs/GAME_DESIGN.md §2.4.
 *
 * The real spec weighs 8 factors (night, streetlight density, isolation, cellular coverage,
 * terrain/surface, live weather, battery, companion mode) using external data this prototype
 * doesn't wire up yet (public lighting/cellular datasets, a weather API). This stub only computes
 * the factors we already have cheaply on hand — night-time, battery, and the POI-density
 * "isolation" proxy already computed for coordinate classification — so the advisory banner
 * (§0's "recommend turning back, never force it" principle) has *something* real behind it.
 *
 * Do not treat this as a finished implementation of §2.4 — it's here so the client has a
 * non-fake advisory to render, not as a safety guarantee.
 */

const NIGHT_WEIGHT = 45;
const DUSK_WEIGHT = 20;
const LOW_BATTERY_WEIGHT = 35;
const ISOLATION_WEIGHT = 20;

const ALERT_THRESHOLD = 50;

/**
 * @param {{hour: number, batteryLevel?: number|null, isolated?: boolean}} input
 *   `hour` is local hour-of-day (0-23) at the destination, provided by the client (browsers don't
 *   reliably expose server-side local time for an arbitrary lat/lon without a timezone lookup API,
 *   which is out of scope for this prototype — see docs §2.4 for the real design).
 */
function computeSimpleRiskAdvisory({ hour, batteryLevel = null, isolated = false }) {
  let score = 0;
  const reasons = [];

  if (hour >= 22 || hour < 5) {
    score += NIGHT_WEIGHT;
    reasons.push('night');
  } else if (hour >= 20 || hour < 7) {
    score += DUSK_WEIGHT;
    reasons.push('dusk');
  }

  if (typeof batteryLevel === 'number' && batteryLevel < 0.2) {
    score += LOW_BATTERY_WEIGHT;
    reasons.push('low-battery');
  }

  if (isolated) {
    score += ISOLATION_WEIGHT;
    reasons.push('isolated-area');
  }

  score = Math.min(100, score);

  return {
    score,
    show: score >= ALERT_THRESHOLD,
    reasons,
    message:
      score >= ALERT_THRESHOLD
        ? '이 경로는 다소 위험할 수 있어요. 계속하시겠어요? (판단은 당신의 몫입니다)'
        : null,
  };
}

module.exports = { computeSimpleRiskAdvisory, ALERT_THRESHOLD };
