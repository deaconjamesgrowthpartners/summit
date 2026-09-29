// Every text/ground pair the stylesheet uses must clear 4.5:1, light and dark, for any brand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { palette, pairs, contrast, AA } from '../src/lib/palette.js';

const BRANDS = {
  elevation: { head: '#1F3E0F', accent: '#017543', bg: '#F4F3EE', panel: '#ECE9E2', muted: '#8C9A8B' },
  empty: {},
  navy_cream: { head: '#0A132B', accent: '#C1440E', bg: '#F5F3EE', panel: '#E9E4DA', muted: '#C2B6AE' },
  light_header: { head: '#F2E6C9', accent: '#FFD400', bg: '#FFFFFF', panel: '#F7F7F7', muted: '#DDDDDD' },
  loud: { head: '#FF00AA', accent: '#00FFFF', bg: '#FFF8E1', panel: '#FFE082', muted: '#FFCA28' },
  dark_page: { head: '#101010', accent: '#6C63FF', bg: '#202020', panel: '#2A2A2A', muted: '#555555' },
};

for (const [name, brand] of Object.entries(BRANDS)) {
  for (const mode of ['light', 'dark']) {
    test(`${name} / ${mode}: every text pair clears ${AA}:1`, () => {
      const p = palette(brand)[mode];
      const fails = pairs(p).map(([k, fg, bg]) => [k, fg, bg, contrast(fg, bg)]).filter((x) => x[3] < AA);
      assert.deepEqual(fails.map(([k, fg, bg, c]) => `${k} ${fg} on ${bg} = ${c.toFixed(2)}`), []);
    });
  }
}

test('elevation muted text is darker than the raw brand sage, which fails AA', () => {
  const p = palette(BRANDS.elevation).light;
  assert.ok(contrast('#8C9A8B', '#F4F3EE') < AA);
  assert.ok(contrast(p.muted, p.surface2) >= AA);
});
