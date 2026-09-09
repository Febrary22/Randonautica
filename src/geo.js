'use strict';

/**
 * Pure geometry helpers used by the coordinate-generation pipeline (docs/GAME_DESIGN.md §2).
 * Nothing in this file makes network calls, so it's fully unit-testable offline (see test/geo.test.js).
 *
 * All "meters" distances use a simple equirectangular approximation, which is accurate enough
 * at the city-block scale this game operates at (a few hundred meters to a few km). It is NOT
 * accurate for long distances or near the poles — fine for our purposes, not a general-purpose
 * geodesy library.
 */

const EARTH_RADIUS_M = 6371000;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

/** Great-circle distance between two points, in meters (haversine formula — exact enough for our scale). */
function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

/** Initial compass bearing (0-360, 0 = true north) from point 1 to point 2. */
function initialBearingDeg(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  const theta = Math.atan2(y, x);
  return ((toDeg(theta) % 360) + 360) % 360;
}

/** Destination point given a start, bearing (deg), and distance (m). Used for sampling & bbox padding. */
function destinationPoint(lat, lon, bearingDeg, distanceMeters) {
  const delta = distanceMeters / EARTH_RADIUS_M;
  const theta = toRad(bearingDeg);
  const phi1 = toRad(lat);
  const lambda1 = toRad(lon);

  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta)
  );
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
    );

  return { lat: toDeg(phi2), lon: ((toDeg(lambda2) + 540) % 360) - 180 };
}

/**
 * A uniformly-distributed random point within a disc of `radiusMeters` around (lat, lon).
 * Uses r = R*sqrt(u) (not r = R*u) so points are uniform over *area*, not skewed toward the center.
 */
function randomPointInRadius(lat, lon, radiusMeters, rng = Math.random) {
  const r = radiusMeters * Math.sqrt(rng());
  const theta = rng() * 360;
  return destinationPoint(lat, lon, theta, r);
}

/** Axis-aligned bounding box (in degrees) that fully contains a circle of `radiusMeters` around (lat, lon). */
function boundingBoxAround(lat, lon, radiusMeters) {
  const north = destinationPoint(lat, lon, 0, radiusMeters);
  const south = destinationPoint(lat, lon, 180, radiusMeters);
  const east = destinationPoint(lat, lon, 90, radiusMeters);
  const west = destinationPoint(lat, lon, 270, radiusMeters);
  return { south: south.lat, north: north.lat, west: west.lon, east: east.lon };
}

/**
 * Ray-casting point-in-polygon test. `polygon` is an array of {lat, lon} vertices (need not be closed
 * — first/last point may or may not repeat, this handles both). Good enough for the simple-way water
 * polygons we get from Overpass; does not handle multipolygon holes (see docs/GAME_DESIGN.md §2.2 —
 * this is a documented prototype simplification).
 */
function pointInPolygon(point, polygon) {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].lon, yi = polygon[i].lat;
    const xj = polygon[j].lon, yj = polygon[j].lat;
    const intersects =
      yi > point.lat !== yj > point.lat &&
      point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Shortest distance in meters from `point` to the line segment (a, b). Uses an equirectangular
 * projection centered on the segment, which is accurate to within a meter or two at our scale.
 */
function pointToSegmentDistanceMeters(point, a, b) {
  const lat0 = toRad((a.lat + b.lat) / 2);
  const cosLat0 = Math.cos(lat0);

  const toXY = (p) => ({
    x: toRad(p.lon) * cosLat0 * EARTH_RADIUS_M,
    y: toRad(p.lat) * EARTH_RADIUS_M,
  });

  const P = toXY(point);
  const A = toXY(a);
  const B = toXY(b);

  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const lengthSq = dx * dx + dy * dy;

  let t = lengthSq === 0 ? 0 : ((P.x - A.x) * dx + (P.y - A.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));

  const closestX = A.x + t * dx;
  const closestY = A.y + t * dy;
  return Math.hypot(P.x - closestX, P.y - closestY);
}

/** Shortest distance in meters from `point` to a polyline (array of {lat,lon}, at least 2 points). */
function pointToPolylineDistanceMeters(point, polyline) {
  let min = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    const d = pointToSegmentDistanceMeters(point, polyline[i], polyline[i + 1]);
    if (d < min) min = d;
  }
  return min;
}

/** Total length of a tracked path (array of {lat, lon}), in meters. */
function pathLengthMeters(path) {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += haversineDistanceMeters(path[i - 1].lat, path[i - 1].lon, path[i].lat, path[i].lon);
  }
  return total;
}

module.exports = {
  EARTH_RADIUS_M,
  toRad,
  toDeg,
  haversineDistanceMeters,
  initialBearingDeg,
  destinationPoint,
  randomPointInRadius,
  boundingBoxAround,
  pointInPolygon,
  pointToSegmentDistanceMeters,
  pointToPolylineDistanceMeters,
  pathLengthMeters,
};
