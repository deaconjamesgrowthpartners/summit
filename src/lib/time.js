// Week math in the workspace clock. Mirrors summit_week_key and
// summit_lock_at in migration 001 so the screen and the database agree.
import { iso, addDays, daysBetween } from './format.js';

export function zoned(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short',
  });
  const p = {};
  f.formatToParts(date).forEach((x) => (p[x.type] = x.value));
  const isodow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) + 1;
  return {
    date: iso(+p.year, +p.month, +p.day), year: +p.year,
    secs: (+p.hour % 24) * 3600 + +p.minute * 60 + +p.second, isodow,
  };
}

export function parseTime(t) {
  const [h = 0, m = 0, s = 0] = String(t || '17:00').split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

// the Tuesday (or whatever lock_dow is) this moment's week locks
export function weekKeyAt(ws, at = new Date()) {
  const z = zoned(at, ws.lock_tz);
  const dw = ws.lock_dow;
  let d = addDays(z.date, (dw - z.isodow + 7) % 7);
  if (d === z.date && z.secs > parseTime(ws.lock_time)) d = addDays(d, 7);
  return d;
}

// the exact instant a week locks: wall clock wk + lock_time in lock_tz
export function lockAt(ws, wk) {
  const [y, m, d] = wk.split('-').map(Number);
  const secs = parseTime(ws.lock_time);
  const wall = Date.UTC(y, m - 1, d) + secs * 1000;
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const z = zoned(new Date(guess), ws.lock_tz);
    const [zy, zm, zd] = z.date.split('-').map(Number);
    const seen = Date.UTC(zy, zm - 1, zd) + z.secs * 1000;
    guess += wall - seen;
  }
  return new Date(guess);
}

export function lockLabel(ws) {
  const day = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][ws.lock_dow] || '';
  const s = parseTime(ws.lock_time);
  const h = Math.floor(s / 3600), mi = Math.floor((s % 3600) / 60);
  const h12 = h % 12 || 12;
  return `${day} ${h12}${mi ? ':' + String(mi).padStart(2, '0') : ''}${h < 12 ? 'am' : 'pm'}`;
}

export function weekInfo(ws, now = new Date()) {
  const key = weekKeyAt(ws, now);
  const z = zoned(now, ws.lock_tz);
  return {
    key,
    start: addDays(key, -6),
    prevKey: addDays(key, -7),
    today: z.date,
    year: z.year,
    locked: now > lockAt(ws, key),
    daysLeft: daysBetween(z.date, key),
  };
}

export const isLockedWeek = (ws, wk, now = new Date()) => now > lockAt(ws, wk);
