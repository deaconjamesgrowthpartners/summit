# Summit

The weekly scoreboard. Static app, Vite, Supabase, Netlify.
One build serves every client at `/<workspace-slug>`. Everything a client sees
(name, colors, font, measures, tabs, stages, branches, categories, goal tiles)
comes from their `workspaces` row. Nothing about a client is in the code.

## Run it

```
npm install
npm run dev        # real Supabase, needs a roster login
npm run demo       # fake data in memory, no login. ?as=leader|grow1|grow2|bdm1|bdm2, ?now=<ISO time> to pin the clock
npm test           # week and lock math, must match summit_week_key / summit_lock_at
npm run build      # production bundle in dist/ (demo code is never included)
```

Env (optional, the publishable key and URL are the defaults):
`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`.

## Database

1. Run in the SQL editor, in order, after 001:
   - `002_summit_frontend.sql`: new columns, the auth hook, realtime, Elevation's config and goals.
   - `003_test_roster_segment_contact.sql`: segment and contact columns, and the 5 test rows moved to
     joe+leader / joe+grow1 / joe+grow2 / joe+bdm1 / joe+bdm2 @deaconjames.com with their teams.
     It stops and changes nothing unless Elevation has exactly 1 leader and 4 reps.
2. Dashboard > Authentication > Hooks > **Before User Created** > Postgres >
   `public.summit_before_user_created`. This is what stops strangers. Without it,
   anyone who types an email gets an account (and sees nothing, but still).
3. Dashboard > Authentication > Email templates > Magic Link: include both
   `{{ .Token }}` (the 6-digit code) and `{{ .ConfirmationURL }}` (the link).
4. Dashboard > Authentication > URL configuration: add the Netlify site URL,
   `https://summit.deaconjames.com/**`, and `https://deploy-preview-*--<netlify-site>.netlify.app/**`.
5. Dashboard > Authentication > Providers > Email: leave signups on. The hook does the gating.
   Set up custom SMTP before go-live. The built-in sender caps at a few emails an hour.

## Rules the code keeps

- Login is a code or a link. No passwords, no signup form, no roster fishing: the
  login screen shows the same message whether or not an email is on a roster, and an
  unknown slug looks the same as one you are not on.
- The app sends no email. The only email is the login code Supabase sends to the
  person who asked for it.
- Red and yellow go on numbers and rows. A person's name is always plain ink.
- Reps edit their own rows and commits. Leaders edit everything in their workspace.
  Row level security enforces it. The screen only mirrors it.
- The commit note is its own column, so a note never trips the late flag.
- The week on screen rolls at 12:01am the day after the lock (Wednesday for Elevation), not at
  the lock. Lock night shows the week just closed, locked, with a "This week did" row so reps
  can enter what they did. The database still locks and stamps late edits at the lock.

## Workspace row shape

- `brand`: `head`, `accent`, `bg`, `panel`, `muted` (hex), `font` (Google Font name), `logo` (https url or null)
- `measures[]`: `key`, `type` (count|money), `label`, `label_grow`, `label_netnew`,
  `auto` (bids_count | bids_value | won_value | starts_next_week_value, fills from the board)
- `tabs[]`: `key` (summit | climb | grow | netnew | accounts | datacheck), `label`, plus per-tab words
  (`title`, `sub`, `team_label`, `note`, `note_prompt`, `branch_note`, `branch_measures`, `ratio`, `crm_label`)
- `stages[]`: `name`, `prob`, `status` (open|won|lost), `needs_close`, `bid`, `hold`
- `categories[]`: `name`, `recurring`, `default_for` (grow|netnew)
- `goal_tiles[]`: `key`, `label`, `source` (won_recurring|manual), `goal`, `actual`, `as_of`,
  `deadline`, `coverage`. The values live in `goals.values` for the current year.
