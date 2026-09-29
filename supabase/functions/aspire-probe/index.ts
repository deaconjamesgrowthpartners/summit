// aspire-probe: discovery only. Authenticates to Aspire, reads a handful of records
// per endpoint, and returns a report on the shape of the data. It writes nothing,
// to Aspire or to Summit. See probe.ts for the rules it enforces.
//
// Who may run it: see gate.ts. The service role key, a service_role JWT that
// Supabase confirms, or a Summit admin. Anyone else gets 403 with the result of
// each check. The Aspire credential never leaves this function.
//
// Deploy:  supabase functions deploy aspire-probe --project-ref tyrtzxnhwjchtemytfxv
//          or paste supabase/dashboard/aspire-probe.ts into the dashboard editor
// Secrets: ASPIRE_CLIENT_ID, ASPIRE_CLIENT_SECRET (already set). Optional ASPIRE_BASE_URL.
// Run:     POST or GET the function URL. Add ?format=text for the plain summary only.

import { probe, BASE } from './probe.ts';
import { authorize } from './gate.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

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

  const report = await probe({ clientId, secret, base: Deno.env.get('ASPIRE_BASE_URL') || BASE });

  if (new URL(req.url).searchParams.get('format') === 'text') {
    return new Response(`allowed via ${gate.via}\n` + report.summary.join('\n') + '\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  return json({ allowed_via: gate.via, ...report });
});
