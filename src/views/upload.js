// CSV upload, for a workspace whose deals come from a file. A leader picks the file, says which column is
// which, sees what would change, ticks anything to remove, and writes it. The mapping is remembered, so
// the next file with the same columns goes straight to the preview.
import { S, isLeader } from '../data/store.js';
import { esc, money, toast } from '../lib/format.js';
import { csvRecords, guessMapping, slimRows, CSV_FIELDS } from '../lib/csv.js';

const MAX_ROWS = 20000;

export async function uploadFile(file) {
  try {
    const { headers, records } = csvRecords(await file.text());
    if (!headers.length) { S.upload = { name: file.name, err: 'That file is empty.' }; return; }
    if (records.length > MAX_ROWS) { S.upload = { name: file.name, err: `That file has ${records.length.toLocaleString()} rows. The limit is 20,000.` }; return; }
    const { mapping, fromSaved } = guessMapping(headers, S.cfg.source.mapping || {});
    S.upload = { name: file.name, headers, records, mapping, fromSaved, preview: null, remove: new Set() };
    // same columns as last time: straight to what would change
    if (fromSaved) await uploadPreview();
  } catch (e) {
    S.upload = { name: file.name, err: `Could not read that file: ${e.message || e}` };
  }
}

export function uploadMap(field, col) {
  const u = S.upload;
  if (!u) return;
  if (col) u.mapping[field] = col; else delete u.mapping[field];
  u.preview = null; u.fromSaved = false;
}
export function uploadTick(id, on) {
  const u = S.upload;
  if (!u) return;
  if (on) u.remove.add(id); else u.remove.delete(id);
}
export function uploadClear() { S.upload = null; }
export function uploadRemap() { if (S.upload) { S.upload.fromSaved = false; S.upload.preview = null; } }

export async function uploadPreview() {
  const u = S.upload;
  if (!u || !u.records) return;
  if (!u.mapping.external_id) { u.err = 'Pick the column that holds each deal\'s ID first.'; return; }
  u.busy = true; u.err = '';
  try {
    u.preview = await S.api.csvPreview(S.cfg.id, slimRows(u.records, u.mapping), u.mapping);
    u.remove = new Set();
  } catch (e) {
    u.err = e.message || String(e);
  }
  u.busy = false;
}

export async function uploadApply() {
  const u = S.upload;
  if (!u || !u.preview || u.busy) return false;
  u.busy = true;
  try {
    const run = await S.api.csvApply(S.cfg.id, slimRows(u.records, u.mapping), [...u.remove], u.name, u.mapping);
    S.cfg.source.mapping = { ...u.mapping };
    toast(`Uploaded. ${run.rows_inserted ?? 0} added, ${run.rows_updated ?? 0} changed${run.rows_removed ? `, ${run.rows_removed} removed` : ''}`);
    S.upload = null;
    S.sync = (await S.api.syncLog(S.cfg.id, S.cfg.source).catch(() => null)) || S.sync;
    return true;
  } catch (e) {
    u.err = e.message || String(e);
    u.busy = false;
    return false;
  }
}

const fmt = (v) => (v === null || v === undefined || v === '' ? '<span class="m">blank</span>' : typeof v === 'number' ? esc(v.toLocaleString()) : esc(v));
const FIELD_LABEL = Object.fromEntries(CSV_FIELDS.map(([k, l]) => [k, l]));

// the upload card on Data Check. Leaders upload. Everyone sees the history in the sync card.
export function uploadCard(cfg) {
  if (cfg.source.mode !== 'csv' || !isLeader()) return '';
  const u = S.upload;
  const head = `<div class="sec-h"><h2 class="s15">Upload deals</h2>${u?.name ? `<span class="pill n">${esc(u.name)}</span>` : ''}</div>`;
  if (!u) {
    return `<div class="card mb">${head}
      <p class="help">A CSV export of every deal. Nothing changes until you see what the file would do and say so. A deal missing from the file is listed, never removed on its own.</p>
      <input type="file" accept=".csv,text/csv,.txt" data-up-file aria-label="CSV file"></div>`;
  }
  if (!u.records) return `<div class="card mb">${head}<p class="help">${esc(u.err || '')}</p><div class="row-actions"><button class="lnk" data-up-clear>Pick another file</button></div></div>`;
  const opts = (cur) => `<option value=""></option>${u.headers.map((h) => `<option ${h === cur ? 'selected' : ''}>${esc(h)}</option>`).join('')}`;
  const mapHtml = `<p class="help">${u.records.length.toLocaleString()} rows. ${u.fromSaved ? 'Same columns as last time.' : 'Say which column is which. Only Deal ID is required. Remembered for next time.'}</p>
    <div class="tw flat"><table><tbody>${CSV_FIELDS.map(([f, l]) => `<tr><td>${esc(l)}${f === 'external_id' ? ' <small class="m">required</small>' : ''}</td><td><select class="ed" data-up-map="${f}" aria-label="${esc(l)} column">${opts(u.mapping[f])}</select></td></tr>`).join('')}</tbody></table></div>`;
  const p = u.preview;
  let pv = '';
  if (p) {
    pv = `<h3 style="font-size:13px;margin:12px 0 4px">What this file would do</h3>
      <div class="kv"><span>New deals</span><b>${p.added}</b></div>
      <div class="kv"><span>Changed</span><b>${p.changed}${p.restored ? ` <small class="m">${p.restored} back after being removed</small>` : ''}</b></div>
      <div class="kv"><span>Unchanged</span><b>${p.unchanged}</b></div>
      ${p.skipped_no_id ? `<div class="kv"><span>Rows with no deal ID, skipped</span><span class="pill y">${p.skipped_no_id}</span></div>` : ''}
      ${p.duplicates.length ? `<div class="kv"><span>IDs on more than one row (the last row wins): ${p.duplicates.slice(0, 6).map((d) => esc(d.external_id)).join(', ')}${p.duplicates.length > 6 ? '...' : ''}</span><span class="pill y">${p.duplicates.length}</span></div>` : ''}
      ${p.changes.length ? `<div class="tw flat"><table><thead><tr><th>Deal</th><th>What changes</th></tr></thead><tbody>${p.changes.slice(0, 40).map((c) => `<tr><td class="acct">${esc(c.account || c.external_id)}<small>#${esc(c.external_id)}${c.back ? ' · back' : ''}</small></td><td>${c.fields.map((x) => `<div><small>${esc(FIELD_LABEL[x.field] || x.field)}: ${fmt(x.from)} → ${fmt(x.to)}</small></div>`).join('')}</td></tr>`).join('')}</tbody></table></div>${p.changed > 40 ? `<p class="note">and ${p.changed - 40} more</p>` : ''}` : ''}
      ${p.missing ? `<h3 style="font-size:13px;margin:12px 0 4px">Not in this file <span class="pill n">${p.missing}</span></h3>
        <p class="help">These are on the board now. They stay unless you tick them. Ticked deals are marked removed and kept, never deleted.</p>
        <div class="tw flat"><table><thead><tr><th>Remove</th><th>Deal</th><th>Stage</th><th class="num">$</th></tr></thead><tbody>${p.missing_rows.map((m) => `<tr><td><input type="checkbox" data-up-tick="${esc(m.external_id)}" ${u.remove.has(m.external_id) ? 'checked' : ''} aria-label="Remove ${esc(m.account || m.external_id)}"></td><td class="acct">${esc(m.account || m.external_id)}<small>#${esc(m.external_id)}${m.rep ? ` · ${esc(m.rep)}` : ''}</small></td><td>${esc(m.stage || '')}</td><td class="num">${money(m.value)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <div class="row-actions"><button class="btn sm" data-up-apply ${u.busy ? 'disabled' : ''}>${u.busy ? 'Saving...' : `Upload ${p.added + p.changed} changes${u.remove.size ? ` and remove ${u.remove.size}` : ''}`}</button><button class="lnk" data-up-clear>Cancel</button></div>`;
  }
  return `<div class="card mb">${head}
    ${p && u.fromSaved ? '' : mapHtml}
    ${u.err ? `<p class="help"><span class="pill r">${esc(u.err)}</span></p>` : ''}
    ${p ? pv : `<div class="row-actions"><button class="btn sm" data-up-preview ${u.busy ? 'disabled' : ''}>${u.busy ? 'Reading...' : 'See what would change'}</button><button class="lnk" data-up-clear>Cancel</button></div>`}
    ${p && u.fromSaved ? '<p class="note">Same columns as last time. <button class="lnk" data-up-remap>Change the columns</button></p>' : ''}
  </div>`;
}
