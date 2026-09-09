'use strict';

/**
 * Implements a simplified version of the coordinate-generation pipeline from
 * docs/GAME_DESIGN.md §2.1-§2.2. Simplifications from the full spec are called out inline —
 * search this file for "SIMPLIFIED" to find every place a corner was deliberately cut for the
 * prototype, so a future pass hardening this for real use knows exactly what to revisit.
 */

const geo = require('./geo');
const { fetchGeoContext, checkFootReachability } = require('./overpass');

const DEFAULT_SAMPLE_COUNT = 500;
const MAX_RESAMPLE_ROUNDS = 3;
const MIN_DESTINATION_DISTANCE_M = 80; // don't send someone 5m from where they're standing
const WATER_BUFFER_M = 25;
const COASTLINE_BUFFER_M = 40; // a bit more conservative — see overpass.js comment on coastlines
const ROAD_BUFFER_M = { motorway: 25, trunk: 20, primary: 15, secondary: 12, default: 12 };
const POI_DENSITY_RADIUS_M = 150;
const MAX_REACHABILITY_ATTEMPTS = 5;

function isExcluded(point, geoContext) {
  if (!geoContext) return false; // SIMPLIFIED: no exclusion data available — see generateAdventureCoordinate warnings
  for (const poly of geoContext.waterPolygons) {
    if (geo.pointInPolygon(point, poly)) return true;
  }
  for (const line of geoContext.waterLines) {
    if (geo.pointToPolylineDistanceMeters(point, line) < COASTLINE_BUFFER_M) return true;
  }
  for (const poly of geoContext.waterPolygons) {
    // also buffer the polygon boundary itself, not just its interior
    if (geo.pointToPolylineDistanceMeters(point, [...poly, poly[0]]) < WATER_BUFFER_M) return true;
  }
  for (const road of geoContext.majorRoads) {
    if (geo.pointToPolylineDistanceMeters(point, road) < ROAD_BUFFER_M.default) return true;
  }
  return false;
}

function countNearbyPois(point, pois) {
  let count = 0;
  let interesting = false;
  for (const poi of pois) {
    if (geo.haversineDistanceMeters(point.lat, point.lon, poi.lat, poi.lon) <= POI_DENSITY_RADIUS_M) {
      count++;
      if (poi.interesting) interesting = true;
    }
  }
  return { count, interesting };
}

/**
 * Classifies candidates into the §2.1 attractor/void/anomaly buckets.
 * SIMPLIFIED: the real design calls for KDE (density surface) + LOF (local outlier factor,
 * §2.3) over the full Monte Carlo point cloud. Here we approximate with percentile thresholds
 * over a simple POI-count-in-radius density proxy, which is far cheaper to compute and doesn't
 * require a numerical library, but is a much cruder signal than real KDE/LOF.
 */
function classifyCandidates(candidates) {
  const counts = candidates.map((c) => c.density.count).sort((a, b) => a - b);
  const percentile = (p) => counts[Math.min(counts.length - 1, Math.floor(p * counts.length))];
  const voidThreshold = percentile(0.3);
  const crowdThreshold = percentile(0.85);

  // Degenerate case: no variance at all (e.g. POI data was unavailable, so every candidate is
  // stuck at count=0) — checked via min===max rather than voidThreshold===crowdThreshold, since
  // a real skewed distribution (e.g. one outlier among many identical low counts) can legitimately
  // land both percentiles on the same value without the underlying data being degenerate. Without
  // this guard, the true no-signal case would mark everything "crowded" (0 >= 0 is trivially true).
  if (counts[0] === counts[counts.length - 1]) {
    for (const c of candidates) {
      c.type = 'unknown';
      c.weight = 1;
    }
    return candidates;
  }

  for (const c of candidates) {
    const { count, interesting } = c.density;
    if (count >= crowdThreshold) {
      c.type = 'crowded'; // §2.1-3b: too many people around — avoid unless nothing else is left
      c.weight = 0.2;
    } else if (interesting && count <= voidThreshold) {
      c.type = 'anomaly'; // isolated AND has a storied POI nearby — closest proxy to §2.1's anomaly
      c.weight = 3;
    } else if (interesting) {
      c.type = 'attractor';
      c.weight = 2;
    } else if (count <= voidThreshold) {
      c.type = 'void';
      c.weight = 2;
    } else {
      c.type = 'unknown';
      c.weight = 1;
    }
  }
  return candidates;
}

function weightedShuffleTop(candidates, topN) {
  const pool = [...candidates];
  const picked = [];
  while (pool.length && picked.length < topN) {
    const totalWeight = pool.reduce((s, c) => s + c.weight, 0);
    let r = Math.random() * totalWeight;
    let idx = 0;
    for (; idx < pool.length; idx++) {
      r -= pool[idx].weight;
      if (r <= 0) break;
    }
    picked.push(pool.splice(Math.min(idx, pool.length - 1), 1)[0]);
  }
  return picked;
}

/**
 * Generates one adventure destination.
 * @param {{lat:number, lon:number, radiusKm:number}} origin
 * @returns {Promise<{lat:number, lon:number, type:string, distanceMeters:number,
 *                     reachabilityVerified:boolean|null, warnings:string[]}>}
 */
async function generateAdventureCoordinate({ lat, lon, radiusKm }) {
  const warnings = [];
  const radiusMeters = radiusKm * 1000;
  const bbox = geo.boundingBoxAround(lat, lon, radiusMeters + 200);

  let geoContext = null;
  try {
    geoContext = await fetchGeoContext(bbox);
  } catch (err) {
    warnings.push(
      `safety-exclusion-data-unavailable (${err.message}) — proceeding WITHOUT water/road ` +
        'exclusion for this request. Do not treat the returned coordinate as verified-safe.'
    );
  }

  let candidates = [];
  for (let round = 0; round < MAX_RESAMPLE_ROUNDS && candidates.length < 20; round++) {
    const fresh = [];
    for (let i = 0; i < DEFAULT_SAMPLE_COUNT; i++) {
      const p = geo.randomPointInRadius(lat, lon, radiusMeters);
      const distanceMeters = geo.haversineDistanceMeters(lat, lon, p.lat, p.lon);
      if (distanceMeters < MIN_DESTINATION_DISTANCE_M) continue;
      if (isExcluded(p, geoContext)) continue;
      fresh.push({ ...p, distanceMeters });
    }
    candidates = candidates.concat(fresh);
  }

  if (candidates.length === 0) {
    // Every sample landed in water/road/etc. (small radius in a very built-up or coastal area).
    // Fall back to an unfiltered sample rather than failing the request outright, but say so loudly.
    warnings.push(
      'no-valid-candidate-after-exclusion — falling back to an UNFILTERED random point. ' +
        'Consider a larger radius or manual review for this location.'
    );
    const p = geo.randomPointInRadius(lat, lon, radiusMeters);
    return {
      lat: p.lat,
      lon: p.lon,
      type: 'unknown',
      distanceMeters: geo.haversineDistanceMeters(lat, lon, p.lat, p.lon),
      reachabilityVerified: null,
      warnings,
    };
  }

  if (geoContext) {
    for (const c of candidates) {
      c.density = countNearbyPois(c, geoContext.pois);
    }
  } else {
    for (const c of candidates) c.density = { count: 0, interesting: false };
  }
  classifyCandidates(candidates);

  const shortlist = weightedShuffleTop(candidates, MAX_REACHABILITY_ATTEMPTS);

  let chosen = null;
  let reachabilityVerified = null;
  let reachabilityServiceDown = false;
  for (const candidate of shortlist) {
    if (reachabilityServiceDown) {
      chosen = candidate;
      break;
    }
    const result = await checkFootReachability({ lat, lon }, candidate);
    if (result === true) {
      chosen = candidate;
      reachabilityVerified = true;
      break;
    }
    if (result === null) {
      // Service unreachable — don't burn the remaining attempts hammering a dead API (§2.2 step 2
      // says "verify", but a dead verifier shouldn't block the whole feature).
      reachabilityServiceDown = true;
      warnings.push('reachability-check-unavailable — could not confirm a walking route exists.');
      chosen = candidate;
      break;
    }
    // result === false: OSRM reached but found no walking route — try the next shortlisted candidate.
  }

  if (!chosen) {
    chosen = shortlist[0] || candidates[0];
    reachabilityVerified = false;
    warnings.push('no-shortlisted-candidate-had-a-walking-route — returning best-guess candidate anyway.');
  }

  return {
    lat: chosen.lat,
    lon: chosen.lon,
    type: chosen.type,
    distanceMeters: chosen.distanceMeters,
    reachabilityVerified,
    warnings,
  };
}

module.exports = { generateAdventureCoordinate, classifyCandidates, isExcluded };
