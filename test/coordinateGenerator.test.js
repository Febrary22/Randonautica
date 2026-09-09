'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyCandidates, isExcluded } = require('../src/coordinateGenerator');

test('classifyCandidates: falls back to "unknown" when there is no density signal at all', () => {
  // Regression test: this used to mislabel every candidate "crowded" when geo context was
  // unavailable (all densities stuck at 0, so the 0-vs-0 percentile comparison was trivially true).
  const candidates = [
    { density: { count: 0, interesting: false } },
    { density: { count: 0, interesting: false } },
    { density: { count: 0, interesting: false } },
  ];
  classifyCandidates(candidates);
  for (const c of candidates) {
    assert.equal(c.type, 'unknown');
    assert.equal(c.weight, 1);
  }
});

test('classifyCandidates: high-density candidates are marked crowded when there is real variance', () => {
  const candidates = [];
  for (let i = 0; i < 20; i++) candidates.push({ density: { count: 1, interesting: false } });
  for (let i = 0; i < 5; i++) candidates.push({ density: { count: 50, interesting: false } });
  classifyCandidates(candidates);
  const crowded = candidates.filter((c) => c.type === 'crowded');
  assert.ok(crowded.length > 0, 'expected at least one candidate classified as crowded');
  assert.ok(crowded.every((c) => c.density.count === 50));
});

test('classifyCandidates: isolated + interesting POI nearby is classified as anomaly', () => {
  const candidates = [];
  for (let i = 0; i < 20; i++) candidates.push({ density: { count: 10, interesting: false } });
  candidates.push({ density: { count: 0, interesting: true } });
  classifyCandidates(candidates);
  const last = candidates[candidates.length - 1];
  assert.equal(last.type, 'anomaly');
});

test('isExcluded: returns false (no exclusion) when geoContext is unavailable', () => {
  assert.equal(isExcluded({ lat: 0, lon: 0 }, null), false);
});

test('isExcluded: excludes a point inside a water polygon', () => {
  const geoContext = {
    waterPolygons: [
      [
        { lat: 0, lon: 0 },
        { lat: 0, lon: 0.01 },
        { lat: 0.01, lon: 0.01 },
        { lat: 0.01, lon: 0 },
      ],
    ],
    waterLines: [],
    majorRoads: [],
    pois: [],
  };
  assert.equal(isExcluded({ lat: 0.005, lon: 0.005 }, geoContext), true);
  assert.equal(isExcluded({ lat: 5, lon: 5 }, geoContext), false);
});

test('isExcluded: excludes a point close to a major road', () => {
  const geoContext = {
    waterPolygons: [],
    waterLines: [],
    majorRoads: [
      [
        { lat: 0, lon: 0 },
        { lat: 0, lon: 0.02 },
      ],
    ],
    pois: [],
  };
  assert.equal(isExcluded({ lat: 0.00001, lon: 0.01 }, geoContext), true); // ~1m from the road
  assert.equal(isExcluded({ lat: 0.01, lon: 0.01 }, geoContext), false); // ~1.1km away
});
