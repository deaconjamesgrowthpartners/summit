// The probe against a simulated Aspire. No network. Proves the logic, not Aspire's real shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probe, AUTH_ATTEMPTS } from '../supabase/functions/aspire-probe/probe.ts';

const ID = 'client-id-xyz', SECRET = 'super-secret-value-123', TOKEN = 'eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl';

function world() {
  const d = (n) => new Date(Date.UTC(2026, 8, 29) - n * 86400000).toISOString();
  const opps = Array.from({ length: 40 }, (_, i) => ({
    OpportunityID: 1000 + i, OpportunityName: `Job ${i}`, OpportunityStatusName: ['Won', 'Lost', 'Proposal Sent', 'Qualifying', 'Won'][i % 5],
    SalesRepContactID: 10 + (i % 3), SalesRepContactName: ['Rep A', 'Rep B', 'Rep C'][i % 3], BranchID: 1 + (i % 2), BranchName: ['Oakwood', 'Knoxville'][i % 2],
    DivisionID: 7, DivisionName: 'Maintenance', EstimatedDollars: 1000 * i, WonDate: i % 5 === 0 || i % 5 === 4 ? d(i) : null, LostDate: i % 5 === 1 ? d(i) : null,
    ModifiedDate: d(i), PropertyID: 500 + i,
  }));
  const data = {
    '/Opportunities': { rows: opps, filter: true },
    '/Properties': { rows: [{ PropertyID: 1, PropertyName: 'X', CreatedDate: d(3) }], filter: true },
    '/ContractYears': { rows: [{ ContractYearID: 1, LastModifiedDate: d(2) }], filter: true },
    '/Contacts': { rows: [{ ContactID: 1, FirstName: 'A', ModifiedDate: d(1) }, { ContactID: 2, ModifiedDate: d(400) }], filter: false }, // ignores $filter
    '/Invoices': { forbidden: true },
    '/Divisions': { rows: [{ DivisionID: 7, DivisionName: 'Maintenance' }, { DivisionID: 8, DivisionName: 'Enhancement' }], filter: true },
    '/Branches': { rows: [{ BranchID: 1, BranchName: 'Oakwood' }, { BranchID: 2, BranchName: 'Knoxville' }], filter: true },
    '/OpportunityStatuses': { rows: [{ OpportunityStatusID: 1, OpportunityStatusName: 'Won' }, { OpportunityStatusID: 3, OpportunityStatusName: 'Proposal Sent' }], filter: true },
  };
  const seen = [];
  let throttledOnce = false;
  const res = (status, body, headers = {}) => ({ status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  async function fetch(url, init = {}) {
    const u = new URL(url);
    seen.push({ method: init.method || 'GET', path: u.pathname });
    if (init.method === 'POST') {
      if (u.pathname !== '/Authorization') return res(404, 'Not Found');
      const b = JSON.parse(init.body);
      return b.ClientId === ID && b.Secret === SECRET ? res(200, { Token: TOKEN, RefreshToken: 'refresh-xyz' }) : res(401, { message: 'bad' });
    }
    if (init.headers?.Authorization !== `Bearer ${TOKEN}`) return res(401, { message: 'unauthorized' });
    if (u.pathname === '/Opportunities' && !throttledOnce) { throttledOnce = true; return res(429, 'slow down', { 'retry-after': '1' }); }
    const counting = u.pathname.endsWith('/$count');
    const r = data[counting ? u.pathname.replace('/$count', '') : u.pathname];
    if (!r) return res(404, 'Not Found');
    if (r.forbidden) return res(403, { message: 'forbidden' });
    let rows = r.rows;
    const f = u.searchParams.get('$filter');
    if (f && r.filter) {
      const m = f.match(/^(\w+) ge (\S+)$/);
      if (m) rows = rows.filter((x) => x[m[1]] && x[m[1]] >= m[2]);
      else if (/eq null and/.test(f)) { const [a, b] = f.split(' and ').map((s) => s.split(' ')[0]); rows = rows.filter((x) => x[a] == null && x[b] == null); }
    }
    const top = u.searchParams.get('$top');
    const body = { value: top !== null ? rows.slice(0, +top) : rows };
    if (u.searchParams.get('$count') === 'true') body['@odata.count'] = rows.length;
    return res(200, body);
  }
  return { fetch, seen };
}

const run = async (w, extra = {}) => probe({ clientId: ID, secret: SECRET, fetch: w.fetch, sleep: async () => {}, now: new Date('2026-09-29T12:00:00Z'), ...extra });

test('auth: tries OAuth first, reports exactly which handshake worked', async () => {
  const r = await run(world());
  assert.deepEqual(r.auth.attempts.map((a) => a.request.split(' ')[1]), ['/connect/token', '/oauth/token', '/token', '/Authorization']);
  assert.equal(r.auth.worked.endpoint, 'POST https://cloud-api.youraspire.com/Authorization');
  assert.equal(r.auth.worked.token_field, 'Token');
  assert.equal(r.auth.worked.header, 'Authorization: Bearer <token>');
  assert.equal(r.auth.worked.token_shape, 'JWT (three dot-separated parts)');
  assert.equal(r.auth.worked.refresh_token_returned, true);
});

test('never leaks the secret, the client id or a token into the report', async () => {
  const s = JSON.stringify(await run(world()));
  for (const x of [SECRET, ID, TOKEN, 'refresh-xyz']) assert.ok(!s.includes(x), `leaked ${x}`);
});

test('reads only: every request is a GET, except POST to a token path', async () => {
  const w = world(); await run(w);
  const bad = w.seen.filter((c) => c.method !== 'GET' && !(c.method === 'POST' && AUTH_ATTEMPTS.some((a) => a.path === c.path)));
  assert.deepEqual(bad, []);
});

test('resources: existence, fallback paths, counts, forbidden, field names', async () => {
  const r = await run(world());
  assert.equal(r.resources.Opportunities.count, 40);
  assert.equal(r.resources.Contracts.path, '/ContractYears');
  assert.match(String(r.resources.Invoices.exists), /not allowed/);
  assert.ok(r.resources.Opportunities.fields.some((f) => f.name === 'ModifiedDate' && f.type === 'date'));
  assert.equal(r.resources.Opportunities.envelope, 'OData { value: [...] }');
});

test('modified-since: proves the filter is applied, catches one that is ignored', async () => {
  const r = await run(world());
  assert.equal(r.resources.Opportunities.modified_since.supported, true);
  assert.equal(r.resources.Opportunities.modified_since.field, 'ModifiedDate');
  assert.equal(r.resources.ContractYears, undefined);
  assert.equal(r.resources.Contracts.modified_since.field, 'LastModifiedDate');
  assert.equal(r.resources.Contacts.modified_since.supported, false);
  assert.match(r.resources.Contacts.modified_since.why, /ignored/);
  assert.equal(r.resources.Properties.modified_since.supported, 'unknown'); // only a CreatedDate
});

test('open opportunities: found, counted, statuses listed', async () => {
  const r = await run(world());
  assert.match(r.open_opportunities.answer, /^yes/);
  assert.equal(r.open_opportunities.total_open_by_dates, 16);
  assert.equal(r.open_opportunities.by_status['Proposal Sent'], 8);
  assert.deepEqual(r.open_opportunities.status_list, ['Won', 'Proposal Sent']);
});

test('identifiers: rep, branch and division fields named with examples', async () => {
  const r = await run(world());
  assert.deepEqual(r.identifiers.rep.map((x) => x.field), ['SalesRepContactID', 'SalesRepContactName']);
  assert.deepEqual(r.identifiers.branch.map((x) => x.field), ['BranchID', 'BranchName']);
  assert.deepEqual(r.identifiers.division.map((x) => x.field), ['DivisionID', 'DivisionName']);
  assert.equal(r.identifiers.branches_list.length, 2);
});

test('429: backs off and retries, stays inside the call budget', async () => {
  const r = await run(world());
  assert.equal(r.throttled, 1);
  assert.ok(r.log.some((l) => l.status === 429 && l.retry_in_ms === 1000));
  assert.ok(r.calls_used <= r.call_budget);
  const tight = await run(world(), { maxCalls: 8 });
  assert.ok(tight.calls_used <= 8);
  assert.ok(tight.log.some((l) => l.skipped));
});

test('bad credentials: returns a report instead of throwing, touches no data', async () => {
  const w = world();
  const r = await probe({ clientId: ID, secret: 'wrong', fetch: w.fetch, sleep: async () => {} });
  assert.equal(r.auth.worked, null);
  assert.match(r.summary[0], /nothing worked/);
  assert.ok(w.seen.every((c) => c.method === 'POST'));
});
