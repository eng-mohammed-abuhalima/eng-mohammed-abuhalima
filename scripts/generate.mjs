// Builds assets/terminal-dark.svg and assets/terminal-light.svg from profile.json.
// Usage: node scripts/generate.mjs        (GITHUB_TOKEN set => live stats + heatmap)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'profile.json'), 'utf8'));

// ---------- themes ----------
const THEMES = {
  dark: {
    bgTop: '#111722', bgBottom: '#0b0f14', chrome: '#161b22', border: '#30363d',
    text: '#e6edf3', muted: '#7d8590', prompt: '#7ee787', key: '#79c0ff',
    name: '#d2a8ff', rule: '#21262d', asciiA: '#79c0ff', asciiB: '#d2a8ff',
    heat: ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'],
  },
  light: {
    bgTop: '#ffffff', bgBottom: '#f6f8fa', chrome: '#f6f8fa', border: '#d0d7de',
    text: '#1f2328', muted: '#656d76', prompt: '#1a7f37', key: '#0969da',
    name: '#8250df', rule: '#d8dee4', asciiA: '#0969da', asciiB: '#8250df',
    heat: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'],
  },
};

const PORTRAIT = cfg.portrait !== false;           // set "portrait": false for a text-only card
const CHROME_H = 38, PAD = 24;
const LEFT_W = PORTRAIT ? 400 : 0, RX = PORTRAIT ? LEFT_W + 32 : PAD + 8;
const W = RX + 544 + PAD;           // right panel x
const FS = 13.5, CW = FS * 0.6, LH = 22;        // right panel font metrics
const FONT = "ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, 'Liberation Mono', monospace";

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- ASCII portrait ----------
const RAMP = ' .,:;i1tfLCG08@';

async function sourceImage() {
  try {
    return await fs.readFile(path.join(ROOT, cfg.photo));
  } catch {
    // No photo yet: render the initials and turn those into ASCII instead.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#888"/></linearGradient></defs>
      <text x="320" y="200" fill="#fff" font-family="DejaVu Sans, Arial Black, Arial, sans-serif" font-weight="900"
        font-size="300" letter-spacing="12" text-anchor="middle" dominant-baseline="central">${esc(cfg.initials || "?")}</text></svg>`;
    return Buffer.from(svg);
  }
}

async function asciiArt(cols, cellAspect = 0.5) {
  const src = await sourceImage();
  const meta = await sharp(src).metadata();
  const rows = Math.round(cols * (meta.height / meta.width) * cellAspect);
  const size = (img) => img.resize(cols, rows, { fit: "fill" });
  const lum = await size(sharp(src).flatten({ background: "#ffffff" }).grayscale().clahe({ width: 24, height: 24 }))
    .extractChannel(0).raw().toBuffer();

  // Cutout with transparency: alpha says where the person is, brightness drives density.
  let alpha = null;
  if (meta.hasAlpha) alpha = await size(sharp(src).ensureAlpha().extractChannel(3)).raw().toBuffer();

  let invert = false, lo = 0, hi = 255;
  if (alpha) {
    const inside = [];
    for (let i = 0; i < lum.length; i++) if (alpha[i] > 128) inside.push(lum[i]);
    inside.sort((p, q) => p - q);
    lo = inside[Math.floor(inside.length * 0.02)] ?? 0;
    hi = inside[Math.floor(inside.length * 0.98)] ?? 255;
  } else {
    // Light border => light background => dense chars should follow the dark subject.
    let edge = 0, n = 0;
    for (let x = 0; x < cols; x++) { edge += lum[x] + lum[(rows - 1) * cols + x]; n += 2; }
    invert = edge / n > 127;
  }

  const lines = [];
  for (let y = 0; y < rows; y++) {
    let line = "";
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (alpha && alpha[i] < 60) { line += " "; continue; }
      let v = hi - lo < 16 ? alpha[i] / 255 : Math.min(1, Math.max(0, (lum[i] - lo) / Math.max(1, hi - lo)));
      if (invert) v = 1 - v;
      if (alpha) v = 0.12 + 0.88 * v;           // keep the silhouette visible in dark areas
      line += v < 0.08 ? " " : RAMP[Math.min(RAMP.length - 1, Math.floor(v * RAMP.length))];
    }
    lines.push(line);
  }
  return lines;
}

// ---------- GitHub stats ----------
function demoWeeks() {
  let s = 42;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return Array.from({ length: 53 }, (_, w) => Array.from({ length: 7 }, (_, d) => {
    const r = rnd() * (0.6 + 0.4 * Math.sin(w / 6));
    return d === 0 || d === 6 ? (r > 0.75 ? Math.round(r * 4) : 0) : (r > 0.3 ? Math.round(r * 12) : 0);
  }));
}

async function fetchStats() {
  const token = process.env.GITHUB_TOKEN;
  const login = process.env.GITHUB_USER || cfg.username;
  const fallback = { ...cfg.statsFallback, weeks: demoWeeks(), live: false };
  if (!token || !login || login === 'your-github-username') return fallback;

  const query = `query($login:String!){ user(login:$login){
    followers{totalCount}
    repositories(ownerAffiliations:OWNER, privacy:PUBLIC, first:100){ totalCount nodes{ stargazerCount } }
    contributionsCollection{ contributionCalendar{ totalContributions weeks{ contributionDays{ contributionCount } } } } } }`;
  try {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { login } }),
    });
    const u = (await res.json()).data.user;
    const cal = u.contributionsCollection.contributionCalendar;
    return {
      repos: u.repositories.totalCount,
      stars: u.repositories.nodes.reduce((a, r) => a + r.stargazerCount, 0),
      followers: u.followers.totalCount,
      contributions: cal.totalContributions,
      weeks: cal.weeks.map((w) => w.contributionDays.map((d) => d.contributionCount)),
      live: true,
    };
  } catch (e) {
    console.warn('GitHub API failed, using fallback stats:', e.message);
    return fallback;
  }
}

// ---------- SVG building blocks ----------
const fadeIn = (begin, inner) =>
  `<g opacity="0"><animate attributeName="opacity" from="0" to="1" begin="${begin.toFixed(2)}s" dur="0.25s" fill="freeze"/>${inner}</g>`;

let clipId = 0;
function typedCommand(y, cmd, begin, t) {
  const id = `c${clipId++}`;
  const x = RX + CW * 2;
  const n = cmd.length;
  const values = Array.from({ length: n + 1 }, (_, i) => (i * CW + (i === n ? 4 : 0)).toFixed(1)).join(';');
  const keyTimes = Array.from({ length: n + 1 }, (_, i) => (i / n).toFixed(4)).join(';');
  const dur = n * 0.055;
  const svg = fadeIn(begin, `<text x="${RX}" y="${y}" fill="${t.prompt}" font-weight="700">❯</text>`) +
    `<clipPath id="${id}"><rect x="${x}" y="${y - FS}" height="${LH}" width="0">` +
    `<animate attributeName="width" values="${values}" keyTimes="${keyTimes}" calcMode="discrete" begin="${begin.toFixed(2)}s" dur="${dur.toFixed(2)}s" fill="freeze"/></rect></clipPath>` +
    `<text x="${x}" y="${y}" fill="${t.text}" clip-path="url(#${id})" xml:space="preserve">${esc(cmd)}</text>`;
  return { svg, end: begin + dur + 0.25 };
}

function sectionRule(y, title, t) {
  const label = `─ ${title} `;
  const x2 = W - PAD;
  return `<text x="${RX}" y="${y}" fill="${t.key}" font-weight="700" xml:space="preserve">${esc(label)}</text>` +
    `<line x1="${RX + label.length * CW + 4}" y1="${y - 4.5}" x2="${x2}" y2="${y - 4.5}" stroke="${t.rule}"/>`;
}

// ---------- compose ----------
async function render(theme, ascii, stats) {
  clipId = 0;
  const t = THEMES[theme];
  const parts = [];
  let y = CHROME_H + PAD + 14;
  let time = 0.4;

  // $ whoami
  let c = typedCommand(y, 'whoami', time, t); parts.push(c.svg); time = c.end;
  y += LH;
  parts.push(fadeIn(time, `<text x="${RX}" y="${y}" font-size="17" font-weight="700" fill="${t.name}">${esc(cfg.name)}` +
    `<tspan fill="${t.muted}" font-weight="400" font-size="${FS}">  ·  ${esc(cfg.title)}</tspan></text>`));
  time += 0.35; y += LH * 1.6;

  // $ neofetch
  c = typedCommand(y, 'neofetch --profile', time, t); parts.push(c.svg); time = c.end;
  y += LH * 1.3;

  const keyCol = Math.max(...cfg.sections.flatMap((s) => (s.rows || []).map(([k]) => k.length))) + 3;
  for (const sec of cfg.sections) {
    if (sec.title) { parts.push(fadeIn(time, sectionRule(y, sec.title, t))); time += 0.06; y += LH; }
    for (const [k, v] of sec.rows || []) {
      parts.push(fadeIn(time, `<text x="${RX}" y="${y}" fill="${t.key}" font-weight="700">${esc(k)}</text>` +
        `<text x="${RX + keyCol * CW}" y="${y}" fill="${t.text}">${esc(v)}</text>`));
      time += 0.06; y += LH;
    }
    for (const b of sec.bullets || []) {
      parts.push(fadeIn(time, `<text x="${RX}" y="${y}" fill="${t.prompt}">▸</text>` +
        `<text x="${RX + 2 * CW}" y="${y}" fill="${t.text}">${esc(b)}</text>`));
      time += 0.06; y += LH;
    }
    y += 6;
  }

  // GitHub stats
  parts.push(fadeIn(time, sectionRule(y, 'GitHub', t))); time += 0.06; y += LH + 2;
  const items = [['Repos', stats.repos], ['Stars', stats.stars], ['Followers', stats.followers], ['Contribs/yr', stats.contributions]];
  const colW = (W - PAD - RX) / items.length;
  parts.push(fadeIn(time, items.map(([label, val], i) =>
    `<text x="${RX + i * colW}" y="${y}"><tspan fill="${t.text}" font-weight="700" font-size="16">${val}</tspan>` +
    `<tspan fill="${t.muted}" dx="6">${label}</tspan></text>`).join('')));
  time += 0.15; y += 16;

  // heatmap: last 53 weeks
  const weeks = stats.weeks.slice(-53);
  const all = weeks.flat().filter((n) => n > 0).sort((a, b) => a - b);
  const q = (p) => all[Math.floor(p * (all.length - 1))] ?? 1;
  const level = (n) => (n <= 0 ? 0 : n <= q(0.25) ? 1 : n <= q(0.5) ? 2 : n <= q(0.75) ? 3 : 4);
  const cell = 8, gap = 2.15;
  const heat = weeks.map((wk, wi) => fadeIn(time + wi * 0.018, wk.map((n, di) =>
    `<rect x="${(RX + wi * (cell + gap)).toFixed(1)}" y="${(y + di * (cell + gap)).toFixed(1)}" width="${cell}" height="${cell}" rx="2" fill="${t.heat[level(n)]}"/>`).join('')));
  parts.push(...heat);
  time += weeks.length * 0.018 + 0.1;
  y += 7 * (cell + gap) + 16;
  parts.push(fadeIn(time, `<text x="${RX}" y="${y}" fill="${t.muted}" font-size="11.5">${stats.contributions} contributions in the last year${stats.live ? '' : ' (sample data)'}</text>` +
    `<text x="${W - PAD - 5 * 12 - 66}" y="${y}" fill="${t.muted}" font-size="11.5">Less</text>` +
    t.heat.map((h, i) => `<rect x="${W - PAD - 5 * 12 - 36 + i * 12}" y="${y - 9}" width="9" height="9" rx="2" fill="${h}"/>`).join('') +
    `<text x="${W - PAD - 30}" y="${y}" fill="${t.muted}" font-size="11.5">More</text>`));
  time += 0.3; y += LH * 1.5;

  // final prompt + blinking cursor
  parts.push(fadeIn(time, `<text x="${RX}" y="${y}" fill="${t.prompt}" font-weight="700">❯</text>` +
    `<rect x="${RX + CW * 2}" y="${y - FS + 2}" width="${CW}" height="${FS + 2}" fill="${t.text}">` +
    `<animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.5;0.5;1" dur="1.1s" begin="${time.toFixed(2)}s" repeatCount="indefinite"/></rect>`));
  const rightBottom = y + PAD;

  // ASCII portrait (left)
  if (!PORTRAIT) ascii = [""];
  const cols = Math.max(1, ascii[0].length);
  const cellW = (LEFT_W - PAD * 2) / cols, asciiLH = cellW / 0.5, asciiFS = cellW / 0.6;
  const asciiH = ascii.length * asciiLH;
  const H = Math.ceil(PORTRAIT ? Math.max(rightBottom, CHROME_H + PAD * 2 + asciiH) : rightBottom);
  const ay = CHROME_H + (H - CHROME_H - asciiH) / 2;
  const scanDur = 2.4;
  const asciiRows = ascii.map((line, i) => line.trim() ? `<text x="${PAD}" y="${(ay + (i + 0.8) * asciiLH).toFixed(1)}" textLength="${(cols * cellW).toFixed(1)}" lengthAdjust="spacingAndGlyphs" xml:space="preserve">${esc(line)}</text>` : '').join('');

  const title = `${cfg.username}@github: ~`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" font-size="${FS}" role="img" aria-label="${esc(cfg.name)} – ${esc(cfg.title)}">
<title>${esc(cfg.name)} – ${esc(cfg.title)}</title>
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.bgTop}"/><stop offset="1" stop-color="${t.bgBottom}"/></linearGradient>
  <linearGradient id="ascii" gradientUnits="userSpaceOnUse" x1="${PAD}" y1="${ay}" x2="${LEFT_W - PAD}" y2="${ay + asciiH}"><stop offset="0" stop-color="${t.asciiA}"/><stop offset="1" stop-color="${t.asciiB}"/></linearGradient>
  <linearGradient id="scan" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.asciiA}" stop-opacity="0"/><stop offset="1" stop-color="${t.asciiA}" stop-opacity="0.35"/></linearGradient>
  <clipPath id="reveal"><rect x="0" y="${ay}" width="${LEFT_W}" height="0"><animate attributeName="height" from="0" to="${asciiH + 4}" begin="0.2s" dur="${scanDur}s" fill="freeze"/></rect></clipPath>
  <clipPath id="win"><rect width="${W}" height="${H}" rx="12"/></clipPath>
</defs>
<g clip-path="url(#win)">
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${CHROME_H}" fill="${t.chrome}"/>
  <line x1="0" y1="${CHROME_H}" x2="${W}" y2="${CHROME_H}" stroke="${t.border}"/>
  <circle cx="22" cy="${CHROME_H / 2}" r="6" fill="#ff5f57"/><circle cx="42" cy="${CHROME_H / 2}" r="6" fill="#febc2e"/><circle cx="62" cy="${CHROME_H / 2}" r="6" fill="#28c840"/>
  <text x="${W / 2}" y="${CHROME_H / 2 + 4}" fill="${t.muted}" font-size="12" text-anchor="middle">${esc(title)}  —  zsh</text>
  ${PORTRAIT ? `  <line x1="${LEFT_W + 8}" y1="${CHROME_H + PAD}" x2="${LEFT_W + 8}" y2="${H - PAD}" stroke="${t.rule}"/>
  <g clip-path="url(#reveal)" fill="url(#ascii)" font-size="${asciiFS.toFixed(2)}" font-weight="700">${asciiRows}</g>
  <rect x="0" y="${ay - 40}" width="${LEFT_W}" height="40" fill="url(#scan)" opacity="0">
    <animate attributeName="y" from="${ay - 40}" to="${ay + asciiH - 36}" begin="0.2s" dur="${scanDur}s" fill="freeze"/>
    <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.05;0.9;1" begin="0.2s" dur="${scanDur}s" fill="freeze"/>
  </rect>` : ""}
  ${parts.join('\n  ')}
</g>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="none" stroke="${t.border}"/>
</svg>`;
}

const ascii = PORTRAIT ? await asciiArt(cfg.asciiColumns || 76) : [""];
const stats = await fetchStats();
await fs.mkdir(path.join(ROOT, 'assets'), { recursive: true });
for (const theme of Object.keys(THEMES)) {
  const out = path.join(ROOT, 'assets', `terminal-${theme}.svg`);
  await fs.writeFile(out, await render(theme, ascii, stats));
  console.log('wrote', path.relative(ROOT, out));
}
