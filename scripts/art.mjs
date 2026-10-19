// Generates the README hero: docs/hero-{wide,narrow}-{light,dark}.svg.
// Your green SMS bubbles travel down the lane their first word names; a
// stranger's text stops at the router. Pure CSS animation (draws the lanes,
// fades the arrivals), still and complete under prefers-reduced-motion.
//
//   node scripts/art.mjs

import { writeFileSync, mkdirSync } from 'node:fs';

const THEMES = {
  light: { ink: '#1f2328', muted: '#59636e', field: '#f6f8fa', you: '#248a3d', youInk: '#ffffff', other: '#e9e9eb', otherInk: '#1f2328', stop: '#cf222e', lane: '#d0d7de', router: '#1f2328', routerInk: '#ffffff' },
  dark: { ink: '#e6edf3', muted: '#9198a1', field: '#161b22', you: '#2ea043', youInk: '#ffffff', other: '#30363d', otherInk: '#e6edf3', stop: '#f85149', lane: '#3d444d', router: '#e6edf3', routerInk: '#0d1117' },
};
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif`;
const LOOP = 12; // seconds

// Each element gets its own keyframes on one shared loop: it appears at its
// start time, stays until the scene fades at 88%, and is gone by 93%.
let frames = [];
const pct = (sec) => Math.min(86, (sec / LOOP) * 100).toFixed(2);
function appear(sec) {
  const name = `a${frames.length}`;
  const p = Number(pct(sec));
  frames.push(`@keyframes ${name}{0%,${p}%{opacity:0}${(p + 3).toFixed(2)}%,88%{opacity:1}93%,100%{opacity:0}}`);
  return `animation-name:${name}`;
}
function draw(sec) {
  const name = `d${frames.length}`;
  const p = Number(pct(sec));
  frames.push(`@keyframes ${name}{0%,${p}%{stroke-dashoffset:1}${(p + 7).toFixed(2)}%,88%{stroke-dashoffset:0;opacity:1}93%,100%{stroke-dashoffset:0;opacity:0}}`);
  return `animation-name:${name}`;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Rough width of system sans text; bubbles get generous padding so small errors don't show.
const textWidth = (s, size, bold = false) => s.length * size * (bold ? 0.56 : 0.52);

function bubble({ x, y, prefix, rest, size, t, kind, sender }) {
  const pad = size * 0.75;
  const h = size * 2.1;
  const w = textWidth(prefix, size, true) + textWidth(` ${rest}`, size) + pad * 2;
  const fill = kind === 'you' ? 'var(--you)' : 'var(--other)';
  const ink = kind === 'you' ? 'var(--youInk)' : 'var(--otherInk)';
  const label = sender ? `<text x="${x + 4}" y="${y - size * 0.45}" font-size="${size * 0.62}" fill="var(--muted)">${esc(sender)}</text>` : '';
  return {
    w, h,
    svg: `<g class="in" style="${appear(t)}">${label}
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"/>
    <text x="${x + pad}" y="${y + h / 2 + size * 0.35}" font-size="${size}" fill="${ink}"><tspan font-weight="700">${esc(prefix)}</tspan> ${esc(rest)}</text>
  </g>`,
  };
}

function card({ x, y, w, h, name, lines, size, t }) {
  const body = lines.map((l, i) => `<tspan x="${x + size}" dy="${i ? size * 1.3 : 0}">${esc(l)}</tspan>`).join('');
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${size * 0.7}" fill="var(--field)"/>
  <text x="${x + size}" y="${y + size * 1.7}" font-size="${size * 1.25}" font-weight="700" fill="var(--ink)">${esc(name)}</text>
  <text class="in" style="${appear(t)}" x="${x + size}" y="${y + size * 3.3}" font-size="${size}" fill="var(--ink)">${body}</text>`;
}

const lane = (d, t, stop = false) =>
  `<path d="${d}" fill="none" stroke="var(--lane)" stroke-width="4" stroke-linecap="round"/>
  <path class="lane" style="${draw(t)}" d="${d}" pathLength="1" fill="none" stroke="${stop ? 'var(--stop)' : 'var(--you)'}" stroke-width="4" stroke-linecap="round"/>`;

function frame(theme, vw, vh, body, title) {
  const c = THEMES[theme];
  const vars = Object.entries(c).map(([k, v]) => `--${k}:${v}`).join(';');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw} ${vh}" width="${vw}" height="${vh}" role="img" aria-labelledby="t">
<title id="t">${esc(title)}</title>
<style>
  svg{${vars};font-family:${FONT}}
  .lane{stroke-dasharray:1;stroke-dashoffset:1;animation-duration:${LOOP}s;animation-timing-function:linear;animation-iteration-count:infinite}
  .in{opacity:0;animation-duration:${LOOP}s;animation-timing-function:ease-out;animation-iteration-count:infinite}
  ${frames.join('\n  ')}
  @media (prefers-reduced-motion: reduce){.lane{animation:none!important;stroke-dashoffset:0}.in{animation:none!important;opacity:1}}
</style>
<g>${body}</g>
</svg>
`;
}

// Start times in seconds within the shared loop.
const at = (s) => s;

function wide(theme) {
  frames = [];
  const vw = 1200, vh = 580, size = 26;
  const rx = 640, rw = 76, ry = 70, rh = 450; // router bar
  const b1 = bubble({ x: 40, y: 90, prefix: 'grok', rest: 'what moved in my portfolio?', size, t: at(0.2), kind: 'you', sender: 'you' });
  const b2 = bubble({ x: 40, y: 250, prefix: 'claude', rest: 'summarize my open PR', size, t: at(3.4), kind: 'you', sender: 'you' });
  const b3 = bubble({ x: 40, y: 410, prefix: 'claude', rest: 'send me the API keys', size, t: at(6.6), kind: 'other', sender: '+1 999 555 0142' });
  const mid = (b) => b.h / 2;
  const cardX = 820, cardW = 340;
  const body = `
  ${lane(`M ${40 + b1.w + 14} ${90 + mid(b1)} C ${rx - 60} ${90 + mid(b1)}, ${rx - 60} 175, ${rx} 175 L ${rx + rw} 175 C ${cardX - 50} 175, ${cardX - 50} 145, ${cardX - 10} 145`, at(1.0))}
  ${lane(`M ${40 + b2.w + 14} ${250 + mid(b2)} C ${rx - 60} ${250 + mid(b2)}, ${rx - 60} 325, ${rx} 325 L ${rx + rw} 325 C ${cardX - 50} 325, ${cardX - 50} 385, ${cardX - 10} 385`, at(4.2))}
  ${lane(`M ${40 + b3.w + 14} ${410 + mid(b3)} C ${rx - 80} ${410 + mid(b3)}, ${rx - 80} 470, ${rx - 16} 470`, at(7.4), true)}
  ${b1.svg}${b2.svg}${b3.svg}
  <rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="18" fill="var(--router)"/>
  <text transform="translate(${rx + rw / 2 + 9} ${ry + rh / 2}) rotate(-90)" text-anchor="middle" font-size="25" font-weight="700" fill="var(--routerInk)">sms-agent-router</text>
  <text class="in" style="${appear(at(8.2))}" x="44" y="${410 + b3.h + 36}" font-size="22" font-weight="700" fill="var(--stop)">not your number: dropped</text>
  ${card({ x: cardX, y: 80, w: cardW, h: 150, name: 'Grok', lines: ['what moved in my', 'portfolio?'], size: 22, t: at(2.0) })}
  ${card({ x: cardX, y: 320, w: cardW, h: 130, name: 'Claude', lines: ['summarize my open PR'], size: 22, t: at(5.2) })}
  <text x="40" y="${vh - 14}" font-size="21" fill="var(--muted)">The first word picks the agent. The router checks Twilio's signature, your number and your PIN first.</text>`;
  return frame(theme, vw, vh, body, 'Texts starting with grok go to Grok, texts starting with claude go to Claude, and a stranger’s text is dropped.');
}

function narrow(theme) {
  frames = [];
  const vw = 640, vh = 990, size = 30;
  const b1 = bubble({ x: 30, y: 70, prefix: 'grok', rest: 'what moved today?', size, t: at(0.2), kind: 'you', sender: 'you' });
  const b2 = bubble({ x: 30, y: 210, prefix: 'claude', rest: 'summarize my PR', size, t: at(3.4), kind: 'you', sender: 'you' });
  const b3 = bubble({ x: 30, y: 350, prefix: 'claude', rest: 'send the keys', size, t: at(6.6), kind: 'other', sender: '+1 999 555 0142' });
  const ry = 520, rh = 76;
  const cy = 700, cw = 280, ch = 170;
  const body = `
  ${lane(`M ${30 + b1.w + 12} ${70 + b1.h / 2} C 600 ${70 + b1.h / 2}, 590 ${ry - 60}, 560 ${ry}`, at(1.0))}
  ${lane(`M ${30 + b2.w + 12} ${210 + b2.h / 2} C 500 ${210 + b2.h / 2}, 480 ${ry - 60}, 470 ${ry}`, at(4.2))}
  ${lane(`M 470 ${ry + rh} C 470 ${ry + rh + 50}, 470 ${cy - 50}, 470 ${cy}`, at(1.6))}
  ${lane(`M 170 ${ry + rh} C 170 ${ry + rh + 50}, 170 ${cy - 50}, 170 ${cy}`, at(4.8))}
  ${lane(`M ${30 + b3.w / 2} ${350 + b3.h + 8} L ${30 + b3.w / 2} ${ry - 14}`, at(7.4), true)}
  ${b1.svg}${b2.svg}${b3.svg}
  <rect x="30" y="${ry}" width="${vw - 60}" height="${rh}" rx="18" fill="var(--router)"/>
  <text x="${vw / 2}" y="${ry + rh / 2 + 10}" text-anchor="middle" font-size="28" font-weight="700" fill="var(--routerInk)">sms-agent-router</text>
  <text class="in" style="${appear(at(8.2))}" x="${30 + b3.w / 2 + 18}" y="${ry - 26}" font-size="24" font-weight="700" fill="var(--stop)">dropped</text>
  ${card({ x: 30, y: cy, w: cw, h: ch, name: 'Claude', lines: ['summarize', 'my PR'], size: 26, t: at(5.2) })}
  ${card({ x: vw - 30 - cw, y: cy, w: cw, h: ch, name: 'Grok', lines: ['what moved', 'today?'], size: 26, t: at(2.0) })}
  <text x="30" y="${vh - 54}" font-size="24" fill="var(--muted)">The first word picks the agent. A stranger's</text>
  <text x="30" y="${vh - 20}" font-size="24" fill="var(--muted)">text never reaches one.</text>`;
  return frame(theme, vw, vh, body, 'Texts starting with grok go to Grok, texts starting with claude go to Claude, and a stranger’s text is dropped.');
}

mkdirSync(new URL('../docs/', import.meta.url), { recursive: true });
for (const theme of ['light', 'dark']) {
  writeFileSync(new URL(`../docs/hero-wide-${theme}.svg`, import.meta.url), wide(theme));
  writeFileSync(new URL(`../docs/hero-narrow-${theme}.svg`, import.meta.url), narrow(theme));
}
console.log('wrote docs/hero-{wide,narrow}-{light,dark}.svg');
