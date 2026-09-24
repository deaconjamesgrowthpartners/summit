// The screen and summit_week_key / summit_lock_at must agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekKeyAt, lockAt } from '../src/lib/time.js';

const ws = { lock_dow: 2, lock_time: '17:00:00', lock_tz: 'America/New_York' };

test('week key rolls at the Tuesday lock, not at midnight', () => {
  assert.equal(weekKeyAt(ws, new Date('2026-09-29T20:59:00Z')), '2026-09-29'); // Tue 4:59pm ET
  assert.equal(weekKeyAt(ws, new Date('2026-09-29T21:00:00Z')), '2026-09-29'); // exactly 5pm, not after
  assert.equal(weekKeyAt(ws, new Date('2026-09-29T21:01:00Z')), '2026-10-06'); // 5:01pm ET
  assert.equal(weekKeyAt(ws, new Date('2026-09-24T14:00:00Z')), '2026-09-29'); // Thursday
  assert.equal(weekKeyAt(ws, new Date('2026-09-30T03:30:00Z')), '2026-10-06'); // Tue 11:30pm ET, already Wed UTC
});

test('lock instant follows daylight saving', () => {
  assert.equal(lockAt(ws, '2026-09-29').toISOString(), '2026-09-29T21:00:00.000Z'); // EDT
  assert.equal(lockAt(ws, '2026-12-01').toISOString(), '2026-12-01T22:00:00.000Z'); // EST
});

test('Monday lock in another zone', () => {
  const w2 = { lock_dow: 1, lock_time: '09:30', lock_tz: 'America/Denver' };
  assert.equal(weekKeyAt(w2, new Date('2026-09-28T15:29:00Z')), '2026-09-28'); // Mon 9:29 MDT
  assert.equal(weekKeyAt(w2, new Date('2026-09-28T15:31:00Z')), '2026-10-05');
});

test('screen holds the finished week through lock night, rolls at 12:01am Wednesday', async () => {
  const { displayKeyAt, weekInfo } = await import('../src/lib/time.js');
  const at = (s) => new Date(s);
  assert.equal(displayKeyAt(ws, at('2026-09-29T20:59:00Z')), '2026-09-29'); // Tue 4:59pm ET
  const tueNight = weekInfo(ws, at('2026-09-29T22:30:00Z'));              // Tue 6:30pm ET
  assert.equal(tueNight.key, '2026-09-29');
  assert.equal(tueNight.locked, true);
  assert.equal(weekKeyAt(ws, at('2026-09-29T22:30:00Z')), '2026-10-06');  // database already rolled
  assert.equal(displayKeyAt(ws, at('2026-09-30T04:00:59Z')), '2026-09-29'); // Wed 12:00:59am ET
  const wed = weekInfo(ws, at('2026-09-30T04:01:00Z'));                   // Wed 12:01am ET
  assert.equal(wed.key, '2026-10-06');
  assert.equal(wed.locked, false);
  assert.equal(wed.prevKey, '2026-09-29');
});
