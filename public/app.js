'use strict';

/**
 * 일탈 (Escapade) — prototype client.
 *
 * This duplicates a few pure geo helpers from src/geo.js (haversine distance, bearing) rather
 * than sharing a module, since this is a plain <script> with no bundler. Keep the two in sync if
 * you touch the math. Everything here is a deliberately simplified stand-in for the full native
 * design in docs/GAME_DESIGN.md — see the comments at each simplification (background tracking
 * via HealthKit/Health Connect per §3, real risk scoring per §2.4, GPS anti-cheat per §9, etc.
 * are NOT implemented here; this demonstrates the core loop only).
 */

// ---------- geo helpers ----------

function toRad(d) { return (d * Math.PI) / 180; }
function toDeg(r) { return (r * 180) / Math.PI; }

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1), phi2 = toRad(lat2), dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return ((toDeg(Math.atan2(y, x)) % 360) + 360) % 360;
}

function compassWord(deg) {
  const words = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
  return words[Math.round(deg / 45) % 8];
}

// ---------- constants (see docs/GAME_DESIGN.md §4.2 for the beep formula, §2.1 for arrival) ----------

const ARRIVAL_RADIUS_M = 20;
const BEEP_THRESHOLD_RADIUS_M = 400;
const BEEP_MAX_INTERVAL_S = 4.5;
const BEEP_MIN_INTERVAL_S = 3; // §4.2: relaxed to 2-4s per the user's request, not the frantic 0.15-0.3s draft
const BEEP_EXPONENT_K = 2.5;
const AVG_STRIDE_M = 0.72; // used only for the GPS-based step estimate, see stat-steps caveat in the UI

// ---------- state ----------

const state = {
  radiusKm: 1,
  origin: null,
  destination: null,
  path: [],
  watchId: null,
  startTime: null,
  endTime: null,
  muted: false,
  arrived: false,
  shared: false,
  rating: 0,
  audioCtx: null,
  nextBeepAt: 0,
  beepTickHandle: null,
  compassHeading: null, // null = no device orientation available, fall back to text hint
  map: null,
};

// ---------- screen management ----------

const screens = ['home', 'generating', 'approach', 'result'];
function showScreen(name) {
  for (const s of screens) {
    document.getElementById(`screen-${s}`).hidden = s !== name;
  }
}

// ---------- risk banner ----------

function showRiskBanner(message) {
  document.getElementById('risk-banner-text').textContent = message;
  document.getElementById('risk-banner').hidden = false;
}
document.getElementById('risk-banner-dismiss').addEventListener('click', () => {
  document.getElementById('risk-banner').hidden = true;
});

// ---------- home screen ----------

const radiusInput = document.getElementById('radius');
const radiusValue = document.getElementById('radius-value');
radiusInput.addEventListener('input', () => {
  state.radiusKm = parseFloat(radiusInput.value);
  radiusValue.textContent = state.radiusKm.toFixed(1);
});

function getBatteryLevel() {
  if (!navigator.getBattery) return Promise.resolve(null);
  return navigator.getBattery().then((b) => b.level).catch(() => null);
}

function requestOrientationPermissionIfNeeded() {
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    return DeviceOrientationEvent.requestPermission().catch(() => 'denied');
  }
  return Promise.resolve('granted'); // Android / non-iOS-13+: no explicit permission step
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0,
    });
  });
}

document.getElementById('start-btn').addEventListener('click', async () => {
  const errorEl = document.getElementById('home-error');
  errorEl.hidden = true;

  if (!navigator.geolocation) {
    errorEl.textContent = '이 브라우저는 위치 기능을 지원하지 않습니다.';
    errorEl.hidden = false;
    return;
  }

  // Both permission prompts must be requested from this click (user-gesture requirement on iOS).
  requestOrientationPermissionIfNeeded().then((perm) => {
    state.compassHeading = perm === 'granted' ? null : undefined; // undefined = permanently unavailable
  });

  showScreen('generating');
  document.getElementById('loading-text').textContent = '위치를 확인하는 중…';

  let position;
  try {
    position = await getCurrentPosition();
  } catch (err) {
    showScreen('home');
    errorEl.textContent = '위치 권한이 필요합니다. 브라우저 설정에서 위치 접근을 허용해주세요.';
    errorEl.hidden = false;
    return;
  }

  state.origin = { lat: position.coords.latitude, lon: position.coords.longitude };
  document.getElementById('loading-text').textContent = '안전한 미지의 좌표를 계산하는 중…';

  const batteryLevel = await getBatteryLevel();

  let data;
  try {
    const res = await fetch('/api/adventure/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: state.origin.lat,
        lon: state.origin.lon,
        radiusKm: state.radiusKm,
        batteryLevel,
        localHour: new Date().getHours(),
      }),
    });
    if (!res.ok) throw new Error(`server responded ${res.status}`);
    data = await res.json();
  } catch (err) {
    showScreen('home');
    errorEl.textContent = '좌표 생성에 실패했어요. 잠시 후 다시 시도해주세요. (' + err.message + ')';
    errorEl.hidden = false;
    return;
  }

  state.destination = data.destination;
  if (data.riskAdvisory && data.riskAdvisory.show) {
    showRiskBanner(data.riskAdvisory.message);
  }

  startAdventure();
});

// ---------- approach screen ----------

function startAdventure() {
  state.path = [{ ...state.origin, t: Date.now() }];
  state.startTime = Date.now();
  state.endTime = null;
  state.arrived = false;
  state.shared = false;
  state.rating = 0;

  document.getElementById('destination-type').textContent = destinationTypeLabel(state.destination.type);

  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    state.audioCtx = new AudioCtx();
  } catch {
    state.audioCtx = null; // beep will silently no-op; vibration mode still works
  }

  showScreen('approach');
  updateApproachUI(state.origin);

  state.watchId = navigator.geolocation.watchPosition(onPositionUpdate, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 20000,
  });

  window.addEventListener('deviceorientationabsolute', onOrientation, true);
  window.addEventListener('deviceorientation', onOrientation, true);

  state.nextBeepAt = 0;
  state.beepTickHandle = setInterval(beepTick, 250);
}

function destinationTypeLabel(type) {
  const labels = {
    attractor: '이야기가 남은 곳',
    void: '고요한 곳',
    anomaly: '이상 지점',
    crowded: '북적이는 곳',
    unknown: '알 수 없는 곳',
  };
  return labels[type] || '';
}

function onPositionError() {
  // Don't interrupt the adventure over a transient GPS hiccup — just keep the last known distance.
}

function onPositionUpdate(position) {
  const p = { lat: position.coords.latitude, lon: position.coords.longitude, t: Date.now() };
  state.path.push(p);
  updateApproachUI(p);

  const d = haversineMeters(p.lat, p.lon, state.destination.lat, state.destination.lon);
  if (d <= ARRIVAL_RADIUS_M && !state.arrived) {
    arrive();
  }
}

function onOrientation(event) {
  let heading = null;
  if (typeof event.webkitCompassHeading === 'number') {
    heading = event.webkitCompassHeading; // iOS Safari: already a compass heading (0 = north)
  } else if (event.absolute && typeof event.alpha === 'number') {
    heading = (360 - event.alpha) % 360; // common Android approximation, not exact on every device
  }
  if (heading !== null) state.compassHeading = heading;
}

function updateApproachUI(currentPos) {
  const d = haversineMeters(currentPos.lat, currentPos.lon, state.destination.lat, state.destination.lon);
  document.getElementById('distance-value').textContent = Math.round(d);

  const bearing = bearingDeg(currentPos.lat, currentPos.lon, state.destination.lat, state.destination.lon);
  const arrowEl = document.getElementById('compass-arrow');
  const fallbackEl = document.getElementById('bearing-fallback');

  if (typeof state.compassHeading === 'number') {
    arrowEl.style.transform = `rotate(${bearing - state.compassHeading}deg)`;
    fallbackEl.hidden = true;
  } else {
    // No device compass: keep the arrow pointing up and tell the user the absolute direction instead.
    arrowEl.style.transform = 'rotate(0deg)';
    fallbackEl.textContent = `목표 방향: ${compassWord(bearing)}쪽 (${Math.round(bearing)}°)`;
    fallbackEl.hidden = false;
  }
}

// ---------- beep engine (docs/GAME_DESIGN.md §4) ----------

function beepInterval(distanceM) {
  const clamped = Math.max(0, Math.min(BEEP_THRESHOLD_RADIUS_M, distanceM));
  const t = clamped / BEEP_THRESHOLD_RADIUS_M;
  return BEEP_MIN_INTERVAL_S + (BEEP_MAX_INTERVAL_S - BEEP_MIN_INTERVAL_S) * Math.pow(t, BEEP_EXPONENT_K);
}

function beepTick() {
  if (state.arrived || !state.path.length) return;
  const last = state.path[state.path.length - 1];
  const d = haversineMeters(last.lat, last.lon, state.destination.lat, state.destination.lon);
  if (d > BEEP_THRESHOLD_RADIUS_M) return; // §4.1: complete silence outside the threshold radius

  const now = Date.now();
  if (now >= state.nextBeepAt) {
    playCue('beep');
    state.nextBeepAt = now + beepInterval(d) * 1000;
  }
}

function playCue(kind) {
  if (state.muted) {
    if (navigator.vibrate) navigator.vibrate(kind === 'arrival' ? [80, 60, 80, 60, 160] : 70);
    return;
  }
  if (!state.audioCtx) return;
  const ctx = state.audioCtx;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = kind === 'arrival' ? 660 : 1046;
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(0.35, ctx.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (kind === 'arrival' ? 0.5 : 0.15));
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + (kind === 'arrival' ? 0.55 : 0.2));
}

document.getElementById('mute-btn').addEventListener('click', (e) => {
  state.muted = !state.muted;
  e.target.classList.toggle('active', state.muted);
  e.target.textContent = state.muted ? '🔈 소리 모드로 전환' : '🔇 무음(진동) 모드';
});

document.getElementById('giveup-btn').addEventListener('click', () => {
  endAdventure(false);
});

function arrive() {
  state.arrived = true;
  playCue('arrival');
  endAdventure(true);
  setTimeout(showResult, 1200);
}

function endAdventure(reached) {
  state.endTime = Date.now();
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  clearInterval(state.beepTickHandle);
  window.removeEventListener('deviceorientationabsolute', onOrientation, true);
  window.removeEventListener('deviceorientation', onOrientation, true);
  if (!reached) showResult();
}

// ---------- result screen ----------

function formatDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function pathLengthMeters(path) {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += haversineMeters(path[i - 1].lat, path[i - 1].lon, path[i].lat, path[i].lon);
  }
  return total;
}

function computeResultStats() {
  const distanceM = pathLengthMeters(state.path);
  const steps = Math.round(distanceM / AVG_STRIDE_M);
  const basePoints = Math.round(steps / 10);
  const points = state.shared ? Math.round(basePoints * 1.5) : basePoints;
  return { distanceM, steps, basePoints, points };
}

function showResult() {
  const { distanceM, steps, points } = computeResultStats();

  document.getElementById('stat-time').textContent = formatDuration((state.endTime || Date.now()) - state.startTime);
  document.getElementById('stat-distance').textContent =
    distanceM >= 1000 ? `${(distanceM / 1000).toFixed(2)}km` : `${Math.round(distanceM)}m`;
  document.getElementById('stat-steps').textContent = steps.toLocaleString();
  document.getElementById('stat-points').textContent = points.toLocaleString();

  document.getElementById('share-status').hidden = true;
  document.getElementById('share-btn').disabled = false;
  resetStars();

  showScreen('result');
  renderResultMap();
}

function resetStars() {
  state.rating = 0;
  document.querySelectorAll('#stars span').forEach((el) => el.classList.remove('filled'));
}

document.getElementById('stars').addEventListener('click', (e) => {
  const star = e.target.closest('[data-star]');
  if (!star) return;
  state.rating = parseInt(star.dataset.star, 10);
  document.querySelectorAll('#stars span').forEach((el) => {
    el.classList.toggle('filled', parseInt(el.dataset.star, 10) <= state.rating);
  });
});

document.getElementById('share-btn').addEventListener('click', async () => {
  const { steps, distanceM } = computeResultStats();
  const shareText = `일탈에서 ${steps.toLocaleString()}걸음, ${(distanceM / 1000).toFixed(2)}km를 걸어 미지의 좌표에 도착했어요.`;
  let shared = false;

  if (navigator.share) {
    try {
      await navigator.share({ title: '일탈 (Escapade)', text: shareText });
      shared = true;
    } catch {
      shared = false; // user cancelled the share sheet — no bonus, per §7 spirit (best-effort, not enforced)
    }
  } else if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(shareText);
      shared = true;
    } catch {
      shared = false;
    }
  }

  if (shared && !state.shared) {
    state.shared = true;
    document.getElementById('share-btn').disabled = true;
    const status = document.getElementById('share-status');
    status.textContent = navigator.share ? '공유 완료! 포인트가 1.5배 지급됐어요.' : '공유 문구가 복사됐어요. 포인트가 1.5배 지급됐어요.';
    status.hidden = false;
    const { points } = computeResultStats();
    document.getElementById('stat-points').textContent = points.toLocaleString();
  }
});

document.getElementById('new-adventure-btn').addEventListener('click', () => {
  if (state.map) {
    state.map.remove();
    state.map = null;
  }
  showScreen('home');
});

function renderResultMap() {
  const container = document.getElementById('result-map');
  if (state.map) {
    state.map.remove();
    state.map = null;
  }
  if (typeof maplibregl === 'undefined') {
    container.textContent = '지도를 불러올 수 없어요 (스크립트 로드 실패).';
    return;
  }

  try {
    const map = new maplibregl.Map({
      container,
      style: 'https://demotiles.maplibre.org/style.json',
      center: [state.destination.lon, state.destination.lat],
      zoom: 14,
      attributionControl: false,
    });
    state.map = map;

    map.on('error', () => {
      container.innerHTML = '<p style="color:#7c928c;font-size:0.8rem;padding:12px;">지도를 불러올 수 없어요 — 오프라인이거나 네트워크 문제일 수 있어요.</p>';
    });

    map.on('load', () => {
      const coords = state.path.map((p) => [p.lon, p.lat]);
      map.addSource('path', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } } });
      map.addLayer({ id: 'path-line', type: 'line', source: 'path', paint: { 'line-color': '#4fd8b8', 'line-width': 3 } });

      new maplibregl.Marker({ color: '#4fd8b8' }).setLngLat([state.origin.lon, state.origin.lat]).addTo(map);
      new maplibregl.Marker({ color: '#d87c4f' }).setLngLat([state.destination.lon, state.destination.lat]).addTo(map);

      const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
      map.fitBounds(bounds, { padding: 40, maxZoom: 17 });
    });
  } catch (err) {
    container.textContent = '지도를 불러올 수 없어요.';
  }
}
