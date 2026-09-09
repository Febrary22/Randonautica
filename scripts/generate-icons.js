'use strict';

/**
 * Generates the PWA icon set (public/icons/*.png) as a simple procedural "glowing anomaly orb"
 * matching the dark/damp mood in public/style.css — no external art asset or image tool needed,
 * just pixel math. Run with `npm run generate-icons` whenever the mark needs regenerating; the
 * output PNGs are committed to the repo so nobody needs pngjs installed just to run the app.
 */

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const BG = { r: 0x05, g: 0x08, b: 0x0a }; // --bg
const GLOW = { r: 0x4f, g: 0xd8, b: 0xb8 }; // --accent

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * @param {number} size
 * @param {{ maskable?: boolean }} [opts] Android adaptive icons ("maskable" in the manifest) can be
 *   cropped to a circle/squircle/rounded-square by the launcher, and only the center ~80% "safe
 *   zone" is guaranteed visible. Regular icons can use the full canvas; maskable ones shrink the
 *   orb so nothing important sits in the part a launcher might crop away.
 */
function generateIcon(size, { maskable = false } = {}) {
  const png = new PNG({ width: size, height: size });
  const cx = size / 2;
  const cy = size / 2;
  const safeZoneScale = maskable ? 0.8 : 1; // keeps the ring within Android's ~80% safe-zone circle
  const coreR = size * 0.14 * safeZoneScale;
  const glowR = size * 0.42 * safeZoneScale;
  const ringR = size * 0.46 * safeZoneScale;
  const ringWidth = Math.max(1, size * 0.015);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      let r, g, b;
      if (dist <= coreR) {
        ({ r, g, b } = GLOW);
      } else if (dist <= glowR) {
        const t = (dist - coreR) / (glowR - coreR);
        r = lerp(GLOW.r, BG.r, t);
        g = lerp(GLOW.g, BG.g, t);
        b = lerp(GLOW.b, BG.b, t);
      } else {
        ({ r, g, b } = BG);
      }

      const ringDist = Math.abs(dist - ringR);
      if (ringDist < ringWidth) {
        const ringT = ringDist / ringWidth;
        r = lerp(GLOW.r, r, ringT);
        g = lerp(GLOW.g, g, ringT);
        b = lerp(GLOW.b, b, ringT);
      }

      const idx = (size * y + x) << 2;
      png.data[idx] = Math.round(r);
      png.data[idx + 1] = Math.round(g);
      png.data[idx + 2] = Math.round(b);
      png.data[idx + 3] = 255; // fully opaque square — safe for iOS home-screen icons (no transparency)
    }
  }
  return png;
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

// 192/512: standard PWA manifest sizes. 180: iOS apple-touch-icon convention.
for (const size of [180, 192, 512]) {
  const png = generateIcon(size);
  const outPath = path.join(outDir, `icon-${size}.png`);
  png.pack().pipe(fs.createWriteStream(outPath)).on('finish', () => {
    console.log(`wrote ${outPath}`);
  });
}

// Maskable variants: used for Android's adaptive-icon system (and TWA/Play Store packaging via
// tools like PWABuilder), which crops icons to the launcher's shape and only guarantees the
// center ~80% is visible.
for (const size of [192, 512]) {
  const png = generateIcon(size, { maskable: true });
  const outPath = path.join(outDir, `icon-${size}-maskable.png`);
  png.pack().pipe(fs.createWriteStream(outPath)).on('finish', () => {
    console.log(`wrote ${outPath}`);
  });
}
