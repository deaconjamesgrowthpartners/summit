// Aspire discovery probe, pass 3: reconcile Aspire against what Summit holds. Reads only, writes nothing.
//
// Question one, ownership coverage: every opportunity that is not Won or Lost, plus everything Won in
// the last 180 days, grouped by rep and by status, with the rows themselves.
// Question two, activity coverage: activities created in the last 90 days, counted per person per
// calendar week, so it is clear whether logging is a habit or occasional.
//
// Paging is the hard part. Aspire caps page size and ignores $skip in places, so every pull pages by
// key (ID gt the last ID seen, ordered by ID) and falls back to $skip only when the key trick fails.
// Every row is checked again here, so a filter Aspire accepts but ignores cannot inflate a count.
// The paging report says exactly what happened.

import { openAspire, records, qs, type ProbeOptions } from './client.ts';

export const OPP_FIELDS = [
  'OpportunityID', 'OpportunityNumber', 'OpportunityName', 'PropertyName', 'SalesRepContactName', 'BranchName',
  'DivisionName', 'OpportunityStatusName', 'EstimatedDollars', 'WonDollars', 'StartDate', 'AnticipatedCloseDate',
  'WonDate', 'ModifiedDate',
];
export const WON_DAYS = 180;
export const ACTIVITY_DAYS = 90;
const MAX_PAGES = 100;

type Get = (p: string) => Promise<any>;
const lit = (v: unknown) => (typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const day10 = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const money = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
const filled = (v: unknown) => v !== null && v !== undefined && v !== '' && v !== 0;
const cmp = (a: any, b: any) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
const ascending = (rows: any[], k: string) => rows.every((r, i) => i === 0 || cmp(rows[i - 1][k], r[k]) < 0);
const findKey = (keys: string[], ...tests: RegExp[]) => { for (const t of tests) { const k = keys.find((x) => t.test(x)); if (k) return k; } return null; };

// Monday-start calendar week of a YYYY-MM-DD date
export function weekOf(d: string) {
  const t = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  const dow = new Date(t).getUTCDay();
  return new Date(t - ((dow + 6) % 7) * 86400000).toISOString().slice(0, 10);
}
export function weeksBetween(from: string, to: string) {
  const out: string[] = [];
  for (let w = weekOf(from); w <= weekOf(to); w = new Date(Date.parse(w + 'T00:00:00Z') + 7 * 86400000).toISOString().slice(0, 10)) out.push(w);
  return out;
}

interface Pull {
  path: string;
  idKey: string;
  filters: (string | null)[]; // tried in order; null means no filter, rows checked here instead
  select?: string[];
  keep: (row: any) => boolean;
  startTop?: number;
}

// Pulls every row a filter matches, whatever Aspire's paging does, and says what it did.
export async function pullAll(get: Get, spec: Pull) {
  const p: any = { filter_used: undefined, filters_refused: [], requested_top: spec.startTop ?? 1000, pages: 0, notes: [] };
  const seen = new Map<string, any>();
  let dupes = 0;
  let settings: { f: string | null; sel: boolean; ord: boolean; top: number } | null = null;
  let batch: any[] = [];

  const build = (s: typeof settings, extra: { after?: unknown; skip?: number } = {}) => {
    const q: Record<string, string> = { $top: String(s!.top) };
    const key = extra.after !== undefined ? `${spec.idKey} gt ${lit(extra.after)}` : null;
    const f = s!.f && key ? `(${s!.f}) and ${key}` : s!.f || key;
    if (f) q.$filter = f;
    if (s!.sel && spec.select?.length) q.$select = spec.select.join(',');
    if (s!.ord) q.$orderby = `${spec.idKey} asc`;
    if (extra.skip) q.$skip = String(extra.skip);
    return `${spec.path}?${qs(q)}`;
  };
  const take = (rows: any[]) => {
    let fresh = 0;
    for (const r of rows) { const id = String(r[spec.idKey]); if (seen.has(id)) dupes++; else { seen.set(id, r); fresh++; } }
    return fresh;
  };

  // 1. first page: find a filter Aspire accepts, then the richest query shape it accepts
  const top = p.requested_top;
  outer: for (const f of spec.filters) {
    const ladder = [
      { f, sel: !!spec.select?.length, ord: true, top },
      { f, sel: false, ord: true, top },
      { f, sel: false, ord: true, top: 100 },
      { f, sel: false, ord: false, top: 100 },
    ].filter((v, i, a) => a.findIndex((x) => x.sel === v.sel && x.ord === v.ord && x.top === v.top) === i);
    for (const s of ladder) {
      const r = await get(build(s));
      if (r.skipped) { p.stopped = 'the call or time budget ran out before the first page'; break outer; }
      const recs = records(r.json);
      if (r.status === 200 && recs) { settings = s; batch = recs; if (r.json?.['@odata.nextLink']) p.next_link_offered = true; break outer; }
      if (r.status !== 400 && r.status < 500) { p.stopped = `first page returned ${r.status}`; break outer; }
    }
    p.filters_refused.push(f ?? '(no filter)');
  }
  if (!settings) { p.stopped ??= 'every filter and query shape was refused'; return { rows: [], paging: p }; }
  p.filter_used = settings.f ?? 'none. Aspire refused every filter, so rows were checked here instead';
  p.select_used = settings.sel;
  p.ordered_by_id = settings.ord;
  if (settings.top !== top) p.notes.push(`Aspire refused $top=${top}, so pages ask for ${settings.top}`);
  p.pages = 1;
  take(batch);
  let largest = batch.length;

  // what Aspire says the total is, to check the pull against
  {
    const q: Record<string, string> = { $top: '1', $count: 'true' };
    if (settings.f) q.$filter = settings.f;
    const r = await get(`${spec.path}?${qs(q)}`);
    const n = Number(r.json?.['@odata.count'] ?? r.json?.Count ?? r.json?.count);
    p.aspire_count = r.status === 200 && Number.isFinite(n) && r.json && ('@odata.count' in r.json || 'Count' in r.json || 'count' in r.json) ? n : null;
  }

  // 2. the rest: by key when the order held, by $skip when it did not
  let mode: 'key' | 'skip' = settings.ord && ascending(batch, spec.idKey) ? 'key' : 'skip';
  if (settings.ord && mode === 'skip') p.notes.push('$orderby was accepted but the first page was not in ID order, so paging by key is unsafe');
  p.method = mode === 'key' ? `by key: ${spec.idKey} gt <last ID>, ordered by ${spec.idKey}` : '$skip';
  while (p.pages < MAX_PAGES && batch.length && !(p.pages > 1 && batch.length < largest)) {
    if (p.aspire_count != null && seen.size >= p.aspire_count) break; // Aspire's own total is reached
    let r: any;
    if (mode === 'key') {
      const last = batch[batch.length - 1][spec.idKey];
      r = await get(build(settings, { after: last }));
      const recs = records(r.json);
      if (r.skipped) { p.stopped = 'the call or time budget ran out mid-pull. The rows above are real but incomplete'; break; }
      if (r.status !== 200 || !recs) { p.notes.push(`paging by key was refused (${r.status}), switched to $skip`); mode = 'skip'; p.method = `by key, then $skip after page ${p.pages}`; continue; }
      if (recs.length && (!ascending(recs, spec.idKey) || cmp(recs[0][spec.idKey], last) <= 0)) {
        p.notes.push(`Aspire ignored "${spec.idKey} gt" on page ${p.pages + 1}, switched to $skip`);
        mode = 'skip'; p.method = `by key, then $skip after page ${p.pages}`; continue;
      }
      batch = recs;
    } else {
      r = await get(build(settings, { skip: seen.size }));
      const recs = records(r.json);
      if (r.skipped) { p.stopped = 'the call or time budget ran out mid-pull. The rows above are real but incomplete'; break; }
      if (r.status !== 200 || !recs) { p.stopped = `page ${p.pages + 1} returned ${r.status}`; break; }
      batch = recs;
      if (batch.length && batch.every((x) => seen.has(String(x[spec.idKey])))) {
        p.stopped = `Aspire ignored $skip and sent rows it had already sent. Only ${seen.size} rows could be read this way`;
        p.skip_ignored = true;
        break;
      }
    }
    p.pages++;
    take(batch);
    largest = Math.max(largest, batch.length);
  }
  if (p.pages >= MAX_PAGES) p.stopped ??= `stopped at the ${MAX_PAGES}-page safety cap`;
  if (largest < settings.top && p.pages > 1) p.page_size_cap = largest;
  p.duplicates_dropped = dupes;
  p.rows_pulled = seen.size;
  const all = [...seen.values()];
  const rows = all.filter(spec.keep);
  p.rows_kept = rows.length;
  p.rows_failed_check = all.length - rows.length;
  if (p.rows_failed_check && settings.f) p.notes.push(`${p.rows_failed_check} rows did not match the filter, so Aspire did not fully apply it. They were dropped here`);
  if (p.aspire_count != null) p.matches_aspire_count = seen.size === p.aspire_count;
  if (!p.notes.length) delete p.notes;
  return { rows, paging: p };
}

// ---------- question one ----------
async function ownership(get: Get, now: Date) {
  const out: any = {};
  const first = await get(`/Opportunities?${qs({ $top: '1' })}`);
  const sample = (records(first.json) || [])[0];
  if (!sample) { out.stopped = `could not read an opportunity (${first.status})`; return out; }
  const keys = Object.keys(sample);
  out.missing_fields = OPP_FIELDS.filter((f) => !keys.includes(f));
  const idKey = keys.includes('OpportunityID') ? 'OpportunityID' : findKey(keys, /^opportunityid$/i, /id$/i) || keys[0];
  const statusKey = keys.includes('OpportunityStatusName') ? 'OpportunityStatusName' : findKey(keys, /status.*name/i, /status/i);
  const wonKey = keys.includes('WonDate') ? 'WonDate' : findKey(keys, /^won.?date$/i);
  const lostKey = findKey(keys, /^lost.?date$/i);
  const cutoff = new Date(now.getTime() - WON_DAYS * 86400000).toISOString().slice(0, 10);
  out.won_since = cutoff;

  const status = (r: any) => String(r[statusKey!] ?? '').trim();
  const isWon = (r: any) => /^won$/i.test(status(r));
  const isLost = (r: any) => /^lost$/i.test(status(r));
  const select = [...new Set([idKey, statusKey, wonKey, lostKey, ...OPP_FIELDS.filter((f) => keys.includes(f))].filter(Boolean))] as string[];
  const wonRecently = (r: any) => !!wonKey && (day10(r[wonKey]) ?? '') >= cutoff;
  const isOpen = (r: any) => (statusKey ? !isWon(r) && !isLost(r) : !r[wonKey!] && !(lostKey && r[lostKey])) && !wonRecently(r);

  const openFilters: (string | null)[] = [];
  if (statusKey) openFilters.push(`${statusKey} ne 'Won' and ${statusKey} ne 'Lost'`);
  if (wonKey && lostKey) openFilters.push(`${wonKey} eq null and ${lostKey} eq null`);
  openFilters.push(null);
  const open = await pullAll(get, { path: '/Opportunities', idKey, filters: openFilters, select, keep: isOpen });

  let won = { rows: [] as any[], paging: { stopped: 'no won date field on opportunities' } as any };
  if (wonKey) {
    won = await pullAll(get, {
      path: '/Opportunities', idKey, select, keep: wonRecently,
      filters: [`${wonKey} ge ${cutoff}T00:00:00Z`, `${wonKey} ge ${cutoff}T00:00:00`, null],
    });
  }
  out.paging = { open: open.paging, won_last_180_days: won.paging };

  const byId = new Map<string, any>();
  for (const r of open.rows) byId.set(String(r[idKey]), { ...r, bucket: 'open' });
  for (const r of won.rows) byId.set(String(r[idKey]), { ...r, bucket: 'won_180' });
  const rows = [...byId.values()].map((r) => ({ ...Object.fromEntries(OPP_FIELDS.map((f) => [f, r[f] ?? null])), bucket: r.bucket }));

  const repKey = 'SalesRepContactName';
  const reps = new Map<string, any>();
  const statuses = new Map<string, any>();
  for (const r of rows) {
    const rep = r[repKey] ? String(r[repKey]) : '(no rep)';
    const g = reps.get(rep) || { rep, total_count: 0, open_count: 0, open_estimated: 0, won_count: 0, won_dollars: 0 };
    g.total_count++;
    if (r.bucket === 'open') { g.open_count++; g.open_estimated += money(r.EstimatedDollars); }
    else { g.won_count++; g.won_dollars += money(r.WonDollars); }
    reps.set(rep, g);
    const st = r.OpportunityStatusName ? String(r.OpportunityStatusName) : '(blank)';
    const s = statuses.get(st) || { status: st, count: 0, estimated: 0, won_dollars: 0 };
    s.count++; s.estimated += money(r.EstimatedDollars); s.won_dollars += money(r.WonDollars);
    statuses.set(st, s);
  }
  const fix = (o: any) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? round2(v) : v]));
  out.totals = fix({
    opportunities: rows.length,
    open: rows.filter((r) => r.bucket === 'open').length,
    open_estimated: rows.filter((r) => r.bucket === 'open').reduce((a, r) => a + money(r.EstimatedDollars), 0),
    won_last_180_days: rows.filter((r) => r.bucket === 'won_180').length,
    won_dollars: rows.filter((r) => r.bucket === 'won_180').reduce((a, r) => a + money(r.WonDollars), 0),
    no_rep: rows.filter((r) => !r[repKey]).length,
  });
  out.by_rep = [...reps.values()].map(fix).sort((a: any, b: any) => b.total_count - a.total_count);
  out.by_status = [...statuses.values()].map(fix).sort((a: any, b: any) => b.count - a.count);
  out.rows = rows;
  return out;
}

// ---------- question two ----------
async function activity(get: Get, now: Date) {
  const out: any = { tried: [] };
  let path: string | null = null;
  let sample: any = null;
  for (const p of ['/Activities', '/Activity']) {
    const r = await get(`${p}?${qs({ $top: '1' })}`);
    out.tried.push({ path: p, status: r.status });
    const recs = records(r.json);
    if (r.status === 200 && recs) { path = p; sample = recs[0]; break; }
    if (r.skipped) break;
  }
  if (!path || !sample) { out.stopped = path ? 'the activities endpoint returned no records' : 'no activities endpoint answered'; return out; }
  out.path = path;
  const keys = Object.keys(sample);
  const idKey = findKey(keys, /^activityid$/i, /^id$/i, /id$/i) || keys[0];
  const who = findKey(keys, /^createdbyusername$/i, /created.?by.*name/i, /created.?by/i);
  const when = findKey(keys, /^createddate$/i, /^created.?(date|on|datetime|time)$/i, /created.*date/i);
  const cat = findKey(keys, /^activitycategoryname$/i, /category.*name/i, /category/i);
  const kind = findKey(keys, /^activitytypename$/i, /activity.?type.*name/i, /^activitytype$/i);
  const prop = findKey(keys, /^propertyid$/i);
  const opp = findKey(keys, /^opportunityid$/i);
  out.fields = { id: idKey, person: who, date: when, category: cat, type: kind, property: prop, opportunity: opp };
  if (!when) { out.stopped = 'no created date field on activities, so there is nothing to count by week'; out.sample_fields = keys; return out; }

  const since = new Date(now.getTime() - ACTIVITY_DAYS * 86400000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  out.since = since;
  const pulled = await pullAll(get, {
    path, idKey, keep: (r) => (day10(r[when]) ?? '') >= since,
    filters: [`${when} ge ${since}T00:00:00Z`, `${when} ge ${since}T00:00:00`, null],
  });
  out.paging = pulled.paging;
  const rows = pulled.rows;
  out.activities = rows.length;

  // per person per calendar week (Monday start). The first and current weeks are partial.
  const weeks = weeksBetween(since, today);
  out.weeks_in_window = weeks.length;
  out.week_note = `Weeks start Monday, by ${when}. The first week (${weeks[0]}) and the current week (${weeks[weeks.length - 1]}) are partial.`;
  const people = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const p = who && r[who] ? String(r[who]) : '(blank)';
    const w = weekOf(day10(r[when])!);
    const m = people.get(p) || Object.fromEntries(weeks.map((x) => [x, 0]));
    m[w] = (m[w] || 0) + 1;
    people.set(p, m);
  }
  out.habit_rule = 'habit: at least one in 75% or more of the weeks. patchy: 50 to 74%. occasional: under 50%.';
  out.by_person = [...people.entries()].map(([person, per]) => {
    const active = Object.values(per).filter((n) => n > 0).length;
    const share = active / weeks.length;
    return {
      person, total: Object.values(per).reduce((a, b) => a + b, 0), weeks_active: active, weeks_in_window: weeks.length,
      share: Math.round(share * 100) / 100, pattern: share >= 0.75 ? 'habit' : share >= 0.5 ? 'patchy' : 'occasional', per_week: per,
    };
  }).sort((a, b) => b.weeks_active - a.weeks_active || b.total - a.total);

  // category filled or blank
  if (cat) {
    const t: Record<string, number> = {};
    for (const r of rows) if (filled(r[cat])) t[String(r[cat])] = (t[String(r[cat])] || 0) + 1;
    const n = Object.values(t).reduce((a, b) => a + b, 0);
    out.category = { field: cat, filled: n, blank: rows.length - n, values: Object.fromEntries(Object.entries(t).sort((a, b) => b[1] - a[1])) };
  } else out.category = { field: null, note: 'no category field on activities' };
  if (kind) {
    const t: Record<string, number> = {};
    for (const r of rows) { const v = filled(r[kind]) ? String(r[kind]) : '(blank)'; t[v] = (t[v] || 0) + 1; }
    out.type = { field: kind, values: Object.fromEntries(Object.entries(t).sort((a, b) => b[1] - a[1])) };
  }

  // linked to a property or an opportunity, or floating
  const L: any = { property_field: prop, opportunity_field: opp, property_only: 0, opportunity_only: 0, both: 0, floating: 0 };
  const otherLinks = keys.filter((k) => /id$/i.test(k) && ![idKey, prop, opp].includes(k) && !/created|modified|updated|user|owner|assigned|category|type|status|priority/i.test(k));
  const floatOther: Record<string, number> = {};
  let floatBare = 0;
  for (const r of rows) {
    const hp = !!prop && filled(r[prop]);
    const ho = !!opp && filled(r[opp]);
    if (hp && ho) L.both++; else if (hp) L.property_only++; else if (ho) L.opportunity_only++;
    else {
      L.floating++;
      const hits = otherLinks.filter((k) => filled(r[k]));
      for (const k of hits) floatOther[k] = (floatOther[k] || 0) + 1;
      if (!hits.length) floatBare++;
    }
  }
  L.floating_but_linked_to = floatOther;
  L.floating_with_no_link_at_all = floatBare;
  if (!prop || !opp) L.note = `not on the record: ${[!prop && 'PropertyID', !opp && 'OpportunityID'].filter(Boolean).join(', ')}`;
  out.links = L;
  return out;
}

export type Pass3Part = 'ownership' | 'activity' | 'both';

export async function probe3(opts: ProbeOptions & { part?: Pass3Part }) {
  const c = await openAspire({ maxCalls: 300, ...opts });
  const { now, auth, get, log } = c;
  const part = opts.part || 'both';
  const notes: string[] = [];
  let own: any = null;
  let act: any = null;
  if (!c.authed) notes.push('No auth handshake worked. Nothing past this point ran.');
  else {
    if (part !== 'activity') own = await ownership(get, now);
    if (part !== 'ownership') act = await activity(get, now);
  }

  const summary: string[] = [];
  summary.push(auth.worked ? `Auth: ${auth.worked.endpoint}, sent as ${auth.worked.header}.` : 'Auth: nothing worked. See auth.attempts.');
  const pageLine = (label: string, p: any) => p && summary.push(
    `  ${label}: ${p.rows_kept ?? 0} rows, ${p.pages} page(s), ${p.method || 'no paging'}${p.page_size_cap ? `, Aspire caps pages at ${p.page_size_cap}` : ''}` +
    `${p.aspire_count != null ? `, Aspire count ${p.aspire_count}${p.matches_aspire_count ? ' (matches)' : ' (DOES NOT match)'}` : ''}` +
    `${p.duplicates_dropped ? `, ${p.duplicates_dropped} duplicates dropped` : ''}${p.rows_failed_check ? `, ${p.rows_failed_check} failed the check` : ''}` +
    `. Filter: ${p.filter_used ?? 'none worked'}.${p.stopped ? ` Stopped: ${p.stopped}.` : ''}`);
  if (own) {
    if (own.stopped) summary.push(`Ownership: ${own.stopped}.`);
    else {
      const t = own.totals;
      summary.push(`Ownership: ${t.opportunities} opportunities. ${t.open} open (${usd(t.open_estimated)} estimated), ${t.won_last_180_days} won since ${own.won_since} (${usd(t.won_dollars)} won). ${t.no_rep} have no rep.`);
      pageLine('open', own.paging.open);
      pageLine('won', own.paging.won_last_180_days);
      summary.push(`  by rep: ${own.by_rep.map((r: any) => `${r.rep} ${r.open_count} open ${usd(r.open_estimated)} / ${r.won_count} won ${usd(r.won_dollars)}`).join('; ')}.`);
      summary.push(`  by status: ${own.by_status.map((s: any) => `${s.status} ${s.count}`).join(', ')}.`);
      if (own.missing_fields.length) summary.push(`  not on the record: ${own.missing_fields.join(', ')}.`);
    }
  }
  if (act) {
    if (act.stopped) summary.push(`Activity: ${act.stopped}.`);
    else {
      summary.push(`Activity: ${act.activities} created since ${act.since} at ${act.path}, over ${act.weeks_in_window} weeks.`);
      pageLine('activities', act.paging);
      summary.push(`  by person (weeks with at least one): ${act.by_person.map((p: any) => `${p.person} ${p.weeks_active}/${p.weeks_in_window} ${p.pattern} (${p.total})`).join('; ')}.`);
      if (act.category.field) summary.push(`  ${act.category.field}: ${act.category.filled} filled, ${act.category.blank} blank.`);
      const L = act.links;
      summary.push(`  links: ${L.property_only} property only, ${L.opportunity_only} opportunity only, ${L.both} both, ${L.floating} floating (${L.floating_with_no_link_at_all} with no link at all).`);
    }
  }
  c.tail(summary);
  return { pass: 3, part, ...c.footer(), summary, auth, ownership: own, activity: act, notes, log };
}

export function toCsv(rows: any[]) {
  const cols = [...OPP_FIELDS, 'bucket'];
  const cell = (v: unknown) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}
