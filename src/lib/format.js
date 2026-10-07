export const $ = (s, r = document) => r.querySelector(s);

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function money(n, short = true) {
  n = +n || 0;
  if (!short) return '$' + Math.round(n).toLocaleString();
  const a = Math.abs(n), neg = n < 0 ? '-' : '';
  if (a >= 1e6) return neg + '$' + (a / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (a >= 1000) return neg + '$' + Math.round(a / 1000) + 'K';
  return neg + '$' + Math.round(a);
}

export const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

export const pad = (n) => String(n).padStart(2, '0');
export const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

export function validDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

export function addDays(isoStr, n) {
  const [y, m, d] = isoStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

// 0 = Sunday
export function dow(isoStr) {
  const [y, m, d] = isoStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(s) {
  if (!s) return '';
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return String(s);
  const [, m, d] = s.slice(0, 10).split('-');
  return `${MON[+m - 1]} ${+d}`;
}

export function num(v) {
  if (v === '' || v == null) return '';
  const n = +String(v).replace(/[^0-9.\-]/g, '');
  return isNaN(n) ? '' : n;
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let toastT;
export function toast(m) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = m;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 1800);
}
