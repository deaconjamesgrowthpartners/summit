// Everything that talks to Supabase. The demo adapter mirrors this surface.
import { createClient } from '@supabase/supabase-js';

// The publishable key is safe in the browser. Row level security does the guarding.
const URL = import.meta.env.VITE_SUPABASE_URL || 'https://tyrtzxnhwjchtemytfxv.supabase.co';
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_-ex161UOlee5nRgib3zI3g_mCRfNsF_';

// A link made outside the app (an invite or magic link from the Supabase dashboard) lands with the
// session in the URL hash (#access_token=...), or with ?token_hash=...&type=invite when the email
// template uses one. This client runs the PKCE flow, which refuses both, so they are taken out of
// the URL before the client starts and handed to it by hand. The URL is cleaned either way.
function linkFromUrl() {
  if (typeof location === 'undefined') return null;
  const h = new URLSearchParams(location.hash.replace(/^#/, '')), q = new URLSearchParams(location.search);
  let link = null;
  if (h.get('access_token') && h.get('refresh_token')) link = { access_token: h.get('access_token'), refresh_token: h.get('refresh_token') };
  else if (q.get('token_hash') && q.get('type')) link = { token_hash: q.get('token_hash'), type: q.get('type') };
  else if (h.get('error_description') || h.get('error')) link = { error: h.get('error_code') || h.get('error') || 'link_error' };
  if (!link) return null;
  const u = new URL(location.href);
  u.hash = '';
  for (const k of ['token_hash', 'type', 'next']) u.searchParams.delete(k);
  history.replaceState(null, '', u);
  return link;
}
const pendingLink = linkFromUrl();

const sb = createClient(URL, KEY, {
  auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

// why a link did not sign anyone in, for the login screen. null when there was no link or it worked.
export let linkError = null;
const linkDone = (async () => {
  if (!pendingLink) return;
  try {
    if (pendingLink.error) throw new Error(pendingLink.error);
    if (pendingLink.access_token) must(await sb.auth.setSession(pendingLink));
    else must(await sb.auth.verifyOtp({ token_hash: pendingLink.token_hash, type: pendingLink.type }));
  } catch (e) {
    linkError = /expired|otp_expired/i.test(String(e?.message || e?.code || '')) ? 'expired' : 'failed';
  }
})();

const must = ({ data, error }) => {
  if (error) throw error;
  return data;
};

async function all(q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = must(await q().range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

export const demo = false;

/* ---------- auth ---------- */
export async function session() {
  await linkDone;
  return must(await sb.auth.getSession()).session;
}
export function onAuth(cb) {
  sb.auth.onAuthStateChange((_e, s) => cb(s));
}
// Accounts only exist for roster emails. The before-user-created hook
// rejects everyone else, so a stranger never gets a code.
export async function sendCode(email, redirectTo) {
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: redirectTo } });
  if (error && error.status === 429) throw error;
  // any other refusal looks the same as success. no roster fishing.
}
export async function verifyCode(email, token) {
  return must(await sb.auth.verifyOtp({ email, token, type: 'email' })).session;
}
export async function signOut() {
  await sb.auth.signOut();
}

/* ---------- reads ---------- */
export async function workspaces() {
  return must(await sb.from('workspaces').select('id,slug,name').eq('active', true).order('name'));
}
export async function workspace(slug) {
  return must(await sb.from('workspaces').select('*').eq('slug', slug).eq('active', true).maybeSingle());
}
// tie this login to its roster row and admin row by email (migration 011). A login made by a dashboard
// invite has no link yet. Harmless before 011 runs: the call fails and nothing changes.
export async function linkMember() {
  try { return must(await sb.rpc('summit_link_member')); } catch { return 0; }
}
export async function isAdmin(userId) {
  const rows = must(await sb.from('app_admins').select('user_id').eq('user_id', userId));
  return rows.length > 0;
}
// the workspace's deal source (migration 012). null before it runs, and the config falls back.
export async function source(wsId) {
  try {
    return must(await sb.from('deal_sources').select('id,mode,connector,label,mapping,schedule,enabled').eq('workspace_id', wsId).maybeSingle());
  } catch {
    return null;
  }
}

// Everything a workspace's board reads. Deals come in one of three shapes, said in data.shape:
//   board   deal_board (migration 012), any source
//   aspire  aspire_pipeline, a connected workspace before 012
//   opps    the opps table, typed deals before 014
export async function load(wsId, sinceWeek, src = { mode: 'native', legacy: true }) {
  let shape = src.legacy ? (src.mode === 'native' ? 'opps' : 'aspire') : 'board';
  // stage history for typed deals: what "meetings booked this week" is counted from. null before 014.
  const events = shape === 'board' && src.mode === 'native' ? await stageEvents(wsId) : null;
  if (shape === 'board' && src.mode === 'native' && events === null) shape = 'opps';
  const deals = shape === 'board' ? all(() => sb.from('deal_board').select('*').eq('workspace_id', wsId).order('created_at').order('deal_id'))
    : shape === 'aspire' ? all(() => sb.from('aspire_pipeline').select('*').eq('workspace_id', wsId).order('opportunity_id'))
    : all(() => sb.from('opps').select('*').eq('workspace_id', wsId).order('created_at'));
  const [members, rows, commits, goals, accounts] = await Promise.all([
    all(() => sb.from('members').select('*').eq('workspace_id', wsId).order('full_name')),
    deals,
    all(() => sb.from('commits').select('*').eq('workspace_id', wsId).gte('week_key', sinceWeek)),
    all(() => sb.from('goals').select('*').eq('workspace_id', wsId)),
    // the book is optional. a workspace without one still loads.
    all(() => sb.from('accounts').select('*').eq('workspace_id', wsId).order('property')).catch(() => []),
  ]);
  const native = shape !== 'aspire' && src.mode === 'native';
  const extra = {
    sync: await syncLog(wsId, src), targets: await targets(wsId),
    tracking: src.mode !== 'native' ? await trackingSince(wsId) : null,
    dealAccounts: native && shape === 'board' ? await dealAccounts(wsId) : [],
    changes: native && shape === 'board' ? await recentChanges(wsId) : [],
  };
  return { members, deals: rows, shape, events, commits, goals, accounts, ...extra };
}
// stage changes of typed deals, oldest first: { deal_id, d, stage }. null before migration 014.
export async function stageEvents(wsId) {
  try {
    const rows = await all(() => sb.from('deal_changes').select('deal_id,changed_on,new_value').eq('workspace_id', wsId).eq('field', 'stage').order('id'));
    return rows.map((r) => ({ deal_id: r.deal_id, d: r.changed_on, stage: r.new_value }));
  } catch {
    return null;
  }
}
export async function dealAccounts(wsId) {
  try { return await all(() => sb.from('deal_accounts').select('*').eq('workspace_id', wsId).order('name')); } catch { return []; }
}
export async function recentChanges(wsId) {
  try { return must(await sb.from('deal_changes').select('*').eq('workspace_id', wsId).order('id', { ascending: false }).limit(40)); } catch { return []; }
}
// the sync or upload log, and the names a source has that the roster does not. null before migration 007.
export async function syncLog(wsId, src = {}) {
  try {
    const runsQ = src.legacy === false
      ? sb.from('source_runs').select('*').eq('workspace_id', wsId).order('started_at', { ascending: false }).limit(8)
      : sb.from('aspire_sync_runs').select('*').eq('workspace_id', wsId).order('started_at', { ascending: false }).limit(6);
    const runs = must(await runsQ);
    const unmatched = src.legacy === false
      ? must(await sb.from('deal_unmatched').select('*').eq('workspace_id', wsId).order('deals', { ascending: false })).map((u) => ({ ...u, sales_rep_name: u.rep_name }))
      : must(await sb.from('aspire_unmatched').select('*').eq('workspace_id', wsId).order('deals', { ascending: false }));
    return { runs, unmatched };
  } catch {
    return null;
  }
}

// Summit tile targets (migration 011). Empty before it runs.
export async function targets(wsId) {
  try {
    return must(await sb.from('summit_targets').select('*').eq('workspace_id', wsId));
  } catch {
    return [];
  }
}
// the first day a status snapshot was written: when "pipeline advanced" became measurable
export async function trackingSince(wsId) {
  try {
    let rows;
    try { rows = must(await sb.from('deal_snapshots').select('snap_date').eq('workspace_id', wsId).order('snap_date').limit(1)); }
    catch { rows = must(await sb.from('aspire_status_snapshots').select('snap_date').eq('workspace_id', wsId).order('snap_date').limit(1)); }
    return rows[0]?.snap_date || null;
  } catch {
    return null;
  }
}

/* ---------- live ---------- */
// typed deals subscribe to deals and the account list (migration 014 puts them on the channel). Every other
// workspace keeps the tables it always had, so a table missing from the channel never breaks it.
export function subscribe(wsId, onChange, onStatus, shape = 'opps') {
  const ch = sb.channel(`summit-${wsId}`);
  const tables = shape === 'board' ? ['deals', 'deal_accounts', 'commits', 'goals', 'accounts'] : ['opps', 'commits', 'goals', 'accounts'];
  for (const table of tables) {
    ch.on('postgres_changes', { event: '*', schema: 'public', table, filter: `workspace_id=eq.${wsId}` },
      (p) => onChange(table, p.eventType, p.new, p.old));
  }
  ch.subscribe((status) => onStatus && onStatus(status));
  return () => sb.removeChannel(ch);
}

/* ---------- writes ---------- */
// admins only: the function's gate refuses everyone else. It reads the CRM and writes deals.
// source-sync once it is deployed; the old aspire-sync until then.
export async function runSync(full = false, slug = null) {
  let res = await sb.functions.invoke('source-sync', { body: { full, workspace: slug } });
  if (res.error && res.error.context?.status === 404) res = await sb.functions.invoke('aspire-sync', { body: { full } });
  const { data, error } = res;
  if (error) {
    let msg = error.message;
    try { const b = await error.context?.json?.(); msg = b?.error || b?.run?.errors?.[0] || msg; } catch { /* keep the message */ }
    throw new Error(msg);
  }
  return data;
}
// typed deals (migration 014). Row level security says who may.
export async function insertDeal(row) {
  return must(await sb.from('deals').insert(row).select().single());
}
export async function updateDeal(id, patch) {
  return must(await sb.from('deals').update(patch).eq('id', id).select().single());
}
export async function insertDealAccount(row) {
  return must(await sb.from('deal_accounts').insert(row).select().single());
}
// a CSV file: what it would change, then write it. Leaders only, the functions check.
export async function csvPreview(wsId, rows, mapping) {
  return must(await sb.rpc('csv_import_preview', { p_workspace: wsId, p_rows: rows, p_mapping: mapping }));
}
export async function csvApply(wsId, rows, remove, fileName, mapping) {
  return must(await sb.rpc('csv_import_apply', { p_workspace: wsId, p_rows: rows, p_remove: remove, p_file_name: fileName, p_mapping: mapping }));
}
export async function insertOpp(row) {
  return must(await sb.from('opps').insert(row).select().single());
}
export async function updateOpp(id, patch) {
  return must(await sb.from('opps').update(patch).eq('id', id).select().single());
}
export async function updateAccount(id, patch) {
  return must(await sb.from('accounts').update(patch).eq('id', id).select().single());
}
export async function insertCommit(row) {
  return must(await sb.from('commits').insert(row).select().single());
}
export async function updateCommit(id, patch) {
  return must(await sb.from('commits').update(patch).eq('id', id).select().single());
}
// leaders and admins only: RLS refuses everyone else. amount null removes the target.
export async function saveTarget(row, amount) {
  const key = { workspace_id: row.workspace_id, branch: row.branch, month: row.month, metric: row.metric, division: row.division, kind: row.kind };
  if (amount === null) {
    let q = sb.from('summit_targets').delete();
    for (const [k, v] of Object.entries(key)) q = q.eq(k, v);
    must(await q);
    return null;
  }
  return must(await sb.from('summit_targets').upsert({ ...key, amount, updated_at: new Date().toISOString() }).select().single());
}
export async function saveGoals(wsId, period, values) {
  return must(await sb.from('goals').upsert({ workspace_id: wsId, period, values }).select().single());
}
