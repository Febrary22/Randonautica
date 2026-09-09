'use strict';

const path = require('path');
const express = require('express');
const { generateAdventureCoordinate } = require('./coordinateGenerator');
const { computeSimpleRiskAdvisory } = require('./riskScore');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const MIN_RADIUS_KM = 0.3;
const MAX_RADIUS_KM = 5;

function isValidLatLon(lat, lon) {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

app.post('/api/adventure/start', async (req, res) => {
  const { lat, lon, batteryLevel, localHour } = req.body || {};
  let { radiusKm } = req.body || {};

  if (!isValidLatLon(lat, lon)) {
    return res.status(400).json({ error: 'lat/lon missing or out of range' });
  }
  radiusKm = Number(radiusKm);
  if (!Number.isFinite(radiusKm)) radiusKm = 1;
  radiusKm = Math.max(MIN_RADIUS_KM, Math.min(MAX_RADIUS_KM, radiusKm));

  try {
    const destination = await generateAdventureCoordinate({ lat, lon, radiusKm });

    const hour = Number.isFinite(localHour) ? localHour : new Date().getHours();
    const riskAdvisory = computeSimpleRiskAdvisory({
      hour,
      batteryLevel: typeof batteryLevel === 'number' ? batteryLevel : null,
      isolated: destination.type === 'void' || destination.type === 'anomaly',
    });

    res.json({ destination, riskAdvisory });
  } catch (err) {
    console.error('[adventure/start] failed:', err);
    res.status(500).json({ error: 'coordinate generation failed', detail: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n일탈 (Escapade) prototype server running at http://localhost:${PORT}`);
  console.log(
    'Geolocation requires a secure context on most mobile browsers. To test while walking ' +
      'outside, tunnel this port with e.g. `npx localtunnel --port ' +
      PORT +
      '` or `ngrok http ' +
      PORT +
      '` and open the HTTPS URL it gives you on your phone.\n'
  );
});

module.exports = app;
