// aspire-sync: Aspire opportunities into Summit's aspire_opps. Reads Aspire, never writes to it.
// Writes only aspire_opps and aspire_sync_runs, through the SQL functions in migration 007.
//
// Who may run it: the same gate as aspire-probe. The service role key (what the nightly pg_cron
// job sends), a service_role JWT that Supabase confirms, or a Summit admin. Anyone else gets 403.
//
// Body (all optional):
//   {"full": true}           re-pull everything instead of ModifiedDate since the last good run
//   {"workspace": "<slug>"}  only needed if more than one workspace has crm_source = 'aspire'
//   {"trigger": "cron"}      a label for the log
//   {"pageSize": 200}        records per Aspire page and per write to Summit. Default 200, max 1000
//
// Deploy:  paste supabase/dashboard/aspire-sync.ts into the dashboard editor as "aspire-sync"
//          or: supabase functions deploy aspire-sync --project-ref tyrtzxnhwjchtemytfxv
// Secrets: ASPIRE_CLIENT_ID, ASPIRE_CLIENT_SECRET (already set). Optional ASPIRE_BASE_URL,
//          ASPIRE_SYNC_SECONDS (time budget, default 120. The free plan cuts off at 150).

import { authorize } from '../aspire-probe/gate.ts';
import { runSync, restDb } from './sync.ts';

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  const env = (k: string) => Deno.env.get(k);
  const gate = await authorize(req.headers.get('Authorization'), {
    SUPABASE_URL: env('SUPABASE_URL'), SUPABASE_ANON_KEY: env('SUPABASE_ANON_KEY'), SUPABASE_SERVICE_ROLE_KEY: env('SUPABASE_SERVICE_ROLE_KEY'),
  });
  if (!gate.ok) return reply({ error: 'not allowed: none of the three checks passed', checks: gate.checks }, 403);

  const clientId = env('ASPIRE_CLIENT_ID'), secret = env('ASPIRE_CLIENT_SECRET');
  const url = env('SUPABASE_URL'), key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!clientId || !secret) return reply({ error: 'ASPIRE_CLIENT_ID and ASPIRE_CLIENT_SECRET must both be set as function secrets' }, 500);
  if (!url || !key) return reply({ error: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not available to this function' }, 500);

  let body: any = {};
  try { body = (await req.json()) || {}; } catch { /* empty body */ }
  const secs = Number(env('ASPIRE_SYNC_SECONDS'));
  const result = await runSync({
    aspire: { clientId, secret, base: env('ASPIRE_BASE_URL') || undefined, deadlineMs: (Number.isFinite(secs) && secs > 0 ? secs : 120) * 1000 },
    db: restDb(url, key),
    workspace: typeof body.workspace === 'string' ? body.workspace : null,
    full: body.full === true,
    trigger: body.trigger === 'cron' ? 'cron' : 'manual',
    pageSize: Number.isInteger(body.pageSize) ? body.pageSize : undefined,
  });
  const code = result.status === 'refused' ? 409 : result.status === 'error' ? 502 : 200;
  return reply({ allowed_via: gate.via, ...result }, code);
});
