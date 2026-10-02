// The only door to Aspire. Shared by every probe pass.
//
// Rules this file enforces:
// - Every data request is a GET. The only POST is the auth handshake, to a fixed list
//   of token paths. Anything else throws before it leaves the building.
// - A hard cap on total calls, spacing between calls, a time budget, and backoff on 429.
// - No secret or token ever lands in anything this returns.

export const BASE = 'https://cloud-api.youraspire.com';

// the handshake candidates, tried in this order. OAuth client credentials first.
export const AUTH_ATTEMPTS = [
  { name: 'OAuth2 client_credentials (form body)', path: '/connect/token', kind: 'oauth' },
  { name: 'OAuth2 client_credentials (form body)', path: '/oauth/token', kind: 'oauth' },
  { name: 'OAuth2 client_credentials (form body)', path: '/token', kind: 'oauth' },
  { name: 'Aspire JSON handshake { ClientId, Secret }', path: '/Authorization', kind: 'aspire' },
];
const AUTH_PATHS = AUTH_ATTEMPTS.map((a) => a.path);

type Fetch = (url: string, init?: any) => Promise<any>;
export interface ProbeOptions {
  clientId: string;
  secret: string;
  base?: string;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: Date;
  maxCalls?: number;
  spacingMs?: number;
  deadlineMs?: number; // stop and report before the host kills the function
  clock?: () => number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
export const isDate = (v: unknown) => typeof v === 'string' && DATE_RE.test(v);
export const typeOf = (v: unknown) => (v === null || v === undefined ? 'null' : Array.isArray(v) ? 'array' : isDate(v) ? 'date' : typeof v);

export function records(json: any): any[] | null {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.value)) return json.value;
  if (json && Array.isArray(json.Items)) return json.Items;
  if (json && Array.isArray(json.items)) return json.items;
  return null;
}
export function envelope(json: any): string {
  if (Array.isArray(json)) return 'bare JSON array';
  if (json && Array.isArray(json.value)) return 'OData { value: [...] }';
  if (json && Array.isArray(json.Items)) return '{ Items: [...] }';
  if (json && Array.isArray(json.items)) return '{ items: [...] }';
  return 'unrecognized';
}
export function fieldsOf(rec: any) {
  if (!rec || typeof rec !== 'object') return [];
  return Object.keys(rec).map((k) => ({ name: k, type: typeOf(rec[k]) }));
}
export const qs = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

export async function openAspire(opts: ProbeOptions) {
  const base = (opts.base || BASE).replace(/\/+$/, '');
  const f: Fetch = opts.fetch || ((u, i) => fetch(u, i));
  const sleep = opts.sleep || ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now || new Date();
  const maxCalls = opts.maxCalls ?? 70;
  const spacing = opts.spacingMs ?? 350;
  const deadline = opts.deadlineMs ?? 110_000; // edge functions are cut off at about 150s on the free plan
  const clock = opts.clock || (() => Date.now());
  const started = clock();
  const elapsed = () => clock() - started;
  const s = { calls: 0, throttled: 0, outOfTime: false };
  const log: any[] = [];

  async function call(method: string, path: string, init: { headers?: any; body?: string } = {}) {
    const bare = path.split('?')[0];
    if (method !== 'GET' && !(method === 'POST' && AUTH_PATHS.includes(bare))) {
      throw new Error(`refused: ${method} ${bare}. The probe only reads.`);
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      if (s.calls >= maxCalls || elapsed() > deadline) {
        const why = s.calls >= maxCalls ? 'call budget reached' : 'time budget reached';
        if (why === 'time budget reached') s.outOfTime = true;
        log.push({ method, path, skipped: why });
        return { status: 0, skipped: true, json: null, text: '', headers: {} as any };
      }
      s.calls++;
      if (s.calls > 1) await sleep(spacing);
      const t0 = Date.now();
      let res: any;
      try {
        res = await f(base + path, { method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(20_000) });
      } catch (e) {
        log.push({ method, path, error: String((e as any)?.message || e) });
        return { status: -1, json: null, text: String(e), headers: {} as any };
      }
      const ms = Date.now() - t0;
      if (res.status === 429) {
        s.throttled++;
        const ra = Number(res.headers?.get?.('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : 2000 * 2 ** attempt;
        if (elapsed() + wait > deadline) {
          s.outOfTime = true;
          log.push({ method, path, status: 429, ms, gave_up: 'waiting would run past the time budget' });
          return { status: 429, json: null, text: '', headers: {} as any };
        }
        log.push({ method, path, status: 429, ms, retry_in_ms: wait });
        await sleep(wait);
        continue;
      }
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      log.push({ method, path, status: res.status, ms });
      return { status: res.status, json, text, headers: res.headers };
    }
    log.push({ method, path, gave_up: 'still 429 after 4 tries' });
    return { status: 429, json: null, text: '', headers: {} as any };
  }

  // ---------- auth ----------
  const auth: any = { worked: null, attempts: [] };
  let authHeader: string | null = null;
  for (const a of AUTH_ATTEMPTS) {
    const body = a.kind === 'oauth'
      ? qs({ grant_type: 'client_credentials', client_id: opts.clientId, client_secret: opts.secret })
      : JSON.stringify({ ClientId: opts.clientId, Secret: opts.secret });
    const headers = a.kind === 'oauth'
      ? { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
      : { 'Content-Type': 'application/json', Accept: 'application/json' };
    const r = await call('POST', a.path, { headers, body });
    const keys = r.json && typeof r.json === 'object' ? Object.keys(r.json) : [];
    const tokenKey = ['access_token', 'Token', 'token', 'AccessToken', 'accessToken'].find((k) => typeof r.json?.[k] === 'string');
    const attempt: any = { name: a.name, request: `POST ${a.path} (${headers['Content-Type']})`, status: r.status, response_fields: keys };
    auth.attempts.push(attempt);
    if (!(r.status >= 200 && r.status < 300) || !tokenKey) continue;

    const token = r.json[tokenKey];
    const scheme = typeof r.json.token_type === 'string' ? r.json.token_type : 'Bearer';
    // prove it: one cheap GET, first as "<scheme> <token>", then the raw token
    for (const h of [`${scheme} ${token}`, token]) {
      const v = await call('GET', `/Divisions?${qs({ $top: '1' })}`, { headers: { Authorization: h, Accept: 'application/json' } });
      if (v.status >= 200 && v.status < 300) { authHeader = h; attempt.verified_with = h === token ? 'Authorization: <raw token>' : `Authorization: ${scheme} <token>`; break; }
      attempt[`verify_${h === token ? 'raw' : 'scheme'}_status`] = v.status;
    }
    if (!authHeader) continue;
    const exp = r.json.expires_in ?? r.json.ExpiresIn ?? r.json.expiration ?? r.json.Expiration ?? null;
    auth.worked = {
      endpoint: `POST ${base}${a.path}`,
      body: a.kind === 'oauth' ? 'form: grant_type=client_credentials, client_id, client_secret' : 'JSON: { "ClientId": "...", "Secret": "..." }',
      token_field: tokenKey,
      header: attempt.verified_with,
      token_shape: token.split('.').length === 3 ? 'JWT (three dot-separated parts)' : `opaque string, ${token.length} chars`,
      expires: exp,
      refresh_token_returned: ['refresh_token', 'RefreshToken', 'refreshToken'].some((k) => typeof r.json[k] === 'string'),
    };
    break;
  }

  const H = { Authorization: authHeader || '', Accept: 'application/json' };
  const get = (p: string) => call('GET', p, { headers: H });
  const footer = () => ({
    generated_at: now.toISOString(), base, calls_used: s.calls, call_budget: maxCalls, throttled: s.throttled,
    seconds: Math.round(elapsed() / 1000), stopped_early: s.outOfTime,
    // enforced by call(): anything but GET, or POST to a token path, throws before it is sent
    data_writes: 0,
  });
  const tail = (summary: string[]) => {
    if (s.throttled) summary.push(`Throttled ${s.throttled} time(s). Backed off and retried.`);
    if (s.outOfTime) summary.push('Stopped early to stay inside the time budget. Everything above is real; anything missing was skipped, not failed. Run it again to fill the gaps.');
    if (log.some((l) => l.skipped === 'call budget reached')) summary.push(`Hit the ${maxCalls}-call budget. Anything after that point was skipped, not failed.`);
  };
  return { base, now, get, auth, authed: !!authHeader, log, footer, tail };
}
