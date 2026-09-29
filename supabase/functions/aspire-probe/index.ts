// aspire-probe: discovery only. Authenticates to Aspire, reads a handful of records
// per endpoint, and returns a report on the shape of the data. It writes nothing,
// to Aspire or to Summit. See probe.ts for the rules it enforces.
//
// Who may run it: a Summit admin (a row in app_admins), or the project's service
// role (the dashboard's Test button). Anyone else gets 403. The Aspire credential
// never leaves this function.
//
// Deploy:  supabase functions deploy aspire-probe --project-ref tyrtzxnhwjchtemytfxv
// Secrets: ASPIRE_CLIENT_ID, ASPIRE_CLIENT_SECRET (already set). Optional ASPIRE_BASE_URL.
// Run:     POST or GET the function URL. Add ?format=text for the plain summary only.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { probe, BASE } from './probe.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

async function allowed(req: Request): Promise<{ ok: boolean; why?: string }> {
  const header = req.headers.get('Authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '');
  if (!token) return { ok: false, why: 'sign in first' };
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (service && token === service) return { ok: true };
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: header } },
    auth: { persistSession: false },
  });
  const { data: u, error } = await sb.auth.getUser(token);
  if (error || !u?.user) return { ok: false, why: 'sign in first' };
  // app_admins row level security lets a user see only their own row
  const { data } = await sb.from('app_admins').select('user_id').eq('user_id', u.user.id);
  return data && data.length ? { ok: true } : { ok: false, why: 'admins only' };
}

Deno.serve(async (req) => {
  const gate = await allowed(req);
  if (!gate.ok) return json({ error: gate.why }, 403);

  const clientId = Deno.env.get('ASPIRE_CLIENT_ID');
  const secret = Deno.env.get('ASPIRE_CLIENT_SECRET');
  if (!clientId || !secret) return json({ error: 'ASPIRE_CLIENT_ID and ASPIRE_CLIENT_SECRET must both be set as function secrets' }, 500);

  const report = await probe({ clientId, secret, base: Deno.env.get('ASPIRE_BASE_URL') || BASE });

  if (new URL(req.url).searchParams.get('format') === 'text') {
    return new Response(report.summary.join('\n') + '\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  return json(report);
});
