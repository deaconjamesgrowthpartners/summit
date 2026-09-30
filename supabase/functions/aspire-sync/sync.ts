// The sync itself. Reads Opportunities from Aspire, writes them into Summit through three SQL
// functions (migration 007): aspire_sync_begin, aspire_sync_upsert, aspire_sync_finish.
// Those only write aspire_opps and aspire_sync_runs. opps, commits, goals and the book are never touched.
//
// Full pull on the first run, then ModifiedDate since the last good run. Pages by key:
// OpportunityID gt <last seen>, ordered by OpportunityID asc, $top=1000. $count does not work at
// Aspire, so a pull ends on an empty page or a short one. Each page is written as it arrives, so
// a run that runs out of time keeps what it got, is logged as partial, and does not move the
// watermark. The next run picks it up.

import { aspireClient, recordsOf, toQuery, type AspireOptions } from './aspire.ts';

export interface Db { rpc: (fn: string, args: Record<string, unknown>) => Promise<any> }

// Summit's side: PostgREST RPC with the service role key. Only these three functions are called.
export const SYNC_RPCS = ['aspire_sync_begin', 'aspire_sync_upsert', 'aspire_sync_finish'];
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

export interface SyncArgs {
  aspire: AspireOptions;
  db: Db;
  workspace?: string | null;
  full?: boolean;
  trigger?: string;
  pageSize?: number;
  maxPages?: number;
}

export async function runSync(a: SyncArgs) {
  const pageSize = a.pageSize ?? 1000;
  const maxPages = a.maxPages ?? 200;
  let begin: any;
  try {
    begin = await a.db.rpc('aspire_sync_begin', { p_slug: a.workspace ?? null, p_trigger: a.trigger || 'manual', p_full: !!a.full });
  } catch (e) {
    return { status: 'error', error: `could not start a run in Summit: ${String((e as any)?.message || e)}` };
  }
  if (!begin || begin.error) return { status: 'refused', error: begin?.error || 'aspire_sync_begin returned nothing' };

  const aspire = aspireClient(a.aspire);
  const errors: string[] = [];
  const notes: string[] = [];
  let complete = false;
  try {
    const since = begin.mode === 'incremental' && begin.since ? `${begin.since}Z` : null;
    if (since) notes.push(`incremental: ModifiedDate ge ${since}`);
    else notes.push('full pull');
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
      await a.db.rpc('aspire_sync_upsert', { p_run: begin.run_id, p_rows: recs });
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
  const status = errors.length ? 'error' : complete ? 'ok' : 'partial';
  try {
    const run = await a.db.rpc('aspire_sync_finish', {
      p_run: begin.run_id, p_status: status, p_calls: st.calls, p_errors: errors, p_notes: notes, p_complete: complete && !errors.length,
    });
    return { status, seconds: st.seconds, run };
  } catch (e) {
    // the run stays "running" in the log; the next run closes it out after 15 minutes
    return { status: 'error', seconds: st.seconds, run_id: begin.run_id, errors: [...errors, `could not log the end of the run: ${String((e as any)?.message || e)}`] };
  }
}
