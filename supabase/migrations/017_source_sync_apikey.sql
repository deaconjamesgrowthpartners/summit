-- Summit  migration 017  source_sync_now sends the apikey header
-- Run in the Supabase SQL editor of project tyrtzxnhwjchtemytfxv, any time after 012. Safe to run more than once.
--
-- The functions gateway refused source_sync_now with 401 INVALID_CREDENTIALS: "No credential matched any of the
-- accepted auth mode(s): publishable, secret". A function deployed now wants the key in an apikey header as well.
-- aspire-sync, deployed earlier, still takes Authorization alone, which is why aspire_sync_now never needed it.
-- Same vault key in both headers: apikey gets past the gateway, Authorization is what source-sync's own gate checks.
-- Only this one function changes. The nightly job (once 016 points it here) calls it too, so this fixes both.

create or replace function source_sync_now(p_source bigint, p_trigger text default 'manual', p_full boolean default false)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare k text;
begin
  select decrypted_secret into k from vault.decrypted_secrets where name = 'aspire_sync_key';
  if k is null then
    raise exception 'no vault secret named aspire_sync_key. Run: select vault.create_secret(''<service role key>'', ''aspire_sync_key'');';
  end if;
  return net.http_post(
    url     := 'https://tyrtzxnhwjchtemytfxv.supabase.co/functions/v1/source-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || k, 'apikey', k),
    body    := jsonb_build_object('source', p_source, 'full', p_full, 'trigger', p_trigger),
    timeout_milliseconds := 150000);
end $$;

revoke execute on function source_sync_now(bigint, text, boolean) from public, anon, authenticated;
grant execute on function source_sync_now(bigint, text, boolean) to service_role;
