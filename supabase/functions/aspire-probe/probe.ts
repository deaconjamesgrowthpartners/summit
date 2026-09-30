// Aspire discovery probe, pass 1: the core resources. Reads only.
// Reports the shape of the data, never copies it. Sample records are reported as
// field names and types, not values. Only the rep, branch and division fields
// show example values, because that is the question being asked.
// The network door, login, budgets and 429 handling live in client.ts.

import { openAspire, records, envelope, fieldsOf, typeOf, qs, type ProbeOptions } from './client.ts';

export const RESOURCES = [
  { name: 'Opportunities', paths: ['/Opportunities'] },
  { name: 'Properties', paths: ['/Properties'] },
  { name: 'Contracts', paths: ['/Contracts', '/ContractYears', '/Agreements'] },
  { name: 'Contacts', paths: ['/Contacts'] },
  { name: 'Invoices', paths: ['/Invoices'] },
  { name: 'Divisions', paths: ['/Divisions'] },
  // not asked for, but they answer question 4 and question 3
  { name: 'Branches', paths: ['/Branches'], extra: true },
  { name: 'OpportunityStatuses', paths: ['/OpportunityStatuses'], extra: true },
];

export async function probe(opts: ProbeOptions) {
  const c = await openAspire(opts);
  const { now, auth, get, log } = c;
  const notes: string[] = [];
  const resources: any = {};
  const samples: Record<string, any> = {};
  const open: any = { answer: 'unknown' };
  const ids: any = { rep: [], branch: [], division: [] };
  if (!c.authed) {
    notes.push('No auth handshake worked. Nothing past this point ran. Check the attempts list for the status each path returned.');
    return finish();
  }

  // ---------- 2. each resource ----------
  for (const res of RESOURCES) {
    const out: any = { exists: false, path: null, tried: [] };
    resources[res.name] = out;
    let sample: any = null;
    for (const p of res.paths) {
      const r = await get(`${p}?${qs({ $top: '1' })}`);
      out.tried.push({ path: p, status: r.status });
      if (r.status === 401 || r.status === 403) { out.exists = 'probably, but this credential is not allowed to read it'; out.path = p; break; }
      if (r.status >= 200 && r.status < 300) {
        const recs = records(r.json);
        out.exists = true; out.path = p; out.envelope = envelope(r.json);
        if (recs === null) { out.note = 'responded, but not with a list of records'; break; }
        sample = recs[0] || null;
        out.honours_top = recs.length <= 1;
        out.fields = fieldsOf(sample);
        break;
      }
    }
    if (out.exists !== true || !out.path) continue;
    samples[res.name] = sample;

    // record count: OData $count, then /$count, else unknown
    const c = await get(`${out.path}?${qs({ $top: '0', $count: 'true' })}`);
    const odataCount = c.json && (c.json['@odata.count'] ?? c.json['odata.count'] ?? c.json.Count ?? c.json.count);
    if (c.status === 200 && Number.isFinite(Number(odataCount))) { out.count = Number(odataCount); out.count_method = '$count=true'; }
    else {
      const c2 = await get(`${out.path}/$count`);
      const n = Number(String(c2.text || '').trim());
      if (c2.status === 200 && Number.isFinite(n) && String(c2.text).trim() !== '') { out.count = n; out.count_method = '/$count'; }
      else { out.count = null; out.count_method = 'none worked. Counting would mean paging the whole set, which this probe will not do.'; }
    }

    // modified-since: find a modified-looking date field, then prove the filter is applied, not ignored
    const mf = out.fields?.find((x: any) => /modif|updat|changed|lastedit|edited/i.test(x.name) && (x.type === 'date' || x.type === 'null'));
    if (!sample) out.modified_since = { supported: 'unknown', why: 'no records to inspect' };
    else if (!mf) out.modified_since = { supported: 'unknown', why: 'no field on the sample record looks like a modified date', candidates: out.fields.filter((x: any) => x.type === 'date').map((x: any) => x.name) };
    else {
      const future = '2100-01-01T00:00:00Z';
      const since = new Date(now.getTime() - 30 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const a = await get(`${out.path}?${qs({ $filter: `${mf.name} ge ${future}`, $top: '1' })}`);
      const ar = records(a.json);
      if (a.status !== 200 || ar === null) out.modified_since = { field: mf.name, supported: false, why: `$filter on ${mf.name} returned ${a.status}` };
      else if (ar.length > 0) out.modified_since = { field: mf.name, supported: false, why: `the filter was accepted but ignored: a year-2100 cutoff still returned records` };
      else {
        const b = await get(`${out.path}?${qs({ $filter: `${mf.name} ge ${since}`, $top: '0', $count: 'true' })}`);
        const n = b.json && Number(b.json['@odata.count']);
        out.modified_since = { field: mf.name, supported: true, syntax: `$filter=${mf.name} ge ${since}`, changed_last_30_days: Number.isFinite(n) ? n : 'not counted' };
      }
    }
  }

  // ---------- 3. open opportunities, or only sold work? ----------
  const opp = resources.Opportunities;
  if (opp?.exists === true && samples.Opportunities) {
    const keys = Object.keys(samples.Opportunities);
    const pickKey = (re: RegExp) => keys.find((k) => re.test(k)) || null;
    const statusKey = pickKey(/^(opportunity)?status(name)?$/i) || pickKey(/status.*name/i) || pickKey(/status/i);
    const wonKey = pickKey(/won.?date/i);
    const lostKey = pickKey(/lost.?date/i);
    const stageKey = pickKey(/stage/i);
    const typeKey = pickKey(/^(opportunity)?type(name)?$/i);
    open.fields = { status: statusKey, won_date: wonKey, lost_date: lostKey, stage: stageKey, type: typeKey };

    const sel = [statusKey, stageKey, typeKey, wonKey, lostKey, opp.modified_since?.field].filter(Boolean).join(',');
    const order = opp.modified_since?.field ? { $orderby: `${opp.modified_since.field} desc` } : {};
    let r = await get(`/Opportunities?${qs({ $top: '500', ...(sel ? { $select: sel } : {}), ...order })}`);
    if (r.status !== 200 || !records(r.json)) r = await get(`/Opportunities?${qs({ $top: '200' })}`);
    const recs = records(r.json) || [];
    const tally = (k: string | null) => { const t: Record<string, number> = {}; if (!k) return t; for (const x of recs) { const v = x[k] === null || x[k] === undefined ? '(blank)' : String(x[k]); t[v] = (t[v] || 0) + 1; } return t; };
    open.sampled = recs.length;
    open.by_status = tally(statusKey);
    if (stageKey) open.by_stage = tally(stageKey);
    if (typeKey) open.by_type = tally(typeKey);
    const closed = /won|sold|lost|closed|cancel|complete|declin|dead|void/i;
    const openByStatus = statusKey ? recs.filter((x) => x[statusKey] && !closed.test(String(x[statusKey]))).length : null;
    const openByDates = wonKey && lostKey ? recs.filter((x) => !x[wonKey] && !x[lostKey]).length : null;
    open.open_in_sample_by_status = openByStatus;
    open.open_in_sample_by_dates = openByDates;

    // exact total, if the dates filter works
    if (wonKey && lostKey) {
      const e = await get(`/Opportunities?${qs({ $filter: `${wonKey} eq null and ${lostKey} eq null`, $top: '0', $count: 'true' })}`);
      const n = e.json && Number(e.json['@odata.count']);
      if (e.status === 200 && Number.isFinite(n)) open.total_open_by_dates = n;
    }
    if (resources.OpportunityStatuses?.exists === true) {
      const s = await get(`/OpportunityStatuses?${qs({ $top: '100' })}`);
      const sr = records(s.json) || [];
      const nameKey = sr[0] && Object.keys(sr[0]).find((k) => /name/i.test(k));
      open.status_list = nameKey ? sr.map((x) => x[nameKey]) : sr.length ? 'returned, no name field' : [];
    }
    const openCount = Math.max(openByStatus ?? 0, openByDates ?? 0, open.total_open_by_dates ?? 0);
    open.answer = openCount > 0
      ? `yes. open opportunities are in there (${openCount} found by ${openByDates ? 'blank won and lost dates' : 'status'}${open.total_open_by_dates !== undefined ? `, ${open.total_open_by_dates} total by the dates filter` : ''})`
      : recs.length ? 'no open ones in the sample. Only sold or lost work came back. See by_status.' : 'no opportunities came back';
  }

  // ---------- 4. who is the rep, what is the branch ----------
  if (samples.Opportunities) {
    const keys = Object.keys(samples.Opportunities);
    const r = await get(`/Opportunities?${qs({ $top: '50' })}`);
    const recs = records(r.json) || [samples.Opportunities];
    const describe = (k: string) => {
      const vals = recs.map((x) => x[k]).filter((v) => v !== null && v !== undefined && v !== '');
      return { field: k, type: typeOf(recs.find((x) => x[k] != null)?.[k]), filled: `${vals.length} of ${recs.length}`, distinct: new Set(vals.map(String)).size, examples: [...new Set(vals.map(String))].slice(0, 3) };
    };
    ids.rep = keys.filter((k) => /sales.?rep|salesperson|sales.?person|estimator|account.?manager|owner|assigned|^rep|employee|user(id|name)?$/i.test(k)).map(describe);
    ids.branch = keys.filter((k) => /branch|office|region|location/i.test(k)).map(describe);
    ids.division = keys.filter((k) => /division/i.test(k)).map(describe);
    ids.other_person_fields = keys.filter((k) => /contact|manager/i.test(k) && !ids.rep.some((x: any) => x.field === k)).slice(0, 12);
  }
  for (const name of ['Divisions', 'Branches']) {
    const s = samples[name];
    if (!s) continue;
    const r = await get(`${resources[name].path}?${qs({ $top: '50' })}`);
    const recs = records(r.json) || [];
    const idKey = Object.keys(s).find((k) => /id$/i.test(k));
    const nameKey = Object.keys(s).find((k) => /name/i.test(k));
    ids[`${name.toLowerCase()}_list`] = recs.map((x) => ({ id: idKey ? x[idKey] : undefined, name: nameKey ? x[nameKey] : undefined }));
  }

  return finish();

  function finish() {
    const summary: string[] = [];
    if (auth.worked) summary.push(`Auth: ${auth.worked.endpoint} with ${auth.worked.body}. Token in "${auth.worked.token_field}", sent as ${auth.worked.header}.`);
    else summary.push('Auth: nothing worked. See auth.attempts.');
    for (const [n, r] of Object.entries<any>(resources || {})) {
      if (r.exists === true) summary.push(`${n}: ${r.path}, ${r.count ?? 'count unknown'} records, ${r.fields?.length ?? 0} fields, modified-since ${r.modified_since?.supported === true ? `yes (${r.modified_since.field})` : r.modified_since?.supported === false ? 'no' : 'unknown'}.`);
      else summary.push(`${n}: ${r.exists || 'not found'} (tried ${r.tried.map((t: any) => `${t.path} ${t.status}`).join(', ')}).`);
    }
    if (open.answer) summary.push(`Open opportunities: ${open.answer}.`);
    if (ids.rep?.length) summary.push(`Rep on an opportunity: ${ids.rep.map((x: any) => x.field).join(', ')}.`);
    if (ids.branch?.length || ids.division?.length) summary.push(`Branch or division: ${[...(ids.branch || []), ...(ids.division || [])].map((x: any) => x.field).join(', ')}.`);
    c.tail(summary);
    return { pass: 1, ...c.footer(), summary, auth, resources, open_opportunities: open, identifiers: ids, notes, log };
  }
}
