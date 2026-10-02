// The only door to Aspire for the sync. Read only.
//
// - Every request to Aspire is a GET. The one exception is the login, POST /Authorization.
//   Anything else throws before it is sent. The credential is GET only too, so a write would
//   fail at Aspire anyway. This makes sure one is never tried.
// - 350ms between calls, backoff on 429, a 20s timeout per call, and a time budget.
// - A 401 mid-run logs in again, once.
// - No secret or token ever lands in a log, an error or the result.

export const ASPIRE_BASE = 'https://cloud-api.youraspire.com';
export const AUTH_PATH = '/Authorization';

type Fetch = (url: string, init?: any) => Promise<any>;
export interface AspireOptions {
  clientId: string;
  secret: string;
  base?: string;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  spacingMs?: number;
  deadlineMs?: number;
  clock?: () => number;
}

export const toQuery = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
export function recordsOf(json: any): any[] | null {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.value)) return json.value;
  return null;
}

export function aspireClient(opts: AspireOptions) {
  const base = (opts.base || ASPIRE_BASE).replace(/\/+$/, '');
  const f: Fetch = opts.fetch || ((u, i) => fetch(u, i));
  const sleep = opts.sleep || ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const spacing = opts.spacingMs ?? 350;
  const deadline = opts.deadlineMs ?? 120_000;
  const clock = opts.clock || (() => Date.now());
  const started = clock();
  const s = { calls: 0, throttled: 0, relogins: 0, outOfTime: false };
  let token: string | null = null;

  async function send(method: string, path: string, init: { headers?: any; body?: string } = {}) {
    const bare = path.split('?')[0];
    if (method !== 'GET' && !(method === 'POST' && bare === AUTH_PATH)) {
      throw new Error(`refused: ${method} ${bare}. The sync never writes to Aspire.`);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      if (clock() - started > deadline) { s.outOfTime = true; return { status: 0, skipped: true, json: null }; }
      if (s.calls++) await sleep(spacing);
      let res: any;
      try {
        res = await f(base + path, { method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(20_000) });
      } catch (e) {
        return { status: -1, json: null, error: String((e as any)?.message || e) };
      }
      if (res.status === 429) {
        s.throttled++;
        const ra = Number(res.headers?.get?.('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : 2000 * 2 ** attempt;
        if (clock() - started + wait > deadline) { s.outOfTime = true; return { status: 429, json: null }; }
        await sleep(wait);
        continue;
      }
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json };
    }
    return { status: 429, json: null };
  }

  async function login() {
    const r = await send('POST', AUTH_PATH, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ClientId: opts.clientId, Secret: opts.secret }),
    });
    if (r.skipped) throw new Error('ran out of time before logging in to Aspire');
    if (r.status !== 200 || typeof r.json?.Token !== 'string') throw new Error(`Aspire login failed (${r.status})`);
    token = r.json.Token;
  }

  async function get(path: string) {
    if (!token) await login();
    let r = await send('GET', path, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (r.status === 401 && !s.relogins) {
      s.relogins++;
      await login();
      r = await send('GET', path, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    }
    return r;
  }

  return { get, stats: () => ({ ...s, seconds: Math.round((clock() - started) / 1000) }) };
}
