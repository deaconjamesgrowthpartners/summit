// Everything that talks to Supabase. The demo adapter mirrors this surface.
import { createClient } from '@supabase/supabase-js';

// The publishable key is safe in the browser. Row level security does the guarding.
const URL = import.meta.env.VITE_SUPABASE_URL || 'https://tyrtzxnhwjchtemytfxv.supabase.co';
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_-ex161UOlee5nRgib3zI3g_mCRfNsF_';

const sb = createClient(URL, KEY, {
  auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

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
export async function isAdmin(userId) {
  const rows = must(await sb.from('app_admins').select('user_id').eq('user_id', userId));
  return rows.length > 0;
}
export async function load(wsId, sinceWeek) {
  const [members, opps, commits, goals] = await Promise.all([
    all(() => sb.from('members').select('*').eq('workspace_id', wsId).order('full_name')),
    all(() => sb.from('opps').select('*').eq('workspace_id', wsId).order('created_at')),
    all(() => sb.from('commits').select('*').eq('workspace_id', wsId).gte('week_key', sinceWeek)),
    all(() => sb.from('goals').select('*').eq('workspace_id', wsId)),
  ]);
  return { members, opps, commits, goals };
}

/* ---------- live ---------- */
export function subscribe(wsId, onChange, onStatus) {
  const ch = sb.channel(`summit-${wsId}`);
  for (const table of ['opps', 'commits', 'goals']) {
    ch.on('postgres_changes', { event: '*', schema: 'public', table, filter: `workspace_id=eq.${wsId}` },
      (p) => onChange(table, p.eventType, p.new, p.old));
  }
  ch.subscribe((status) => onStatus && onStatus(status));
  return () => sb.removeChannel(ch);
}

/* ---------- writes ---------- */
export async function insertOpp(row) {
  return must(await sb.from('opps').insert(row).select().single());
}
export async function updateOpp(id, patch) {
  return must(await sb.from('opps').update(patch).eq('id', id).select().single());
}
export async function insertCommit(row) {
  return must(await sb.from('commits').insert(row).select().single());
}
export async function updateCommit(id, patch) {
  return must(await sb.from('commits').update(patch).eq('id', id).select().single());
}
export async function saveGoals(wsId, period, values) {
  return must(await sb.from('goals').upsert({ workspace_id: wsId, period, values }).select().single());
}
