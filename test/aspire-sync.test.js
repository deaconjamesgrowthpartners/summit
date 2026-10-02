// The sync against a simulated Aspire and a simulated Summit. Proves paging, the incremental
// cutoff and the read-only rules. The SQL side is checked in aspire-sync-sql.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSync, restDb, SYNC_RPCS } from '../supabase/functions/aspire-sync/sync.ts';
import { aspireClient } from '../supabase/functions/aspire-sync/aspire.ts';

const ID = 'client-id-xyz', SECRET = 'super-secret-value-123';
const REPS = ['Greg Hill', 'Kit Fox', 'Matthew Royer', 'Jamy August'];
const opp = (i) => ({ OpportunityID: i, OpportunityName: `Job ${i}`, SalesRepContactName: REPS[i % 4], OpportunityStatusName: i % 3 ? 'Open' : 'Won',
  EstimatedDollars: 1000, ModifiedDate: `2026-09-${String(1 + (i % 29)).padStart(2, '0')}T10:00:00` });

function aspire({ n = 2500, cap = 1000, ignoreGt = false, expireAfter = 0, throttleOnce = false } = {}) {
  const rows = Array.from({ length: n }, (_, i) => opp(i + 1));
  const seen = [];
  let tokenN = 0, gets = 0, throttled = false;
  const res = (status, body, headers = {}) => ({ status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => JSON.stringify(body) });
  async function fetch(url, init = {}) {
    const u = new URL(url);
    seen.push({ method: init.method || 'GET', path: u.pathname, filter: u.searchParams.get('$filter'), top: u.searchParams.get('$top') });
    if (init.method === 'POST') {
      const b = JSON.parse(init.body);
      if (u.pathname !== '/Authorization' || b.ClientId !== ID || b.Secret !== SECRET) return res(401, {});
      return res(200, { Token: `tok-${++tokenN}` });
    }
    if (init.headers?.Authorization !== `Bearer tok-${tokenN}`) return res(401, {});
    gets++;
    if (expireAfter && gets === expireAfter) { tokenN++; return res(401, {}); } // the token died
    if (throttleOnce && !throttled) { throttled = true; return res(429, {}, { 'retry-after': '1' }); }
    let out = rows;
    for (const c of (u.searchParams.get('$filter') || '').split(' and ').filter(Boolean)) {
      const [k, op, v] = c.split(' ');
      if (op === 'ge') out = out.filter((x) => x[k] >= v.replace(/Z$/, ''));
      if (op === 'gt' && !ignoreGt) out = out.filter((x) => x[k] > Number(v));
    }
    out = [...out].sort((a, b) => a.OpportunityID - b.OpportunityID).slice(0, Math.min(Number(u.searchParams.get('$top')), cap));
    return res(200, { value: out });
  }
  return { fetch, seen, rows };
}

function summit({ lastGood = null, refuse = null } = {}) {
  const calls = [];
  const table = new Map();
  let run = null;
  return {
    calls, table,
    get run() { return run; },
    async rpc(fn, args) {
      calls.push(fn);
      if (fn === 'aspire_sync_begin') {
        if (refuse) return { error: refuse };
        run = { id: 7, mode: args.p_full || !lastGood ? 'full' : 'incremental', pulled: 0, pages: 0 };
        return { run_id: 7, mode: run.mode, since: run.mode === 'incremental' ? lastGood : null };
      }
      if (fn === 'aspire_sync_upsert') {
        for (const r of args.p_rows) table.set(r.OpportunityID, r);
        run.pulled += args.p_rows.length; run.pages++;
        return { pulled: args.p_rows.length };
      }
      if (fn === 'aspire_sync_finish') { Object.assign(run, { status: args.p_status, errors: args.p_errors, notes: args.p_notes, calls: args.p_calls, complete: args.p_complete }); return run; }
      throw new Error('unexpected ' + fn);
    },
  };
}
const go = (a, db, { aspire: more = {}, ...extra } = {}) =>
  runSync({ aspire: { clientId: ID, secret: SECRET, fetch: a.fetch, sleep: async () => {}, ...more }, db, ...extra });
// no test may reach the network
globalThis.fetch = async (u) => { throw new Error(`test tried the network: ${u}`); };

test('first run: full pull, pages by key, stops on the short page', async () => {
  const a = aspire(), db = summit();
  const r = await go(a, db, { pageSize: 1000 });
  assert.equal(r.status, 'ok');
  assert.equal(db.table.size, 2500);
  const gets = a.seen.filter((c) => c.method === 'GET');
  assert.deepEqual(gets.map((g) => g.filter), [null, 'OpportunityID gt 1000', 'OpportunityID gt 2000']);
  assert.ok(gets.every((g) => g.top === '1000'));
  assert.equal(db.run.calls, 4, 'login plus three pages');
  assert.equal(db.run.complete, true);
});

test('a lower page cap at Aspire still gets every row, once', async () => {
  const a = aspire({ n: 930, cap: 400 }), db = summit();
  const r = await go(a, db, { pageSize: 1000 });
  assert.equal(r.status, 'ok');
  assert.equal(db.table.size, 930);
  assert.equal(db.run.pulled, 930);
  assert.equal(a.seen.filter((c) => c.method === 'GET').length, 3, '400 + 400 + 130, the short page ends it');
});

test('later runs: only ModifiedDate since the watermark, still paged by key', async () => {
  const a = aspire(), db = summit({ lastGood: '2026-09-27T10:00:00' });
  const r = await go(a, db);
  assert.equal(r.status, 'ok');
  const want = a.rows.filter((x) => x.ModifiedDate >= '2026-09-27T10:00:00').length;
  assert.equal(db.table.size, want);
  assert.equal(a.seen.find((c) => c.method === 'GET').filter, 'ModifiedDate ge 2026-09-27T10:00:00Z');
  assert.ok(db.run.notes.some((n) => /incremental: ModifiedDate ge 2026-09-27T10:00:00Z/.test(n)));
});

test('{"full": true} forces a full pull even with a watermark', async () => {
  const db = summit({ lastGood: '2026-09-27T10:00:00' });
  await go(aspire({ n: 50 }), db, { full: true });
  assert.equal(db.table.size, 50);
});

test('if Aspire ignores the key filter, it stops with an error instead of counting twice', async () => {
  const db = summit();
  const r = await go(aspire({ ignoreGt: true }), db, { pageSize: 1000 });
  assert.equal(r.status, 'error');
  assert.equal(db.table.size, 1000);
  assert.match(db.run.errors[0], /ignored the OpportunityID order or the gt filter/);
  assert.equal(db.run.complete, false);
});

test('a token that expires mid-run logs in again once and carries on', async () => {
  const a = aspire({ expireAfter: 2 }), db = summit();
  const r = await go(a, db);
  assert.equal(r.status, 'ok');
  assert.equal(db.table.size, 2500);
  assert.equal(a.seen.filter((c) => c.method === 'POST').length, 2);
  assert.ok(db.run.notes.some((n) => /logged in again/.test(n)));
});

test('a 429 backs off for Retry-After and retries', async () => {
  const waits = [];
  const db = summit();
  const r = await go(aspire({ throttleOnce: true }), db, { aspire: { sleep: async (ms) => { waits.push(ms); } } });
  assert.equal(r.status, 'ok', JSON.stringify(db.run.errors));
  assert.ok(waits.includes(1000));
  assert.ok(db.run.notes.some((n) => /throttled 1/.test(n)));
});

test('running out of time keeps what it got and logs partial', async () => {
  let t = 0;
  const db = summit();
  const r = await go(aspire(), db, { aspire: { clock: () => (t += 20_000), deadlineMs: 50_000 } });
  assert.equal(r.status, 'partial', JSON.stringify(db.run.errors));
  assert.ok(db.table.size > 0 && db.table.size < 2500);
  assert.equal(db.run.complete, false);
  assert.ok(db.run.notes.some((n) => /time budget/.test(n)));
});

test('a refused start (a run already going) never calls Aspire', async () => {
  const a = aspire(), db = summit({ refuse: 'a sync is already running for this workspace' });
  const r = await go(a, db);
  assert.equal(r.status, 'refused');
  assert.equal(a.seen.length, 0);
});

test('read only: the only non-GET to Aspire is the login, and only the three sync functions are called', async () => {
  const a = aspire(), db = summit();
  const r = await go(a, db);
  assert.deepEqual(a.seen.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`), ['POST /Authorization']);
  assert.deepEqual([...new Set(db.calls)], SYNC_RPCS);
  const s = JSON.stringify(r) + JSON.stringify(db.run);
  for (const x of [SECRET, ID, 'tok-1']) assert.ok(!s.includes(x), `leaked ${x}`);
});

test('restDb refuses any function that is not a sync function', async () => {
  const db = restDb('https://x.supabase.co', 'k', async () => { throw new Error('should not be called'); });
  await assert.rejects(db.rpc('delete_everything', {}), /not a sync function/);
});

test('a login failure is logged as an error, with no secret in it', async () => {
  const db = summit();
  const r = await runSync({ aspire: { clientId: ID, secret: 'wrong', fetch: aspire().fetch, sleep: async () => {} }, db });
  assert.equal(r.status, 'error');
  assert.match(db.run.errors[0], /Aspire login failed \(401\)/);
  assert.ok(!JSON.stringify(db.run).includes('wrong'));
});

test('pages default to 200 and pageSize overrides it, kept between 1 and 1000', async () => {
  const tops = async (pageSize) => {
    const a = aspire({ n: 930 });
    await go(a, summit(), pageSize === undefined ? {} : { pageSize });
    return [...new Set(a.seen.filter((c) => c.method === 'GET').map((c) => c.top))];
  };
  assert.deepEqual(await tops(), ['200']);
  assert.deepEqual(await tops(50), ['50']);
  assert.deepEqual(await tops(5000), ['1000']);
  assert.deepEqual(await tops(0), ['200']);
});

test('a page Summit fails to save fails that page, not the run: the rest still land, the run ends partial', async () => {
  const a = aspire({ n: 930 }), db = summit();
  const rpc = db.rpc.bind(db);
  let n = 0;
  db.rpc = async (fn, args) => {
    if (fn === 'aspire_sync_upsert' && ++n === 2) throw new Error('aspire_sync_upsert: canceling statement due to statement timeout');
    return rpc(fn, args);
  };
  const r = await go(a, db);
  assert.equal(r.status, 'partial');
  assert.equal(db.table.size, 730, 'every page but the failed one saved');
  assert.equal(db.run.errors.length, 1);
  assert.match(db.run.errors[0], /page 2 \(OpportunityID 201 to 400, 200 rows\) was not saved: .*statement timeout/);
  assert.equal(db.run.complete, false, 'no rows get marked removed after a partial run');
  assert.ok(db.run.notes.some((x) => /time to save each page: .*failed/.test(x)));
});

test('the client itself has no way to send anything but GET', () => {
  const c = aspireClient({ clientId: ID, secret: SECRET, fetch: async () => { throw new Error('no'); } });
  assert.deepEqual(Object.keys(c).sort(), ['get', 'stats']);
});

test('the aspire-sync dashboard copy is up to date, has no imports left, and declares each name once', async () => {
  const { readFileSync } = await import('node:fs');
  const { bundle } = await import('../scripts/bundle-probe.mjs');
  const b = bundle('aspire-sync');
  assert.equal(readFileSync(new URL('../supabase/dashboard/aspire-sync.ts', import.meta.url), 'utf8'), b, 'run npm run bundle:probe');
  assert.ok(!/^import /m.test(b), 'no imports left');
  const names = [...b.matchAll(/^(?:export )?(?:async )?(?:const|let|function|type|interface|class) (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), []);
  assert.ok(names.includes('authorize') && names.includes('runSync'));
});
