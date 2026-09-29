// Who may run the probe. A fake Supabase stands in for the two lookups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorize } from '../supabase/functions/aspire-probe/gate.ts';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.sig`;
const LEGACY_SERVICE = jwt({ role: 'service_role', ref: 'tyrtzxnhwjchtemytfxv' });
const FORGED_SERVICE = jwt({ role: 'service_role', ref: 'tyrtzxnhwjchtemytfxv', forged: true });
const ADMIN = jwt({ role: 'authenticated', sub: 'u-admin' });
const REP = jwt({ role: 'authenticated', sub: 'u-rep' });
const URL_ = 'https://tyrtzxnhwjchtemytfxv.supabase.co';
const ENV = { SUPABASE_URL: URL_, SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_abcdefghijklmnop' };

const res = (status, body) => ({ status, json: async () => body });
function supabase() {
  const calls = [];
  const fetch = async (url, init) => {
    const auth = init.headers.Authorization.replace('Bearer ', '');
    calls.push(url.replace(URL_, ''));
    if (url.includes('/auth/v1/admin/users')) return res(auth === LEGACY_SERVICE ? 200 : 401, {}); // only a genuine key passes
    if (url.endsWith('/auth/v1/user')) return auth === ADMIN ? res(200, { id: 'u-admin', email: 'joe@deaconjames.com' }) : auth === REP ? res(200, { id: 'u-rep', email: 'joe+grow1@deaconjames.com' }) : res(401, {});
    if (url.includes('/rest/v1/app_admins')) return res(200, url.includes('u-admin') ? [{ user_id: 'u-admin' }] : []);
    return res(404, {});
  };
  return { fetch, calls };
}
const run = (token, env = ENV, s = supabase()) => authorize(token ? `Bearer ${token}` : null, env, s.fetch);

test('1. token equals SUPABASE_SERVICE_ROLE_KEY: allowed', async () => {
  const r = await run('sb_secret_abcdefghijklmnop');
  assert.equal(r.ok, true); assert.equal(r.via, 'service_key_match');
});

test('2. legacy service_role JWT when the injected key is the new sb_secret format: allowed, confirmed by Supabase', async () => {
  const s = supabase();
  const r = await run(LEGACY_SERVICE, ENV, s);
  assert.equal(r.ok, true); assert.equal(r.via, 'service_role_jwt');
  assert.ok(s.calls.some((c) => c.startsWith('/auth/v1/admin/users')));
  assert.match(r.checks.service_key_match, /differs .* new-format secret key/);
});

test('2. legacy service_role JWT when SUPABASE_SERVICE_ROLE_KEY is not injected at all: allowed', async () => {
  const r = await run(LEGACY_SERVICE, { SUPABASE_URL: URL_ });
  assert.equal(r.ok, true); assert.equal(r.via, 'service_role_jwt');
});

test('a hand-made JWT that claims service_role but Supabase rejects: refused, and says so', async () => {
  const r = await run(FORGED_SERVICE);
  assert.equal(r.ok, false);
  assert.match(r.checks.service_role_jwt, /claim is service_role but Supabase rejected the token \(401\)/);
});

test('3. signed-in user with an app_admins row: allowed', async () => {
  const r = await run(ADMIN);
  assert.equal(r.ok, true); assert.equal(r.via, 'app_admin');
});

test('signed-in user without an app_admins row: refused, every check explained', async () => {
  const r = await run(REP);
  assert.equal(r.ok, false);
  assert.match(r.checks.service_key_match, /^no:/);
  assert.match(r.checks.service_role_jwt, /role claim is "authenticated"/);
  assert.match(r.checks.app_admin, /joe\+grow1@deaconjames.com is signed in but has no app_admins row/);
});

test('no header, garbage token, missing URL: refused with a reason, never throws', async () => {
  assert.match((await run(null)).checks.header, /no Authorization/);
  const g = await run('not-a-token');
  assert.equal(g.ok, false); assert.match(g.checks.service_role_jwt, /not a JWT/); assert.match(g.checks.app_admin, /not a signed-in user \(auth returned 401\)/);
  const m = await run(LEGACY_SERVICE, {});
  assert.equal(m.ok, false); assert.match(m.checks.service_role_jwt, /SUPABASE_URL is not set/);
});

test('the 403 detail never contains a key or a token', async () => {
  for (const t of [REP, FORGED_SERVICE, 'not-a-token']) {
    const s = JSON.stringify(await run(t));
    for (const secret of [t, ENV.SUPABASE_SERVICE_ROLE_KEY, ENV.SUPABASE_ANON_KEY]) assert.ok(!s.includes(secret), 'leaked a key');
  }
});
