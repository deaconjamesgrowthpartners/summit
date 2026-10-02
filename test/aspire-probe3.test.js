// Pass 3 against a simulated Aspire. Proves the paging and the counting, not Aspire's real shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probe3, weekOf, weeksBetween, toCsv, OPP_FIELDS } from '../supabase/functions/aspire-probe/probe3.ts';
import { AUTH_ATTEMPTS } from '../supabase/functions/aspire-probe/client.ts';

const ID = 'client-id-xyz', SECRET = 'super-secret-value-123', TOKEN = 'eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl';
const NOW = new Date('2026-09-30T12:00:00Z');
const day = (n) => new Date(NOW.getTime() - n * 86400000).toISOString().slice(0, 10) + 'T09:00:00';
const REPS = ['Greg H', 'Brandon L', 'Kit F', 'David G'];

// 1000 opportunities: every 4th open, the rest won across 400 days, a few lost
function opps() {
  return Array.from({ length: 1000 }, (_, i) => {
    const status = i % 4 === 0 ? 'Open' : i % 25 === 1 ? 'Lost' : 'Won';
    return {
      OpportunityID: i + 1, OpportunityNumber: 5000 + i, OpportunityName: `Job ${i}`, PropertyName: `Prop ${i % 90}`,
      SalesRepContactName: i % 50 === 0 ? null : REPS[i % 4], BranchName: 'Raleigh', DivisionName: 'Maintenance',
      OpportunityStatusName: status, EstimatedDollars: 1000, WonDollars: status === 'Won' ? 900 : null,
      StartDate: day(i % 400), AnticipatedCloseDate: day(i % 30), WonDate: status === 'Won' ? day(i % 400) : null,
      LostDate: status === 'Lost' ? day(3) : null, ModifiedDate: day(i % 60), Notes: 'not selected',
    };
  });
}
// activities: Greg every week, Kit every third week, Brandon only once. Some floating.
function acts() {
  const rows = [];
  let id = 1;
  for (let d = 0; d < 120; d++) {
    if (d % 7 === 1) rows.push({ ActivityID: id++, CreatedByUserName: 'Greg H', CreatedDate: day(d), ActivityCategoryName: 'Client Visit', PropertyID: 10, OpportunityID: null, ContactID: null });
    if (d % 21 === 2) rows.push({ ActivityID: id++, CreatedByUserName: 'Kit F', CreatedDate: day(d), ActivityCategoryName: null, PropertyID: null, OpportunityID: 44, ContactID: null });
    if (d === 5) rows.push({ ActivityID: id++, CreatedByUserName: 'Brandon L', CreatedDate: day(d), ActivityCategoryName: '', PropertyID: null, OpportunityID: null, ContactID: 7 });
    if (d === 6) rows.push({ ActivityID: id++, CreatedByUserName: 'Brandon L', CreatedDate: day(d), ActivityCategoryName: 'Call', PropertyID: 3, OpportunityID: 9, ContactID: null });
    if (d === 8) rows.push({ ActivityID: id++, CreatedByUserName: 'Greg H', CreatedDate: day(d), ActivityCategoryName: 'Call', PropertyID: null, OpportunityID: null, ContactID: null });
  }
  return rows.reverse(); // Aspire hands them back newest first unless told otherwise
}

function clause(c) {
  const m = c.trim().match(/^(\w+) (ne|eq|ge|gt) (.+)$/);
  if (!m) throw new Error('bad filter ' + c);
  const raw = m[3];
  const v = raw === 'null' ? null : /^'.*'$/.test(raw) ? raw.slice(1, -1) : /^\d+$/.test(raw) ? Number(raw) : raw;
  return { k: m[1], op: m[2], v };
}
function world({ cap = 100, ignoreSkip = false, ignoreKey = false, refuse = [], ignoreFilter = [], noCount = false } = {}) {
  const data = { '/Opportunities': opps(), '/Activities': acts(), '/Divisions': [{ DivisionID: 1 }] };
  const seen = [];
  const res = (status, body) => ({ status, headers: { get: () => null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  async function fetch(url, init = {}) {
    const u = new URL(url);
    seen.push({ method: init.method || 'GET', path: u.pathname, q: u.search });
    if (init.method === 'POST') return u.pathname === '/Authorization' ? res(200, { Token: TOKEN }) : res(404, 'Not Found');
    if (init.headers?.Authorization !== `Bearer ${TOKEN}`) return res(401, {});
    let rows = data[u.pathname];
    if (!rows) return res(404, 'Not Found');
    const f = u.searchParams.get('$filter');
    if (f) {
      const cs = f.replace(/[()]/g, '').split(' and ').map(clause);
      if (cs.some((c) => refuse.includes(c.op) || refuse.includes(c.k))) return res(400, { error: 'unsupported' });
      for (const c of cs) {
        if (ignoreFilter.includes(c.k) || (ignoreKey && c.op === 'gt')) continue;
        rows = rows.filter((x) => {
          const a = x[c.k] === undefined ? null : x[c.k];
          if (c.op === 'eq') return a === c.v;
          if (c.op === 'ne') return a !== c.v;
          if (a === null) return false;
          const b = typeof c.v === 'string' ? c.v.replace(/Z$/, '') : c.v;
          return c.op === 'ge' ? a >= b : a > b;
        });
      }
    }
    const total = rows.length;
    const ob = u.searchParams.get('$orderby');
    if (ob) { const [k] = ob.split(' '); rows = [...rows].sort((a, b) => a[k] - b[k]); }
    const skip = ignoreSkip ? 0 : +(u.searchParams.get('$skip') || 0);
    const top = Math.min(+(u.searchParams.get('$top') || rows.length), cap);
    rows = rows.slice(skip, skip + top);
    const sel = u.searchParams.get('$select');
    if (sel) rows = rows.map((x) => Object.fromEntries(sel.split(',').map((k) => [k, x[k]])));
    const body = { value: rows };
    if (u.searchParams.get('$count') === 'true' && !noCount) body['@odata.count'] = total;
    return res(200, body);
  }
  return { fetch, seen };
}
const run = (w, extra = {}) => probe3({ clientId: ID, secret: SECRET, fetch: w.fetch, sleep: async () => {}, now: NOW, ...extra });

// what the simulated data should give
const all = opps();
const cutoff = new Date(NOW.getTime() - 180 * 86400000).toISOString().slice(0, 10);
const wantOpen = all.filter((o) => o.OpportunityStatusName === 'Open').length;
const wantWon = all.filter((o) => o.WonDate && o.WonDate.slice(0, 10) >= cutoff).length;

test('ownership: pages by key past a 100-row cap, and every row is accounted for', async () => {
  const r = await run(world());
  const o = r.ownership;
  assert.equal(o.totals.open, wantOpen);
  assert.equal(o.totals.won_last_180_days, wantWon);
  assert.equal(o.totals.opportunities, wantOpen + wantWon);
  assert.equal(o.paging.open.page_size_cap, 100);
  assert.match(o.paging.open.method, /^by key/);
  assert.equal(o.paging.open.matches_aspire_count, true);
  assert.equal(o.paging.open.filter_used, "OpportunityStatusName ne 'Won' and OpportunityStatusName ne 'Lost'");
  assert.equal(o.totals.open_estimated, wantOpen * 1000);
  assert.equal(o.totals.won_dollars, wantWon * 900);
  assert.deepEqual(o.missing_fields, []);
  assert.deepEqual(Object.keys(o.rows[0]), [...OPP_FIELDS, 'bucket']);
});

test('ownership: groups by rep and status add back up to the totals', async () => {
  const o = (await run(world())).ownership;
  assert.equal(o.by_rep.reduce((a, r) => a + r.total_count, 0), o.totals.opportunities);
  assert.equal(o.by_rep.reduce((a, r) => a + r.won_dollars, 0), o.totals.won_dollars);
  const none = o.by_rep.find((r) => r.rep === '(no rep)');
  assert.equal(none.total_count, o.totals.no_rep);
  assert.ok(o.totals.no_rep > 0);
  assert.deepEqual(o.by_status.map((s) => s.status).sort(), ['Open', 'Won']);
});

test('ownership: if Aspire ignores the key filter, it falls back to $skip and still gets everything', async () => {
  const o = (await run(world({ ignoreKey: true }))).ownership;
  assert.equal(o.totals.open, wantOpen);
  assert.match(o.paging.open.method, /then \$skip/);
  assert.ok(o.paging.open.notes.some((n) => /ignored "OpportunityID gt"/.test(n)));
});

test('ownership: if Aspire ignores both the key and $skip, it stops, says so, and never double counts', async () => {
  const o = (await run(world({ ignoreKey: true, ignoreSkip: true }))).ownership;
  assert.equal(o.totals.open, 100);
  assert.match(o.paging.open.stopped, /ignored \$skip/);
  assert.equal(o.paging.open.matches_aspire_count, false);
});

test('ownership: a refused status filter falls back to the won and lost dates', async () => {
  const o = (await run(world({ refuse: ['ne'] }))).ownership;
  assert.equal(o.paging.open.filter_used, 'WonDate eq null and LostDate eq null');
  assert.deepEqual(o.paging.open.filters_refused, ["OpportunityStatusName ne 'Won' and OpportunityStatusName ne 'Lost'"]);
  assert.equal(o.totals.open, wantOpen);
});

test('ownership: a filter Aspire accepts but ignores cannot inflate the count', async () => {
  const o = (await run(world({ ignoreFilter: ['WonDate'] }))).ownership;
  assert.equal(o.totals.won_last_180_days, wantWon);
  assert.ok(o.paging.won_last_180_days.rows_failed_check > 0);
});

test('activity: weeks per person show habit versus occasional', async () => {
  const a = (await run(world())).activity;
  assert.equal(a.fields.person, 'CreatedByUserName');
  assert.equal(a.fields.date, 'CreatedDate');
  assert.equal(a.weeks_in_window, weeksBetween(a.since, '2026-09-30').length);
  const greg = a.by_person.find((p) => p.person === 'Greg H');
  const kit = a.by_person.find((p) => p.person === 'Kit F');
  const brandon = a.by_person.find((p) => p.person === 'Brandon L');
  assert.equal(greg.pattern, 'habit');
  assert.equal(kit.pattern, 'occasional');
  assert.equal(brandon.weeks_active, 1);
  assert.equal(brandon.total, 2);
  assert.equal(Object.keys(greg.per_week).length, a.weeks_in_window);
  assert.equal(a.by_person.reduce((s, p) => s + p.total, 0), a.activities);
});

test('activity: category filled versus blank, and property, opportunity or floating', async () => {
  const a = (await run(world())).activity;
  const src = acts().filter((x) => x.CreatedDate.slice(0, 10) >= a.since);
  assert.equal(a.activities, src.length);
  assert.equal(a.category.filled + a.category.blank, a.activities);
  assert.equal(a.category.blank, src.filter((x) => !x.ActivityCategoryName).length);
  const L = a.links;
  assert.equal(L.property_only + L.opportunity_only + L.both + L.floating, a.activities);
  assert.equal(L.both, 1);
  assert.equal(L.floating, 2);
  assert.deepEqual(L.floating_but_linked_to, { ContactID: 1 });
  assert.equal(L.floating_with_no_link_at_all, 1);
});

test('stays read only, reports calls used, and leaks no secret', async () => {
  const w = world();
  const r = await run(w);
  const bad = w.seen.filter((c) => c.method !== 'GET' && !(c.method === 'POST' && AUTH_ATTEMPTS.some((a) => a.path === c.path)));
  assert.deepEqual(bad, []);
  assert.equal(r.data_writes, 0);
  assert.equal(r.call_budget, 300);
  assert.ok(r.calls_used > 0 && r.calls_used <= 300);
  const s = JSON.stringify(r);
  for (const x of [SECRET, ID, TOKEN]) assert.ok(!s.includes(x));
  assert.ok(r.summary.some((l) => /^Ownership: \d+ opportunities/.test(l)));
  assert.ok(r.summary.some((l) => /^Activity: \d+ created since/.test(l)));
});

test('a budget that runs out mid-pull says the rows are incomplete', async () => {
  const r = await run(world(), { maxCalls: 8 });
  assert.match(r.ownership.paging.open.stopped, /budget ran out/);
  assert.ok(r.summary.some((l) => /8-call budget/.test(l)));
});

test('part runs one question only', async () => {
  const r = await run(world(), { part: 'activity' });
  assert.equal(r.ownership, null);
  assert.ok(r.activity.activities > 0);
});

test('weeks start Monday; csv quotes what needs quoting', () => {
  assert.equal(weekOf('2026-09-30'), '2026-09-28');
  assert.equal(weekOf('2026-09-28'), '2026-09-28');
  assert.equal(weekOf('2026-09-27'), '2026-09-21');
  const csv = toCsv([{ OpportunityID: 1, OpportunityName: 'Smith, "Big" job', bucket: 'open' }]);
  assert.match(csv.split('\n')[1], /^1,,"Smith, ""Big"" job",/);
});
