-- Summit: why the board 500s. Runs every read the app makes, as Joe and as one rep, the way the app runs them:
-- signed in, row security on, 8-second limit. Reads only. Changes nothing.
do $$
declare
  u record; t text; n bigint; ms numeric; t0 timestamptz; out text := '';
  ws uuid := (select id from workspaces where slug = 'elevation-outdoors');
  reads text[] := array['deal_sources', 'members', 'deal_board', 'aspire_pipeline', 'deal_snapshots', 'source_runs', 'summit_targets'];
begin
  for u in (select id, email from auth.users where lower(email) = 'joe@deaconjames.com')
           union all
           (select u2.id, u2.email from auth.users u2 join members m on m.user_id = u2.id
             where m.workspace_id = ws and m.active and m.role = 'rep' and lower(u2.email) <> 'joe@deaconjames.com'
             order by u2.email limit 1) loop
    perform set_config('request.jwt.claims', json_build_object('sub', u.id, 'role', 'authenticated', 'email', u.email)::text, true);
    perform set_config('request.jwt.claim.sub', u.id::text, true);
    set local role authenticated;
    set local statement_timeout = '8s';
    foreach t in array reads loop
      begin
        t0 := clock_timestamp();
        execute format('select count(*) from (select * from %I where workspace_id = $1) x', t) into n using ws;
        ms := round(extract(epoch from clock_timestamp() - t0) * 1000);
        out := out || format(E'%s | %s | ok | %s rows | %s ms\n', u.email, t, n, ms);
      exception when others then
        out := out || format(E'%s | %s | FAILED | %s | %s\n', u.email, t, sqlstate, sqlerrm);
      end;
    end loop;
    reset role;
  end loop;
  perform set_config('summit.diag', out, false);
end $$;
select line as "who | read | result | detail | time" from unnest(string_to_array(rtrim(current_setting('summit.diag'), E'\n'), E'\n')) line;
