'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../src/geo');

test('haversineDistanceMeters: same point is zero', () => {
  assert.equal(geo.haversineDistanceMeters(37.5, 127.0, 37.5, 127.0), 0);
});

test('haversineDistanceMeters: ~111km per degree of latitude at the equator', () => {
  const d = geo.haversineDistanceMeters(0, 0, 1, 0);
  assert.ok(Math.abs(d - 111195) < 500, `expected ~111195m, got ${d}`);
});

test('destinationPoint + haversineDistanceMeters round-trip', () => {
  const start = { lat: 37.5665, lon: 126.978 };
  const dest = geo.destinationPoint(start.lat, start.lon, 45, 500);
  const d = geo.haversineDistanceMeters(start.lat, start.lon, dest.lat, dest.lon);
  assert.ok(Math.abs(d - 500) < 1, `expected ~500m, got ${d}`);
});

test('initialBearingDeg: due north is ~0', () => {
  const b = geo.initialBearingDeg(37.5, 127.0, 37.6, 127.0);
  assert.ok(b < 1 || b > 359, `expected ~0deg, got ${b}`);
});

test('initialBearingDeg: due east is ~90', () => {
  const b = geo.initialBearingDeg(37.5, 127.0, 37.5, 127.1);
  assert.ok(Math.abs(b - 90) < 2, `expected ~90deg, got ${b}`);
});

test('randomPointInRadius: always within the requested radius', () => {
  const center = { lat: 35.1796, lon: 129.0756 };
  for (let i = 0; i < 500; i++) {
    const p = geo.randomPointInRadius(center.lat, center.lon, 1000);
    const d = geo.haversineDistanceMeters(center.lat, center.lon, p.lat, p.lon);
    assert.ok(d <= 1000 + 1e-6, `point ${i} was ${d}m from center, expected <=1000m`);
  }
});

test('randomPointInRadius: distribution is not clumped at the center (uniform-over-area check)', () => {
  // With r = R*sqrt(u), half the samples should fall outside R/sqrt(2) (the median radius for a
  // uniform disc). A naive r = R*u sampler would clump most points near the center and fail this.
  const center = { lat: 0, lon: 0 };
  const R = 1000;
  const medianR = R / Math.sqrt(2);
  let outsideMedian = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    const p = geo.randomPointInRadius(center.lat, center.lon, R);
    const d = geo.haversineDistanceMeters(center.lat, center.lon, p.lat, p.lon);
    if (d > medianR) outsideMedian++;
  }
  const fraction = outsideMedian / N;
  assert.ok(fraction > 0.4 && fraction < 0.6, `expected ~50% beyond median radius, got ${fraction}`);
});

test('boundingBoxAround: contains the center and roughly matches the requested radius', () => {
  const bbox = geo.boundingBoxAround(37.5, 127.0, 1000);
  assert.ok(bbox.south < 37.5 && bbox.north > 37.5);
  assert.ok(bbox.west < 127.0 && bbox.east > 127.0);
  const latSpanMeters = geo.haversineDistanceMeters(bbox.south, 127.0, bbox.north, 127.0);
  assert.ok(Math.abs(latSpanMeters - 2000) < 50, `expected ~2000m span, got ${latSpanMeters}`);
});

test('pointInPolygon: point inside a simple square', () => {
  const square = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 1 },
    { lat: 1, lon: 1 },
    { lat: 1, lon: 0 },
  ];
  assert.equal(geo.pointInPolygon({ lat: 0.5, lon: 0.5 }, square), true);
  assert.equal(geo.pointInPolygon({ lat: 2, lon: 2 }, square), false);
});

test('pointToSegmentDistanceMeters: zero for a point on the segment, positive off it', () => {
  const a = { lat: 0, lon: 0 };
  const b = { lat: 0, lon: 0.01 };
  const onSegment = { lat: 0, lon: 0.005 };
  const off = { lat: 0.01, lon: 0.005 };
  assert.ok(geo.pointToSegmentDistanceMeters(onSegment, a, b) < 1);
  assert.ok(geo.pointToSegmentDistanceMeters(off, a, b) > 500);
});

test('pathLengthMeters: sums consecutive segment distances', () => {
  const path = [
    { lat: 0, lon: 0 },
    geo.destinationPoint(0, 0, 90, 100),
  ];
  const total = geo.pathLengthMeters(path);
  assert.ok(Math.abs(total - 100) < 1, `expected ~100m, got ${total}`);
});

test('pathLengthMeters: single point has zero length', () => {
  assert.equal(geo.pathLengthMeters([{ lat: 0, lon: 0 }]), 0);
});
