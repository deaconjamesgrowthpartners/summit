// The sync, for any connected source. The run itself is generic: resolve the source, begin a run, hand the
// connector a writer, finish the run (migration 012: source_sync_resolve, _begin, _upsert, _finish). Those only
// write deals and source_runs. Commits, goals and the book are never touched. Mapping a source's fields into
// Summit's is config in deal_sources.mapping; a connector only fetches.
//
// The Aspire connector: Opportunities. Full pull on the first run, then ModifiedDate since the last good run. Pages by key:
// OpportunityID gt <last seen>, ordered by OpportunityID asc, $top=200 (pageSize). $count does not work at
// Aspire, so a pull ends on an empty page or a short one. Each page is written as it arrives, so
// a run that runs out of time keeps what it got, is logged as partial, and does not move the
// watermark. The next run picks it up. A page Summit fails to write is logged and skipped; the
// run carries on, ends partial, and the next run pulls those rows again.

import { aspireClient, recordsOf, toQuery, type AspireOptions } from './aspire.ts';

export interface Db { rpc: (fn: string, args: Record<string, unknown>) => Promise<any> }

// Summit's side: PostgREST RPC with the service role key. Only these functions are called.
export const SYNC_RPCS = ['source_sync_resolve', 'source_sync_begin', 'source_sync_upsert', 'source_sync_finish'];
export function restDb(url: string, key: string, f: (u: string, i?: any) => Promise<any> = (u, i) => fetch(u, i)): Db {
  const base = url.replace(/\/+$/, '');
  return {
    async rpc(fn, args) {
      if (!SYNC_RPCS.includes(fn)) throw new Error(`refused: ${fn} is not a sync function`);
      const res = await f(`${base}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      if (res.status >= 300) throw new Error(`${fn}: ${json?.message || text.slice(0, 200) || res.status}`);
      return json;
    },
  };
}

// what a connector gets: where the run starts, and a writer for pages of raw records
export interface ConnectorRun {
  begin: { run_id: number; mode: string; since: string | null; options?: Record<string, unknown> };
  credentials: Record<string, string>;
  write: (records: any[], label?: string) => Promise<void>;  // label: which records, for the log
  pageSize: number;
  maxPages: number;
}
export interface ConnectorResult {
  complete: boolean;   // the source said it has nothing more. Only then can a full pull mark rows removed
  errors: string[];    // the run stopped
  pageErrors: string[];
  notes: string[];
  calls: number;
  seconds?: number;
}
export type Connector = (r: ConnectorRun) => Promise<ConnectorResult>;

export interface SyncArgs {
  db: Db;
  connectors: Record<string, Connector>;
  credentials: (ref: string | null) => Record<string, string> | { error: string };
  source?: number | null;
  workspace?: string | null;
  full?: boolean;
  trigger?: string;
  pageSize?: number; // 1 to 1000
  maxPages?: number;
}

export async function runSync(a: SyncArgs) {
  const pageSize = Math.min(1000, Math.max(1, Math.floor(Number(a.pageSize) || 200)));
  const maxPages = a.maxPages ?? 200;
  let sourceId = a.source ?? null;
  if (!sourceId) {
    let r: any;
    try { r = await a.db.rpc('source_sync_resolve', { p_slug: a.workspace ?? null }); } catch (e) {
      return { status: 'error', error: `could not find the source in Summit: ${String((e as any)?.message || e)}` };
    }
    if (!r || r.error) return { status: 'refused', error: r?.error || 'source_sync_resolve returned nothing' };
    sourceId = r.source_id;
  }
  let begin: any;
  try {
    begin = await a.db.rpc('source_sync_begin', { p_source: sourceId, p_trigger: a.trigger || 'manual', p_full: !!a.full });
  } catch (e) {
    return { status: 'error', error: `could not start a run in Summit: ${String((e as any)?.message || e)}` };
  }
  if (!begin || begin.error) return { status: 'refused', error: begin?.error || 'source_sync_begin returned nothing' };

  const finish = async (status: string, res: Partial<ConnectorResult>) => {
    const allErrors = [...(res.pageErrors || []), ...(res.errors || [])];
    try {
      const run = await a.db.rpc('source_sync_finish', {
        p_run: begin.run_id, p_status: status, p_calls: res.calls || 0, p_errors: allErrors, p_notes: res.notes || [], p_complete: status === 'ok',
      });
      return { status, seconds: res.seconds, run };
    } catch (e) {
      // the run stays "running" in the log; the next run closes it out after 15 minutes
      return { status: 'error', seconds: res.seconds, run_id: begin.run_id, errors: [...allErrors, `could not log the end of the run: ${String((e as any)?.message || e)}`] };
    }
  };

  const connector = a.connectors[begin.connector];
  if (!connector) return finish('error', { errors: [`no connector called ${begin.connector} is built`] });
  const creds = a.credentials(begin.credential_ref ?? null);
  if ('error' in creds) return finish('error', { errors: [String(creds.error)] });

  const writes: string[] = [];
  const pageErrors: string[] = [];
  let pageNo = 0;
  const write = async (records: any[], label?: string) => {
    pageNo++;
    const t0 = Date.now();
    try {
      await a.db.rpc('source_sync_upsert', { p_run: begin.run_id, p_rows: records });
      writes.push(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      pageErrors.push(`page ${pageNo} (${label ? `${label}, ` : ''}${records.length} rows) was not saved: ${String((e as any)?.message || e)}`);
      writes.push('failed');
    }
  };
  let res: ConnectorResult;
  try {
    res = await connector({ begin, credentials: creds, write, pageSize, maxPages });
  } catch (e) {
    res = { complete: false, errors: [String((e as any)?.message || e)], pageErrors: [], notes: [], calls: 0 };
  }
  res.pageErrors = [...pageErrors, ...(res.pageErrors || [])];
  if (writes.length) res.notes.push(`time to save each page: ${writes.join(', ')}`);
  // a failed page means rows are missing: partial, so the cutoff stays put and nothing is marked removed
  const status = res.errors.length ? 'error' : res.complete && !res.pageErrors.length ? 'ok' : 'partial';
  return finish(status, res);
}

// ---------------------------------------------------------------------------------------------------
// The Aspire connector. GET only. Pages Opportunities by OpportunityID.
export function aspireConnector(opts: Omit<AspireOptions, 'clientId' | 'secret'> = {}): Connector {
  return async ({ begin, credentials, write, pageSize, maxPages }) => {
    const aspire = aspireClient({ ...opts, clientId: credentials.CLIENT_ID, secret: credentials.CLIENT_SECRET, base: opts.base || credentials.BASE_URL || undefined });
    const errors: string[] = [];
    const notes: string[] = [];
    let complete = false;
    try {
      const since = begin.mode === 'incremental' && begin.since ? `${begin.since}Z` : null;
      if (since) notes.push(`incremental: ModifiedDate ge ${since}`);
      else notes.push('full pull');
      notes.push(`pages of ${pageSize}`);
      let last: number | null = null;
      let largest = 0;
      for (let page = 1; page <= maxPages; page++) {
        const filter = [since && `ModifiedDate ge ${since}`, last !== null && `OpportunityID gt ${last}`].filter(Boolean).join(' and ');
        const q: Record<string, string> = { $top: String(pageSize), $orderby: 'OpportunityID asc' };
        if (filter) q.$filter = filter;
        const r = await aspire.get(`/Opportunities?${toQuery(q)}`);
        if (r.skipped) { notes.push(`stopped at page ${page} to stay inside the time budget. The next run picks up the rest`); break; }
        const recs = recordsOf(r.json);
        if (r.status !== 200 || !recs) { errors.push(`page ${page}: Aspire returned ${r.status}${r.error ? ` (${r.error})` : ''}`); break; }
        if (!recs.length) { complete = true; break; }
        const ids = recs.map((x) => Number(x?.OpportunityID));
        if (ids.some((n) => !Number.isFinite(n))) { errors.push(`page ${page}: a record has no OpportunityID`); break; }
        if (ids.some((n, i) => (i ? n <= ids[i - 1] : last !== null && n <= last))) {
          errors.push(`page ${page}: Aspire ignored the OpportunityID order or the gt filter. Stopped so nothing is counted twice`);
          break;
        }
        await write(recs, `OpportunityID ${ids[0]} to ${ids[ids.length - 1]}`);
        last = ids[ids.length - 1];
        largest = Math.max(largest, recs.length);
        if (page > 1 && recs.length < largest) { complete = true; break; } // a short page after a full one is the last
        if (page === maxPages) notes.push(`stopped at the ${maxPages}-page safety cap`);
      }
    } catch (e) {
      errors.push(String((e as any)?.message || e));
    }
    const st = aspire.stats();
    if (st.throttled) notes.push(`throttled ${st.throttled} time(s), backed off and retried`);
    if (st.relogins) notes.push('the Aspire token expired mid-run, logged in again');
    return { complete, errors, pageErrors: [], notes, calls: st.calls, seconds: st.seconds };
  };
}

// credentials by reference: env:ASPIRE reads ASPIRE_CLIENT_ID, ASPIRE_CLIENT_SECRET and ASPIRE_BASE_URL from the function's
// secrets, returned without the prefix. Nothing else is supported yet, and nothing is ever read from the deal_sources row itself.
export function envCredentials(env: (k: string) => string | undefined) {
  return (ref: string | null): Record<string, string> | { error: string } => {
    const m = /^env:([A-Z][A-Z0-9_]*)$/.exec(ref || '');
    if (!m) return { error: `credential reference ${ref || '(none)'} is not supported. Use env:<PREFIX>` };
    const out: Record<string, string> = {};
    for (const k of ['CLIENT_ID', 'CLIENT_SECRET', 'BASE_URL', 'API_KEY']) { const v = env(`${m[1]}_${k}`); if (v) out[k] = v; }
    if (!Object.keys(out).length) return { error: `no secrets named ${m[1]}_* are set on the function` };
    return out;
  };
}
