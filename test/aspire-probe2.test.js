// Pass 2 against a simulated Aspire. Proves the logic, not Aspire's real shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probe2, PASS2_RESOURCES } from '../supabase/functions/aspire-probe/probe2.ts';
import { AUTH_ATTEMPTS } from '../supabase/functions/aspire-probe/client.ts';

const ID = 'client-id-xyz', SECRET = 'super-secret-value-123', TOKEN = 'eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl';
const day = (n) => new Date(Date.UTC(2026, 8, 30) - n * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const REPS = ['Greg H', 'Brandon L', 'Kit F', 'David G', 'Louis M', 'Oscar Y', 'Ruan R', 'Stacy M'];
const ADMINS = ['Admin One', 'Ops Manager', 'Branch Mgr'];

function world({ pageCap = 100, ignoreSkip = false } = {}) {
  const opps = Array.from({ length: 700 }, (_, i) => ({
    OpportunityID: i + 1, OpportunityStatusName: i % 20 === 0 ? 'Proposal' : 'Won',
    SalesRepContactID: i % 11, SalesRepContactName: i % 11 < 8 ? REPS[i % 11] : ADMINS[(i % 11) - 8],
    ModifiedDate: day(i % 300), OpportunityName: `Job ${i}`,
  }));
  const audits = Array.from({ length: 151 }, (_, i) => ({
    SiteAuditID: i + 1, PropertyName: `Prop ${i}`, AuditDate: day(i * 2), CreatedByUserName: REPS[i % 3],
    Score: 80 + (i % 20), ModifiedDate: day(i),
  }));
  const acts = Array.from({ length: 80 }, (_, i) => ({
    ActivityID: i + 1, ActivityTypeName: i % 2 ? 'Client Visit' : 'Call', ActivityDate: day(i), AssignedToContactName: REPS[(i + 3) % 8],
  }));
  const data = {
    '/Opportunities': { rows: opps, cap: pageCap, skipIgnored: ignoreSkip },
    '/SiteAudit': { rows: audits, ignoreFilterOn: ['ModifiedDate'] },
    '/Activities': { rows: acts, ignoreFilterOn: ['AssignedToContactName'] },
    '/ActivityTypes': { rows: [{ ActivityTypeID: 1, ActivityTypeName: 'Call' }, { ActivityTypeID: 2, ActivityTypeName: 'Client Visit' }] },
    '/Divisions': { rows: [{ DivisionID: 1 }] },
  };
  const seen = [];
  const res = (status, body) => ({ status, headers: { get: () => null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  async function fetch(url, init = {}) {
    const u = new URL(url);
    seen.push({ method: init.method || 'GET', path: u.pathname });
    if (init.method === 'POST') return u.pathname === '/Authorization' ? res(200, { Token: TOKEN }) : res(404, 'Not Found');
    if (init.headers?.Authorization !== `Bearer ${TOKEN}`) return res(401, {});
    const d = data[u.pathname];
    if (!d) return res(404, 'Not Found');
    let rows = d.rows;
    const f = u.searchParams.get('$filter');
    if (f) {
      const m = f.match(/^(\w+) (ge|eq) (.+)$/);
      if (m && !(d.ignoreFilterOn || []).includes(m[1])) {
        const v = m[3].replace(/^'|'$/g, '');
        rows = rows.filter((x) => (m[2] === 'ge' ? x[m[1]] >= v : String(x[m[1]]) === v));
      }
    }
    const ob = u.searchParams.get('$orderby');
    if (ob) { const [k] = ob.split(' '); rows = [...rows].sort((a, b) => (a[k] < b[k] ? 1 : -1)); }
    const skip = d.skipIgnored ? 0 : +(u.searchParams.get('$skip') || 0);
    const top = Math.min(+(u.searchParams.get('$top') || rows.length), d.cap || Infinity);
    rows = rows.slice(skip, skip + top);
    const sel = u.searchParams.get('$select');
    if (sel) rows = rows.map((x) => Object.fromEntries(sel.split(',').map((k) => [k, x[k]])));
    return res(200, { value: rows });
  }
  return { fetch, seen };
}
const run = (w, extra = {}) => probe2({ clientId: ID, secret: SECRET, fetch: w.fetch, sleep: async () => {}, now: new Date('2026-09-30T12:00:00Z'), ...extra });

test('deal ownership: pages past a 100-row cap to 500 and counts every rep name', async () => {
  const r = await run(world());
  assert.equal(r.deal_ownership.pulled, 500);
  assert.equal(r.deal_ownership.page_size_cap, 100);
  assert.equal(r.deal_ownership.distinct_rep_names, 11);
  const counts = r.deal_ownership.rep_names_with_counts;
  for (const rep of REPS) assert.ok(counts[rep] > 0, `missing ${rep}`);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 500);
});

test('deal ownership: if Aspire ignores $skip, it stops instead of double counting', async () => {
  const r = await run(world({ ignoreSkip: true }));
  assert.equal(r.deal_ownership.pulled, 100);
  assert.match(r.deal_ownership.stopped, /ignored \$skip/);
});

test('site audits: found under a name variant, date field, recent-50 range, filters proven', async () => {
  const r = await run(world());
  const a = r.resources.SiteAudits;
  assert.equal(a.path, '/SiteAudit');
  assert.deepEqual(a.tried.map((t) => t.status), [404, 200]);
  assert.equal(a.date_field, 'AuditDate');
  assert.equal(a.recent_50.returned, 50);
  assert.equal(a.recent_50.newest.slice(0, 10), '2026-09-30');
  assert.equal(a.recent_50.oldest.slice(0, 10), day(98).slice(0, 10));
  assert.equal(a.date_filter.supported, true);
  assert.equal(a.modified_filter.supported, false);
  assert.match(a.modified_filter.why, /ignored/);
  const who = a.person_fields.find((x) => x.field === 'CreatedByUserName');
  assert.ok(who.names);
  assert.deepEqual(Object.keys(who.values_in_recent).sort(), REPS.slice(0, 3).sort());
  assert.equal(a.person_filter.supported, true);
});

test('activities: a person filter that is accepted but ignored is reported as no', async () => {
  const r = await run(world());
  const a = r.resources.Activities;
  assert.equal(a.date_field, 'ActivityDate');
  assert.equal(a.person_filter.field, 'AssignedToContactName');
  assert.equal(a.person_filter.supported, false);
  assert.match(a.person_filter.why, /ignored/);
});

test('lookups list their values; missing endpoints report every name tried', async () => {
  const r = await run(world());
  assert.deepEqual(r.resources.ActivityTypes.values.map((v) => v.name), ['Call', 'Client Visit']);
  assert.deepEqual(r.resources.WorkTickets.tried.map((t) => t.path), ['/WorkTickets', '/WorkTicket']);
  assert.equal(r.resources.WorkTickets.exists, false);
  assert.ok(r.summary.some((l) => /^SiteAudits: \/SiteAudit, 6 fields\. Date AuditDate/.test(l)));
});

test('stays read only and inside the 70-call budget', async () => {
  const w = world();
  const r = await run(w);
  const bad = w.seen.filter((c) => c.method !== 'GET' && !(c.method === 'POST' && AUTH_ATTEMPTS.some((a) => a.path === c.path)));
  assert.deepEqual(bad, []);
  assert.ok(r.calls_used <= 70, `used ${r.calls_used}`);
  assert.equal(r.data_writes, 0);
  const s = JSON.stringify(r);
  for (const x of [SECRET, ID, TOKEN]) assert.ok(!s.includes(x));
});

test('a tight budget skips the low-priority endpoints last and says so', async () => {
  const r = await run(world(), { maxCalls: 25 });
  assert.ok(r.calls_used <= 25);
  assert.equal(r.resources.SiteAudits.exists, true, 'site audits come before the budget runs out');
  assert.ok(r.summary.some((l) => /25-call budget/.test(l)));
});

test('every pass-2 resource has a singular and plural name to try', () => {
  for (const r of PASS2_RESOURCES) assert.ok(r.paths.length >= 2, r.name);
});

test('activity kinds are counted, so client visits can be told apart from calls', async () => {
  const r = await run(world());
  const t = r.resources.Activities.type_fields.find((x) => x.field === 'ActivityTypeName');
  assert.deepEqual(t.values_in_recent, { Call: 25, 'Client Visit': 25 });
  assert.ok(r.summary.some((l) => /Kinds in recent 50: ActivityTypeName: Call 25, Client Visit 25/.test(l)));
});
