// One-time local step: isolate the person from a blurred (bokeh) background and
// crop to head + torso. Keeps only the in-focus region, everything else -> transparent.
// Usage: node scripts/prep-photo.mjs [assets/photo.jpg]  ->  assets/photo-cutout.png
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = path.resolve(ROOT, process.argv[2] || 'assets/photo.jpg');
const out = path.join(ROOT, 'assets', 'photo-cutout.png');

const WIDTH = 600;
const { data: gray, info } = await sharp(input).rotate().resize(WIDTH).grayscale().extractChannel(0).raw()
  .toBuffer({ resolveWithObject: true });
const { width: w, height: h } = info;
const raw = { raw: { width: w, height: h, channels: 1 } };
const blur = async (buf, sigma) => (await sharp(buf, raw).blur(sigma).extractChannel(0).raw().toBuffer());

// 1. Focus energy: detail that disappears when blurred = sharp, in-focus pixels.
const soft = await blur(gray, 2.5);
const hf = Buffer.alloc(w * h);
for (let i = 0; i < hf.length; i++) hf[i] = Math.min(255, Math.abs(gray[i] - soft[i]) * 8);
const energy = await blur(hf, 10);

// 2. Threshold at a high percentile, then smooth into a solid silhouette.
const sorted = Uint8Array.from(energy).sort();
const thr = sorted[Math.floor(sorted.length * 0.62)];
let mask = Buffer.alloc(w * h);
for (let i = 0; i < mask.length; i++) mask[i] = energy[i] > thr ? 255 : 0;
mask = await blur(mask, 6);
for (let i = 0; i < mask.length; i++) mask[i] = mask[i] > 110 ? 255 : 0;

// 3. Fill gaps inside each row (between left- and right-most subject pixels).
for (let y = 0; y < h; y++) {
  let l = -1, r = -1;
  for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (l < 0) l = x; r = x; }
  if (l >= 0 && r - l < w * 0.9) for (let x = l; x <= r; x++) mask[y * w + x] = 255;
}
const feather = await blur(mask, 2);

// 4. Find the subject: rows where the silhouette is narrow (stop at wide in-focus
//    things such as a railing), then composite on white and crop.
const rowW = (y) => { let l = -1, r = -1; for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (l < 0) l = x; r = x; } return l < 0 ? [0, -1, -1] : [r - l, l, r]; };
let minY = -1, maxY = h - 1, minX = w, maxX = 0;
for (let y = 0; y < h; y++) {
  const [rw, l, r] = rowW(y);
  if (rw <= 0) { if (minY >= 0 && y - minY > 40) { maxY = y; break; } continue; }
  if (rw > w * 0.6) { if (minY >= 0) { maxY = y - 1; break; } continue; }
  if (minY < 0) minY = y;
  minX = Math.min(minX, l); maxX = Math.max(maxX, r);
}
const alpha = Buffer.alloc(w * h, 0);
for (let y = minY; y <= maxY; y++) for (let x = 0; x < w; x++) alpha[y * w + x] = feather[y * w + x];
const pad = 10;
const left = Math.max(0, minX - pad), top = Math.max(0, minY - pad);
const cw = Math.min(w - left, maxX - minX + pad * 2);
const ch = Math.min(h - top, maxY - top + 1);
const ga = Buffer.alloc(w * h * 2);
for (let i = 0; i < w * h; i++) { ga[i * 2] = gray[i]; ga[i * 2 + 1] = alpha[i]; }
await sharp(ga, { raw: { width: w, height: h, channels: 2 } }).extract({ left, top, width: cw, height: ch }).png().toFile(out);
await sharp(mask, raw).png().toFile(path.join(path.dirname(out), '..', 'node_modules', '.mask-debug.png')).catch(() => {});
console.log('wrote', path.relative(ROOT, out), `${cw}x${ch}`);
