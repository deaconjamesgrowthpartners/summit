// source-sync: a connected source into Summit's deals. Reads the source, never writes to it.
// Writes only deals, deal_snapshots and source_runs, through the SQL functions in migration 012.
//
// Who may run it: the same gate as aspire-probe. The service role key (what the nightly pg_cron
// job sends), a service_role JWT that Supabase confirms, or a Summit admin. Anyone else gets 403.
//
// Body (all optional):
//   {"source": 3}            the deal_sources id. Without it: {"workspace": "<slug>"}, else the only connected source
//   {"full": true}           re-pull everything instead of changes since the last good run
//   {"trigger": "cron"}      a label for the log
//   {"pageSize": 200}        records per page and per write to Summit. Default 200, max 1000
//
// Connectors built: aspire. Credentials come by reference (deal_sources.credential_ref), never stored in Summit:
//   env:ASPIRE  ->  ASPIRE_CLIENT_ID, ASPIRE_CLIENT_SECRET (already set), optional ASPIRE_BASE_URL.
// Optional SYNC_SECONDS (time budget, default 120. The free plan cuts off at 150).
//
// Deploy:  paste supabase/dashboard/source-sync.ts into the dashboard editor as "source-sync"
//          or: supabase functions deploy source-sync --project-ref tyrtzxnhwjchtemytfxv

import { authorize } from '../aspire-probe/gate.ts';
import { runSync, restDb, aspireConnector, envCredentials } from './sync.ts';

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  const env = (k: string) => Deno.env.get(k);
  const gate = await authorize(req.headers.get('Authorization'), {
    SUPABASE_URL: env('SUPABASE_URL'), SUPABASE_ANON_KEY: env('SUPABASE_ANON_KEY'), SUPABASE_SERVICE_ROLE_KEY: env('SUPABASE_SERVICE_ROLE_KEY'),
  });
  if (!gate.ok) return reply({ error: 'not allowed: none of the three checks passed', checks: gate.checks }, 403);

  const url = env('SUPABASE_URL'), key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return reply({ error: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not available to this function' }, 500);

  let body: any = {};
  try { body = (await req.json()) || {}; } catch { /* empty body */ }
  const secs = Number(env('SYNC_SECONDS') || env('ASPIRE_SYNC_SECONDS'));
  const deadlineMs = (Number.isFinite(secs) && secs > 0 ? secs : 120) * 1000;
  const result = await runSync({
    db: restDb(url, key),
    connectors: { aspire: aspireConnector({ deadlineMs }) },
    credentials: envCredentials(env),
    source: Number.isInteger(body.source) ? body.source : null,
    workspace: typeof body.workspace === 'string' ? body.workspace : null,
    full: body.full === true,
    trigger: body.trigger === 'cron' ? 'cron' : 'manual',
    pageSize: Number.isInteger(body.pageSize) ? body.pageSize : undefined,
  });
  const code = result.status === 'refused' ? 409 : result.status === 'error' ? 502 : 200;
  return reply({ allowed_via: gate.via, ...result }, code);
});
