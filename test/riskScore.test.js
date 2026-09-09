'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeSimpleRiskAdvisory, ALERT_THRESHOLD } = require('../src/riskScore');

test('midday, full battery, non-isolated: no advisory', () => {
  const r = computeSimpleRiskAdvisory({ hour: 14, batteryLevel: 0.9, isolated: false });
  assert.equal(r.show, false);
  assert.equal(r.message, null);
});

test('deep night alone crosses the alert threshold', () => {
  const r = computeSimpleRiskAdvisory({ hour: 2, batteryLevel: 0.9, isolated: true });
  assert.ok(r.score >= ALERT_THRESHOLD, `expected score >= ${ALERT_THRESHOLD}, got ${r.score}`);
  assert.equal(r.show, true);
  assert.ok(r.message && r.message.length > 0);
});

test('low battery alone (daytime) is not enough by itself', () => {
  const r = computeSimpleRiskAdvisory({ hour: 14, batteryLevel: 0.1, isolated: false });
  assert.equal(r.show, false);
});

test('night + low battery stacks past the threshold', () => {
  const r = computeSimpleRiskAdvisory({ hour: 23, batteryLevel: 0.1, isolated: false });
  assert.equal(r.show, true);
  assert.ok(r.reasons.includes('night'));
  assert.ok(r.reasons.includes('low-battery'));
});

test('score is clamped to 100', () => {
  const r = computeSimpleRiskAdvisory({ hour: 3, batteryLevel: 0.05, isolated: true });
  assert.ok(r.score <= 100);
});
