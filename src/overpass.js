'use strict';

/**
 * Fetches exclusion/context data (water, major roads, points of interest) from the OpenStreetMap
 * Overpass API for a bounding box, per docs/GAME_DESIGN.md §2.2 step 1.
 *
 * NOTE ON TESTING: this file makes a live network call to a public OSM service. It could not be
 * exercised from the sandbox this prototype was built in (the build environment's egress policy
 * blocks overpass-api.de), so it has not been run against the real API — only reviewed by hand
 * against Overpass's documented JSON shape. Please treat the first real run as a smoke test, and
 * report back if the response shape doesn't match what's parsed below.
 *
 * Simplifications vs. the full §2.2 design (documented, not accidental):
 *  - Only simple (non-multipolygon) `way` water features are parsed as polygons. OSM `relation`
 *    multipolygons (common for large/complex lakes and coastlines) are NOT reconstructed — this
 *    is real geospatial work (ring assembly, inner/outer roles) that's out of scope for this
 *    prototype. Simple lakes/ponds (the common case) work fine.
 *  - Only `motorway|trunk|primary|secondary` roads are excluded (buffered). Minor residential
 *    streets are not, since almost everything in a walkable city touches one.
 *  - Building footprints, construction sites, and private/military land (§2.2 step 1) are NOT
 *    fetched or excluded yet — only water and major roads. Do not treat this prototype as
 *    "safe by the full spec"; it demonstrates the pipeline shape, not the finished safety net.
 */

const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const FETCH_TIMEOUT_MS = 20000;

function buildQuery(bbox) {
  // Overpass bbox order is (south,west,north,east).
  const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `
    [out:json][timeout:25];
    (
      way["natural"="water"](${bboxStr});
      way["waterway"="riverbank"](${bboxStr});
      way["natural"="coastline"](${bboxStr});
      way["highway"~"^(motorway|trunk|primary|secondary)$"](${bboxStr});
      node["amenity"](${bboxStr});
      node["shop"](${bboxStr});
      node["historic"](${bboxStr});
      node["tourism"](${bboxStr});
    );
    out body;
    >;
    out skel qt;
  `;
}

const INTERESTING_TAG_KEYS = ['historic', 'tourism', 'disused', 'abandoned'];

function isInterestingPoi(tags) {
  if (!tags) return false;
  if (INTERESTING_TAG_KEYS.some((k) => k in tags)) return true;
  if (tags.amenity === 'place_of_worship') return true;
  return false;
}

/**
 * Fetches and parses the geo context for a bounding box.
 * @returns {Promise<{waterPolygons: Array<Array<{lat,lon}>>, waterLines: Array<Array<{lat,lon}>>,
 *                     majorRoads: Array<Array<{lat,lon}>>, pois: Array<{lat,lon,interesting:boolean}>}>}
 */
async function fetchGeoContext(bbox) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let json;
  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: buildQuery(bbox),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Overpass returned HTTP ${res.status}`);
    }
    json = await res.json();
  } finally {
    clearTimeout(timeout);
  }

  const nodeMap = new Map();
  for (const el of json.elements) {
    if (el.type === 'node') nodeMap.set(el.id, { lat: el.lat, lon: el.lon });
  }

  const waterPolygons = [];
  const waterLines = [];
  const majorRoads = [];
  const pois = [];

  for (const el of json.elements) {
    if (el.type === 'node' && el.tags) {
      const p = nodeMap.get(el.id);
      if (p && (el.tags.amenity || el.tags.shop || el.tags.historic || el.tags.tourism)) {
        pois.push({ lat: p.lat, lon: p.lon, interesting: isInterestingPoi(el.tags) });
      }
      continue;
    }
    if (el.type !== 'way' || !el.tags || !Array.isArray(el.nodes)) continue;

    const coords = el.nodes.map((id) => nodeMap.get(id)).filter(Boolean);
    if (coords.length < 2) continue; // incomplete way (Overpass truncation) — skip rather than guess

    const isClosed =
      coords.length > 2 &&
      coords[0].lat === coords[coords.length - 1].lat &&
      coords[0].lon === coords[coords.length - 1].lon;

    const tags = el.tags;
    if (tags.natural === 'water' || tags.waterway === 'riverbank') {
      if (isClosed) waterPolygons.push(coords);
      else waterLines.push(coords); // truncated/open way — fall back to line-buffer exclusion
    } else if (tags.natural === 'coastline') {
      // Coastline is inherently a line, and we don't know which side is the sea without assembling
      // the full ring — buffer-excluding a strip on both sides is conservative but safe (§2.1: when
      // in doubt, prefer excluding a bit more over risking a shoreline drop).
      waterLines.push(coords);
    } else if (/^(motorway|trunk|primary|secondary)$/.test(tags.highway || '')) {
      majorRoads.push(coords);
    }
  }

  return { waterPolygons, waterLines, majorRoads, pois };
}

/**
 * Best-effort pedestrian reachability check via the public OSRM demo server (§2.2 step 2).
 * Returns null (not a hard failure) if the service is unreachable — callers should treat that as
 * "could not verify" rather than "unreachable", per docs/GAME_DESIGN.md §2.2.
 */
const OSRM_URL = process.env.OSRM_URL || 'https://router.project-osrm.org';
const REACHABILITY_TOLERANCE_M = 25;

async function checkFootReachability(origin, destination) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url =
      `${OSRM_URL}/route/v1/foot/${origin.lon},${origin.lat};${destination.lon},${destination.lat}` +
      `?overview=false`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code !== 'Ok' || !json.routes || !json.routes[0]) return false;
    // OSRM "Ok" already means a walking route exists between the two points; a route existing at
    // all is the signal we care about (§2.2 step 2's "does a path exist" check).
    return true;
  } catch {
    return null; // network/timeout — "could not verify", not "unreachable"
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { fetchGeoContext, checkFootReachability, REACHABILITY_TOLERANCE_M };
