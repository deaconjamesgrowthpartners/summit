// Aspire discovery probe, pass 2: can the weekly measures come from Aspire?
// Site audits and client visits, plus who owns a deal. Reads only, writes nothing.
//
// Pass 1 answered the pipeline question (Aspire holds sold work), so this pass does
// not repeat those resources. It spends the call budget in priority order: deal
// ownership first, then site audits, then the activity-like endpoints. If the budget
// runs out, the least likely endpoints are the ones skipped, and the report says so.
//
// Values are shown only for the person fields (with counts, so it is clear whether
// real rep names appear) and for lookup tables such as activity types.

import { openAspire, records, fieldsOf, typeOf, qs, type ProbeOptions } from './client.ts';

// Aspire's names are inconsistent: each entry is tried in order, first hit wins.
// kind "lookup": a small list of types or categories. Its names are listed, nothing else.
export const PASS2_RESOURCES = [
  { name: 'SiteAudits', paths: ['/SiteAudits', '/SiteAudit', '/PropertyAudits', '/PropertyAudit', '/Audits'] },
  { name: 'Activities', paths: ['/Activities', '/Activity'] },
  { name: 'ContactActivities', paths: ['/ContactActivities', '/ContactActivity'] },
  { name: 'Meetings', paths: ['/Meetings', '/Meeting'] },
  { name: 'Events', paths: ['/Events', '/Event'] },
  { name: 'SiteAuditTypes', paths: ['/SiteAuditTypes', '/SiteAuditType', '/AuditTypes'], kind: 'lookup' },
  { name: 'ActivityTypes', paths: ['/ActivityTypes', '/ActivityType'], kind: 'lookup' },
  { name: 'ActivityCategories', paths: ['/ActivityCategories', '/ActivityCategory'], kind: 'lookup' },
  { name: 'Tasks', paths: ['/Tasks', '/Task'] },
  { name: 'Notes', paths: ['/Notes', '/Note'] },
  { name: 'PropertyContacts', paths: ['/PropertyContacts', '/PropertyContact'] },
  { name: 'Schedules', paths: ['/Schedules', '/Schedule'] },
  { name: 'WorkTickets', paths: ['/WorkTickets', '/WorkTicket'] },
];

// who created or performed it
const PERSON_RE = /((created|performed|completed|assigned|entered|owner|author|auditor|conducted|scheduled|updated|modified|last).*(by|user|contact|employee|name))|^(by|user|employee|salesrep|rep|auditor|owner)|(by|user|employee|rep|owner|auditor)(id|name)?$|(contact|employee|user).?name$/i;
// the business date, not bookkeeping: tried before created and modified dates
const WHEN_RE = /audit|activity|visit|meeting|event|start|scheduled|complete|due|performed|occur|^date$|date$/i;
const BOOKKEEPING_RE = /modif|updat|changed|created|edited|entered/i;
const MODIFIED_RE = /modif|updat|changed|lastedit|edited/i;

const quote = (v: unknown) => (typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
function tallyOf(rows: any[], k: string) {
  const t: Record<string, number> = {};
  for (const r of rows) { const v = r[k] === null || r[k] === undefined || r[k] === '' ? '(blank)' : String(r[k]); t[v] = (t[v] || 0) + 1; }
  return Object.fromEntries(Object.entries(t).sort((a, b) => b[1] - a[1]));
}
const isNameLike = (rows: any[], k: string) => rows.some((r) => typeof r[k] === 'string' && r[k] !== '' && !/^\d+$/.test(r[k]));

export async function probe2(opts: ProbeOptions) {
  const c = await openAspire(opts);
  const { now, auth, get, log } = c;
  const notes: string[] = [];
  const resources: any = {};
  const ownership: any = { answer: 'unknown' };
  if (!c.authed) {
    notes.push('No auth handshake worked. Nothing past this point ran. Check the attempts list for the status each path returned.');
    return finish();
  }

  // ---------- 1. deal ownership: 500 opportunities, distinct rep names with counts ----------
  {
    const first = await get(`/Opportunities?${qs({ $top: '1' })}`);
    const keys = Object.keys((records(first.json) || [])[0] || {});
    const repName = keys.find((k) => /^salesrepcontactname$/i.test(k)) || keys.find((k) => /sales.?rep.*name|salesperson|estimator.*name/i.test(k)) || null;
    const repId = keys.find((k) => /^salesrepcontactid$/i.test(k)) || keys.find((k) => /sales.?rep.*id/i.test(k)) || null;
    const status = keys.find((k) => /^(opportunity)?status(name)?$/i.test(k)) || keys.find((k) => /status.*name/i.test(k)) || null;
    const order = keys.find((k) => MODIFIED_RE.test(k)) || keys.find((k) => /won.?date/i.test(k)) || null;
    ownership.fields = { rep_name: repName, rep_id: repId, status, ordered_by: order ? `${order} desc` : 'unordered' };
    const select = [repName, repId, status].filter(Boolean).join(',');
    const rows: any[] = [];
    let pageCap: number | null = null;
    let selectOk = !!select;
    let top = 500;
    let firstKey = '';
    for (let page = 0; page < 6 && rows.length < 500; page++) {
      const want = Math.min(top, 500 - rows.length);
      const q: Record<string, string> = { $top: String(want) };
      if (rows.length) q.$skip = String(rows.length);
      if (selectOk) q.$select = select;
      if (order) q.$orderby = `${order} desc`;
      let r = await get(`/Opportunities?${qs(q)}`);
      if (r.status === 400 && selectOk) { selectOk = false; delete q.$select; r = await get(`/Opportunities?${qs(q)}`); }
      if (r.status === 400 && page === 0 && top > 100) { top = 100; q.$top = '100'; r = await get(`/Opportunities?${qs(q)}`); ownership.note = 'Aspire refused $top=500, so pages of 100'; }
      const batch = records(r.json);
      if (r.status !== 200 || !batch) { ownership.stopped = `page ${page + 1} returned ${r.status}`; break; }
      if (!batch.length) break;
      const key = JSON.stringify(batch[0]);
      if (page === 0) firstKey = key;
      else if (key === firstKey) { ownership.stopped = 'Aspire ignored $skip and sent the first page again, so only the first page is counted'; break; }
      rows.push(...batch);
      if (page === 0 && batch.length < want) pageCap = batch.length;
      if (batch.length < (pageCap ?? want)) break; // a short page is the last page
    }
    ownership.pulled = rows.length;
    if (pageCap && pageCap < 500) ownership.page_size_cap = pageCap;
    if (repName) {
      const t = tallyOf(rows, repName);
      ownership.distinct_rep_names = Object.keys(t).filter((k) => k !== '(blank)').length;
      ownership.rep_names_with_counts = t;
    }
    if (repId) ownership.distinct_rep_ids = Object.keys(tallyOf(rows, repId)).filter((k) => k !== '(blank)').length;
    if (status) ownership.by_status = tallyOf(rows, status);
    ownership.answer = !repName ? 'no sales rep field found on opportunities'
      : !rows.length ? 'no opportunities came back'
      : `${ownership.distinct_rep_names} distinct rep names across ${rows.length} opportunities. Check rep_names_with_counts against the roster.`;
  }

  // ---------- 2. each candidate resource ----------
  for (const res of PASS2_RESOURCES) {
    const out: any = { exists: false, path: null, tried: [] };
    resources[res.name] = out;
    let sample: any = null;
    for (const p of res.paths) {
      let r = await get(`${p}?${qs({ $top: '1' })}`);
      // some endpoints refuse OData options but answer a bare GET
      if (r.status === 400) { out.tried.push({ path: `${p}?$top=1`, status: 400 }); r = await get(p); }
      out.tried.push({ path: p, status: r.status });
      if (r.skipped) break;
      if (r.status === 401 || r.status === 403) { out.exists = 'probably, but this credential is not allowed to read it'; out.path = p; break; }
      if (r.status >= 200 && r.status < 300) {
        const recs = records(r.json);
        out.exists = true; out.path = p;
        if (recs === null) { out.note = 'responded, but not with a list of records'; break; }
        sample = recs[0] || null;
        out.fields = fieldsOf(sample);
        if (!sample) out.note = 'exists, but returned no records';
        break;
      }
    }
    if (out.exists !== true || !sample) continue;
    const keys = Object.keys(sample);

    if (res.kind === 'lookup') {
      const r = await get(`${out.path}?${qs({ $top: '100' })}`);
      const rows = records(r.json) || [sample];
      const nameKey = keys.find((k) => /name|description|title/i.test(k));
      const idKey = keys.find((k) => /id$/i.test(k));
      out.values = rows.map((x) => ({ id: idKey ? x[idKey] : undefined, name: nameKey ? x[nameKey] : undefined }));
      continue;
    }

    // the date field, and the range of the 50 most recent records
    const dates = out.fields.filter((x: any) => x.type === 'date').map((x: any) => x.name);
    const when = dates.find((k: string) => WHEN_RE.test(k) && !BOOKKEEPING_RE.test(k)) || dates.find((k: string) => /created/i.test(k)) || dates.find((k: string) => MODIFIED_RE.test(k)) || null;
    const modified = keys.find((k) => MODIFIED_RE.test(k)) || null;
    out.date_fields = dates;
    out.date_field = when;

    let recent: any[] = [];
    if (when) {
      let r = await get(`${out.path}?${qs({ $top: '50', $orderby: `${when} desc` })}`);
      out.recent_ordered = r.status === 200 && !!records(r.json);
      if (!out.recent_ordered) r = await get(`${out.path}?${qs({ $top: '50' })}`);
      recent = records(r.json) || [];
      const vals = recent.map((x) => x[when]).filter((v) => typeof v === 'string').sort();
      out.recent_50 = { returned: recent.length, ordered: out.recent_ordered ? `${when} desc` : 'no, the order would not apply', oldest: vals[0] || null, newest: vals[vals.length - 1] || null };
    } else {
      const r = await get(`${out.path}?${qs({ $top: '50' })}`);
      recent = records(r.json) || [];
      out.recent_50 = { returned: recent.length, note: 'no date field on the sample record' };
    }
    const rows = recent.length ? recent : [sample];

    // who created or performed it, with values and counts
    const people = keys.filter((k) => PERSON_RE.test(k) && !/date|time/i.test(k));
    out.person_fields = people.map((k) => ({ field: k, type: typeOf(rows.find((x) => x[k] != null)?.[k]), names: isNameLike(rows, k), values_in_recent: tallyOf(rows, k) }));

    // what kind of record each one is (e.g. a "Client Visit" activity type), counted in the recent 50
    const kinds = keys.filter((k) => /type|category|kind|reason|purpose/i.test(k) && isNameLike(rows, k));
    out.type_fields = kinds.map((k) => ({ field: k, values_in_recent: tallyOf(rows, k) }));

    // can it be filtered by date? a year-2100 cutoff has to come back empty
    const future = '2100-01-01T00:00:00Z';
    const dateTest = async (field: string) => {
      const r = await get(`${out.path}?${qs({ $filter: `${field} ge ${future}`, $top: '1' })}`);
      const got = records(r.json);
      if (r.status !== 200 || got === null) return { field, supported: false, why: `$filter on ${field} returned ${r.status}` };
      if (got.length > 0) return { field, supported: false, why: 'accepted but ignored: a year-2100 cutoff still returned records' };
      return { field, supported: true, syntax: `$filter=${field} ge <date>` };
    };
    out.date_filter = when ? await dateTest(when) : { supported: 'unknown', why: 'no date field' };
    if (modified && modified !== when) out.modified_filter = await dateTest(modified);
    else if (modified) out.modified_filter = out.date_filter;

    // can it be filtered by person? every row that comes back has to match
    const pf = out.person_fields.find((x: any) => x.names) || out.person_fields[0];
    const example = pf && Object.keys(pf.values_in_recent).find((v) => v !== '(blank)');
    if (!pf || !example) out.person_filter = { supported: 'unknown', why: 'no person field with a value to test' };
    else {
      const raw = rows.find((x) => String(x[pf.field]) === example)?.[pf.field];
      const r = await get(`${out.path}?${qs({ $filter: `${pf.field} eq ${quote(raw)}`, $top: '20' })}`);
      const got = records(r.json);
      if (r.status !== 200 || got === null) out.person_filter = { field: pf.field, supported: false, why: `$filter on ${pf.field} returned ${r.status}` };
      else if (!got.length) out.person_filter = { field: pf.field, supported: 'unclear', why: 'filter accepted but returned nothing for a value seen in the data' };
      else if (got.some((x) => String(x[pf.field]) !== example)) out.person_filter = { field: pf.field, supported: false, why: 'accepted but ignored: rows for other people came back' };
      else out.person_filter = { field: pf.field, supported: true, syntax: `$filter=${pf.field} eq ${typeof raw === 'number' ? '<id>' : "'<name>'"}` };
    }
  }

  return finish();

  function finish() {
    const summary: string[] = [];
    if (!auth.worked) summary.push('Auth: nothing worked. See auth.attempts.');
    else summary.push(`Auth: ${auth.worked.endpoint}, sent as ${auth.worked.header}.`);
    if (ownership.answer) summary.push(`Deal ownership: ${ownership.answer}${ownership.page_size_cap ? ` Aspire pages at ${ownership.page_size_cap}.` : ''}`);
    for (const [n, r] of Object.entries<any>(resources)) {
      if (r.exists !== true) { summary.push(`${n}: ${r.exists || 'not found'} (tried ${r.tried.map((t: any) => `${t.path} ${t.status}`).join(', ')}).`); continue; }
      if (r.values) { summary.push(`${n}: ${r.path}, ${r.values.length} values: ${r.values.slice(0, 12).map((v: any) => v.name).join(', ')}.`); continue; }
      if (!r.fields?.length) { summary.push(`${n}: ${r.path}, ${r.note || 'no records'}.`); continue; }
      const who = (r.person_fields || []).filter((x: any) => x.names).map((x: any) => `${x.field} (${Object.keys(x.values_in_recent).filter((v) => v !== '(blank)').length} names)`).join(', ') || 'no name field';
      const range = r.recent_50?.newest ? `${String(r.recent_50.oldest).slice(0, 10)} to ${String(r.recent_50.newest).slice(0, 10)}` : 'no range';
      const yn = (x: any) => (x?.supported === true ? 'yes' : x?.supported === false ? 'no' : 'unclear');
      const kinds = (r.type_fields || []).map((x: any) => `${x.field}: ${Object.entries(x.values_in_recent).slice(0, 6).map(([v, c]) => `${v} ${c}`).join(', ')}`).join('; ');
      summary.push(`${n}: ${r.path}, ${r.fields.length} fields. Date ${r.date_field || 'none'} (recent 50: ${range}), date filter ${yn(r.date_filter)}${r.modified_filter && r.modified_filter !== r.date_filter ? `, modified filter ${yn(r.modified_filter)}` : ''}. Person ${who}, person filter ${yn(r.person_filter)}.${kinds ? ` Kinds in recent 50: ${kinds}.` : ''}`);
    }
    c.tail(summary);
    return { pass: 2, ...c.footer(), summary, auth, deal_ownership: ownership, resources, notes, log };
  }
}
