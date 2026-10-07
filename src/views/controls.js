// Segmented toggles: the Week / Month / Quarter / Year switch and the Summit filters.
// A button carries data-seg="<filter key>:<value>"; main.js sets S.filters[key] and re-renders.
import { esc } from '../lib/format.js';
import { PERIODS } from '../lib/period.js';

export function seg(key, options, cur, label) {
  return `<div class="seg" role="group" aria-label="${esc(label)}">${options.map(([v, l]) =>
    `<button type="button" class="${v === cur ? 'on' : ''}" aria-pressed="${v === cur}" data-seg="${esc(key)}:${esc(v)}">${esc(l)}</button>`).join('')}</div>`;
}
export const periodSeg = (key, cur) => seg(key, PERIODS, cur, 'Period');
