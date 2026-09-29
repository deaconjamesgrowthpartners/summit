// Who may run the probe. Three ways in, checked in order:
//   1. the bearer token equals SUPABASE_SERVICE_ROLE_KEY
//   2. the bearer token is a JWT with role "service_role", and Supabase itself
//      accepts it on an admin-only endpoint (so a hand-made token with that
//      claim but no valid signature is refused)
//   3. the bearer token belongs to a signed-in user with a row in app_admins
// Everyone else is refused, with the result of every check, so a failure says why.
// Never echoes a key or a token. Only its kind and length.

type Fetch = (url: string, init?: any) => Promise<any>;
export interface GateEnv {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

export function kindOf(t: string | undefined | null) {
  if (!t) return 'not set';
  if (t.startsWith('sb_secret_')) return `new-format secret key (sb_secret_..., ${t.length} chars)`;
  if (t.startsWith('sb_publishable_')) return `new-format publishable key (sb_publishable_..., ${t.length} chars)`;
  if (t.split('.').length === 3) return `JWT (${t.length} chars)`;
  return `opaque string (${t.length} chars)`;
}

export function jwtClaims(t: string): any | null {
  const parts = t.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[1].length / 4) * 4, '=');
    return JSON.parse(atob(b64));
  } catch {
    return null;
  }
}

export async function authorize(authHeader: string | null, env: GateEnv, f: Fetch = (u, i) => fetch(u, i)) {
  const checks: Record<string, string> = {};
  const token = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
  const url = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  if (!token) {
    return { ok: false, via: null, checks: { header: 'no: no Authorization: Bearer <token> header on the request' } };
  }
  checks.token = `received a ${kindOf(token)}`;

  // 1. exact match to the injected service role key
  const svc = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!svc) checks.service_key_match = 'no: SUPABASE_SERVICE_ROLE_KEY is not set in this function';
  else if (token === svc) return { ok: true, via: 'service_key_match', checks: { ...checks, service_key_match: 'yes' } };
  else checks.service_key_match = `no: token differs from SUPABASE_SERVICE_ROLE_KEY, which is a ${kindOf(svc)}`;

  // 2. a JWT that claims service_role, confirmed by Supabase
  const claims = jwtClaims(token);
  if (!claims) checks.service_role_jwt = 'no: token is not a JWT';
  else if (claims.role !== 'service_role') checks.service_role_jwt = `no: JWT role claim is "${claims.role ?? '(none)'}"`;
  else if (!url) checks.service_role_jwt = 'no: role claim is service_role, but SUPABASE_URL is not set, so it could not be confirmed';
  else {
    try {
      const r = await f(`${url}/auth/v1/admin/users?page=1&per_page=1`, { headers: { apikey: token, Authorization: `Bearer ${token}` } });
      if (r.status === 200) return { ok: true, via: 'service_role_jwt', checks: { ...checks, service_role_jwt: 'yes: role claim is service_role and Supabase accepted it' } };
      checks.service_role_jwt = `no: role claim is service_role but Supabase rejected the token (${r.status}). Wrong project, rotated, or not a real key.`;
    } catch (e) {
      checks.service_role_jwt = `no: could not reach ${url} to confirm it (${String((e as any)?.message || e)})`;
    }
  }

  // 3. a signed-in Summit admin
  if (!url) checks.app_admin = 'no: SUPABASE_URL is not set';
  else if (claims && claims.role === 'service_role') checks.app_admin = 'no: token is a service role key, not a user';
  else {
    const apikey = env.SUPABASE_ANON_KEY || token;
    try {
      const u = await f(`${url}/auth/v1/user`, { headers: { apikey, Authorization: `Bearer ${token}` } });
      const user = u.status === 200 ? await u.json() : null;
      if (!user?.id) checks.app_admin = `no: not a signed-in user (auth returned ${u.status})`;
      else {
        const a = await f(`${url}/rest/v1/app_admins?select=user_id&user_id=eq.${encodeURIComponent(user.id)}`, { headers: { apikey, Authorization: `Bearer ${token}` } });
        const rows = a.status === 200 ? await a.json() : null;
        if (Array.isArray(rows) && rows.length) return { ok: true, via: 'app_admin', checks: { ...checks, app_admin: `yes: ${user.email || user.id} is in app_admins` } };
        checks.app_admin = Array.isArray(rows) ? `no: ${user.email || user.id} is signed in but has no app_admins row` : `no: app_admins lookup returned ${a.status}`;
      }
    } catch (e) {
      checks.app_admin = `no: could not reach ${url} (${String((e as any)?.message || e)})`;
    }
  }
  return { ok: false, via: null, checks };
}
