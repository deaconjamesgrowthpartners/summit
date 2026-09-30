// aspire-probe: discovery only. Authenticates to Aspire, reads a handful of records
// per endpoint, and returns a report on the shape of the data. It writes nothing,
// to Aspire or to Summit. client.ts holds the rules: GET only, call and time budgets.
//
// Three passes:
//   pass 3 (the default): reconcile Aspire against Summit. Every open opportunity plus
//          everything won in 180 days, by rep and status; and 90 days of activities per
//          person per week. See probe3.ts. Add "part": "ownership" or "activity" to run half.
//   pass 2: can site audits and client visits be counted, and who owns a deal? See probe2.ts.
//   pass 1: the core resources, pipeline and identifiers. See probe.ts.
// Pick one with a JSON body {"pass": 2} or ?pass=2. An empty body {} runs pass 3.
//
// Who may run it: see gate.ts. The service role key, a service_role JWT that
// Supabase confirms, or a Summit admin. Anyone else gets 403 with the result of
// each check. The Aspire credential never leaves this function.
//
// Deploy:  paste supabase/dashboard/aspire-probe.ts into the dashboard editor
//          or: supabase functions deploy aspire-probe --project-ref tyrtzxnhwjchtemytfxv
// Secrets: ASPIRE_CLIENT_ID, ASPIRE_CLIENT_SECRET (already set). Optional ASPIRE_BASE_URL.
//          Optional ASPIRE_PROBE_SECONDS: the time budget, default 125 (free plan cuts off at 150).
// Run:     POST or GET the function URL. Add ?format=text for the plain summary only, or
//          ?format=csv on pass 3 for the opportunity rows as a spreadsheet.

import { BASE } from './client.ts';
import { probe } from './probe.ts';
import { probe2 } from './probe2.ts';
import { probe3, toCsv, type Pass3Part } from './probe3.ts';
import { authorize } from './gate.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

async function readArgs(req: Request): Promise<{ pass: 1 | 2 | 3; part: Pass3Part }> {
  const u = new URL(req.url).searchParams;
  let body: any = {};
  try { body = (await req.clone().json()) || {}; } catch { /* empty or not JSON */ }
  const n = Number(u.get('pass') ?? body.pass);
  const pass = (n === 1 || n === 2 ? n : 3) as 1 | 2 | 3;
  const p = u.get('part') ?? body.part;
  return { pass, part: p === 'ownership' || p === 'activity' ? p : 'both' };
}

Deno.serve(async (req) => {
  const gate = await authorize(req.headers.get('Authorization'), {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
    SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY'),
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  });
  if (!gate.ok) return json({ error: 'not allowed: none of the three checks passed', checks: gate.checks }, 403);

  const clientId = Deno.env.get('ASPIRE_CLIENT_ID');
  const secret = Deno.env.get('ASPIRE_CLIENT_SECRET');
  if (!clientId || !secret) return json({ error: 'ASPIRE_CLIENT_ID and ASPIRE_CLIENT_SECRET must both be set as function secrets', allowed_via: gate.via }, 500);

  const { pass, part } = await readArgs(req);
  const opts = { clientId, secret, base: Deno.env.get('ASPIRE_BASE_URL') || BASE };
  const secs = Number(Deno.env.get('ASPIRE_PROBE_SECONDS'));
  const report: any = pass === 1 ? await probe(opts) : pass === 2 ? await probe2(opts)
    : await probe3({ ...opts, part, deadlineMs: (Number.isFinite(secs) && secs > 0 ? secs : 125) * 1000 });

  const format = new URL(req.url).searchParams.get('format');
  if (format === 'csv' && pass === 3) {
    return new Response(toCsv(report.ownership?.rows || []), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="aspire-opportunities.csv"' } });
  }
  if (format === 'text') {
    return new Response(`allowed via ${gate.via}, pass ${pass}${pass === 3 ? `, part ${part}` : ''}\n` + report.summary.join('\n') + '\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  return json({ allowed_via: gate.via, ...report });
});
