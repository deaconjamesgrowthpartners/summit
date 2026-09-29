// Brand colors in, a full set of tokens out, for light and dark.
// Every text token is fitted against every background it can sit on,
// so no pairing on any screen drops below AA (4.5:1) for any brand.

export const AA = 4.5;
const TARGET = 4.6; // a hair over AA so rounding never lands under
const INK_TARGET = 7;

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function rgb(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
const toHex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

// a with t of b mixed in
export const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };

export function lum(hex) {
  const [r, g, b] = rgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
const worst = (fg, bgs) => Math.min(...bgs.map((b) => contrast(fg, b)));

// push a color toward black (on light grounds) or white (on dark) until it clears target on every background
export function fit(start, bgs, target = TARGET) {
  const dark = bgs.reduce((s, b) => s + lum(b), 0) / bgs.length < 0.18;
  const end = dark ? '#ffffff' : '#000000';
  for (let t = 0; t <= 1.0001; t += 0.01) {
    const c = mix(start, end, t);
    if (worst(c, bgs) >= target) return c;
  }
  return end;
}
// the first candidate that clears target, else the fitted best
function pick(cands, bgs, target = TARGET) {
  const ok = cands.find((c) => worst(c, bgs) >= target);
  if (ok) return ok;
  const best = [...cands].sort((a, b) => worst(b, bgs) - worst(a, bgs))[0];
  return fit(best, bgs, target);
}

const col = (v, d) => (typeof v === 'string' && HEX.test(v) ? v : d);

// light mode sits on light ground and dark mode on dark ground, whatever the brand says,
// so one dark ink (or one light ink) works on every surface of that mode.
function lightGround(c, min = 0.72) {
  for (let t = 0; t <= 1.0001; t += 0.02) { const x = mix(c, '#ffffff', t); if (lum(x) >= min) return x; }
  return '#ffffff';
}
function darkGround(c, max = 0.03) {
  for (let t = 0; t <= 1.0001; t += 0.02) { const x = mix(c, '#000000', t); if (lum(x) <= max) return x; }
  return '#000000';
}

// status fills are fixed (they are meaning, not brand). their text is fitted.
const STATUS = {
  light: { red: '#B3261E', redBg: '#F6DCD9', yellow: '#B8860B', yellowBg: '#F5E7C1', ok: '#2F7D32', okBg: '#D6EBD6', grey: '#C9C4B6', locked: '#7A5B3A' },
  dark: { red: '#F28B82', redBg: '#3A1C19', yellow: '#E2B75A', yellowBg: '#3A2F12', ok: '#7BC47F', okBg: '#1B3A1C', grey: '#4A5448', locked: '#7A5B3A' },
};

function build(mode, b) {
  const head = col(b.head, '#2B2B2B');
  const accentIn = col(b.accent, '#3A6EA5');
  const s = STATUS[mode];
  let bg, surface, surface2;
  if (mode === 'light') {
    bg = lightGround(col(b.bg, '#F5F5F2'));
    surface = lightGround(col(b.surface, '#FFFFFF'), 0.8);
    surface2 = lightGround(col(b.panel, '#ECECE8'), 0.65);
  } else {
    // tinted by the brand header, always dark
    bg = darkGround(head, 0.012);
    surface = darkGround(mix(head, '#000000', 0.3), 0.022);
    surface2 = darkGround(mix(head, '#000000', 0.15), 0.035);
  }
  const rowHover = mix(surface, surface2, 0.5);
  const grounds = [bg, surface, surface2, rowHover];
  const light = mode === 'light';

  // text on the page
  const ink = fit(col(b.ink, light ? mix(head, '#000000', 0.3) : '#EDEBE3'), [...grounds, s.redBg, s.yellowBg, s.okBg], INK_TARGET);
  const ink2 = fit(col(b.ink2, mix(ink, surface2, 0.35)), [...grounds, s.redBg, s.yellowBg, s.okBg]);
  const muted = fit(col(b.muted, mix(ink, surface2, 0.5)), grounds);

  // text on the header band
  const headChip = mix(head, '#ffffff', 0.12); // pills and selects in the header
  const headGrounds = [head, headChip];
  const headText = pick([light ? bg : '#ECE9E2', '#ffffff', '#000000'], headGrounds);
  const headText2 = fit(mix(headText, head, 0.3), headGrounds);

  // accent: as a button fill, and as text on the page
  let accent = light ? accentIn : mix(accentIn, '#ffffff', 0.3);
  let accentText = pick(['#ffffff', '#000000'], [accent]);
  if (worst(accentText, [accent]) < TARGET) { accent = fit(accent, [accentText]); }
  const accentInk = fit(accent, [bg, surface, surface2]);
  const markText = pick(['#ffffff', '#000000'], [accentIn]);

  // status text on its own pill and on plain ground
  const redText = fit(s.red, [s.redBg, ...grounds]);
  const yellowText = fit(s.yellow, [s.yellowBg, ...grounds]);
  const okText = fit(s.ok, [s.okBg, ...grounds]);
  const badgeText = pick(['#ffffff', '#000000'], [s.red]);
  const lockedText = pick(['#ffffff', '#000000'], [s.locked]);

  const line = mix(surface2, ink, 0.12);
  const line2 = mix(surface2, surface, 0.4);

  return {
    head, headChip, headText, headText2, brandAccent: accentIn, markText,
    bg, surface, surface2, rowHover, ink, ink2, muted, line, line2,
    accent, accentText, accentInk,
    ...s, redText, yellowText, okText, badgeText, lockedText,
  };
}

export function palette(brand = {}) {
  return { light: build('light', brand), dark: build('dark', brand) };
}

// every text/ground pair the stylesheet uses. the test and the audit walk this.
export function pairs(p) {
  const g = [p.bg, p.surface, p.surface2, p.rowHover];
  return [
    ...['ink', 'ink2', 'muted'].flatMap((t) => g.map((b) => [t, p[t], b])),
    ['ink on redBg', p.ink, p.redBg], ['ink on yellowBg', p.ink, p.yellowBg], ['ink on okBg', p.ink, p.okBg],
    ['ink2 on pill', p.ink2, p.surface2],
    ['headText', p.headText, p.head], ['headText chip', p.headText, p.headChip],
    ['headText2', p.headText2, p.head], ['headText2 chip', p.headText2, p.headChip],
    ['accentText', p.accentText, p.accent], ['markText', p.markText, p.brandAccent],
    ...g.slice(0, 3).map((b) => ['accentInk', p.accentInk, b]),
    ['redText pill', p.redText, p.redBg], ['yellowText pill', p.yellowText, p.yellowBg], ['okText pill', p.okText, p.okBg],
    ...g.map((b) => ['redText', p.redText, b]),
    ['badge', p.badgeText, p.red], ['locked', p.lockedText, p.locked],
  ];
}

export function css(p) {
  const decl = (t) => Object.entries(t).map(([k, v]) => `--${k}:${v}`).join(';');
  return `:root{color-scheme:light;${decl(p.light)}}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;${decl(p.dark)}}}
:root[data-theme="dark"]{color-scheme:dark;${decl(p.dark)}}`;
}
