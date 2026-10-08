// Reading a CSV file in the browser, and guessing which column is which. Nothing here talks to the database.

// rows of cells. Quotes, commas and line breaks inside quotes, CRLF, a byte order mark. Tabs when the
// first line has tabs and no commas (a paste from a spreadsheet).
export function parseCsv(text) {
  const t = String(text || '').replace(/^﻿/, '');
  const first = t.slice(0, t.search(/\r?\n|$/));
  const sep = first.includes('\t') && !first.includes(',') ? '\t' : ',';
  const out = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) out.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) out.push(row);
  return out;
}

// the header row and every row after it as { header: cell }. Blank or repeated headers get a number.
export function csvRecords(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { headers: [], records: [] };
  const seen = {};
  const headers = rows[0].map((h, i) => {
    let k = h.trim() || `Column ${i + 1}`;
    if (seen[k]) k = `${k} (${++seen[k]})`; else seen[k] = 1;
    return k;
  });
  const records = rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
  return { headers, records };
}

// the fields a file can fill, in the order the mapping screen shows them
export const CSV_FIELDS = [
  ['external_id', 'Deal ID', /^(deal|opp(ortunity)?|record|crm)?[\s_#-]*id$|^id$/i],
  ['account', 'Account', /^(account|company|customer|client|property)([\s_-]*name)?$/i],
  ['job', 'Deal name', /^(deal|opp(ortunity)?|job|project)[\s_-]*(name|title)?$|^name$/i],
  ['rep_name', 'Rep', /^(rep|owner|sales[\s_-]*rep|deal[\s_-]*owner|salesperson|assigned[\s_-]*to)([\s_-]*name)?$/i],
  ['stage', 'Stage', /^(stage|status|deal[\s_-]*stage|pipeline[\s_-]*stage)$/i],
  ['value_estimated', 'Estimated $', /^(amount|value|est(imated)?[\s_-]*(\$|value|dollars|amount)?|deal[\s_-]*(value|amount))$/i],
  ['value_won', 'Won $', /^(won|closed|signed)[\s_-]*(\$|value|dollars|amount)$/i],
  ['close_date', 'Expected close', /^(expected|anticipated|est(imated)?)?[\s_-]*close([\s_-]*date)?$/i],
  ['start_date', 'Start date', /^start([\s_-]*date)?$/i],
  ['won_date', 'Won date', /^(won|closed[\s_-]*won|signed)[\s_-]*date$/i],
  ['lost_date', 'Lost date', /^lost[\s_-]*date$/i],
  ['created_date', 'Created date', /^(created|create)[\s_-]*(date|on|at)?$/i],
  ['branch', 'Branch', /^(branch|office|location|region)$/i],
  ['division', 'Type', /^(division|type|category|service|product[\s_-]*line)$/i],
  ['external_number', 'Deal number', /^(deal|opp(ortunity)?)[\s_-]*(number|no\.?|#)$/i],
  ['end_date', 'End date', /^(end|contract[\s_-]*end)[\s_-]*date$/i],
  ['renewal_date', 'Renewal date', /^renewal([\s_-]*date)?$/i],
];

// a column for each field, from a saved mapping when its columns are all in this file, else by name
export function guessMapping(headers, saved = {}) {
  const has = (h) => typeof h === 'string' && headers.includes(h);
  const savedOk = saved && has(saved.external_id) && Object.values(saved).every((v) => typeof v !== 'string' || has(v));
  if (savedOk) return { mapping: Object.fromEntries(Object.entries(saved).filter(([, v]) => has(v))), fromSaved: true };
  const mapping = {}, used = new Set();
  for (const [f, , re] of CSV_FIELDS) {
    if (saved && has(saved[f]) && !used.has(saved[f])) { mapping[f] = saved[f]; used.add(saved[f]); continue; }
    const h = headers.find((x) => !used.has(x) && re.test(x.trim()));
    if (h) { mapping[f] = h; used.add(h); }
  }
  return { mapping, fromSaved: false };
}

// only the columns the mapping uses, so the upload carries no more than it needs
export function slimRows(records, mapping) {
  const cols = [...new Set(Object.values(mapping).filter((v) => typeof v === 'string'))];
  return records.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? ''])));
}
