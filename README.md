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
   - `006_book_config.sql` (after 005, which made the `accounts` table): realtime on `accounts`, plus the
     book block on the Grow tab and the book tiles on the Summit tab.
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
- Contrast is computed, not picked. `src/lib/palette.js` turns the brand colors into light and dark token
  sets and fits every text token against every background it can sit on, so each pair clears 4.5:1
  (body ink clears 7:1). Light mode is always light ground with dark ink, dark mode the reverse, whatever
  the brand says. `test/contrast.test.js` checks every pair for several very different brands. Never
  dim text with opacity. Use `--ink2`, `--muted` or `--headText2`.
- Reps edit their own rows and commits. Leaders edit everything in their workspace.
  Row level security enforces it. The screen only mirrors it.
- The commit note is its own column, so a note never trips the late flag.
- The week on screen rolls at 12:01am the day after the lock (Wednesday for Elevation), not at
  the lock. Every screen scores one week, `weekInfo().scoreKey`: the week just closed on lock
  night, last week the rest of the time. Summit, The Climb, the Branches cards and the rep form
  all read it, and a test fails if a screen picks its own week. The database still locks and
  stamps late edits at the lock.

## Workspace row shape

- `brand`: `head`, `accent`, `bg`, `panel`, `muted` (hex), `font` (Google Font name), `logo` (https url or null)
- `measures[]`: `key`, `type` (count|money), `label`, `label_grow`, `label_netnew`,
  `auto` (bids_count | bids_value | won_value | starts_next_week_value, fills from the board)
- `tabs[]`: `key` (summit | climb | grow | netnew | accounts | datacheck), `label`, plus per-tab words
  (`title`, `sub`, `team_label`, `note`, `note_prompt`, `branch_note`, `branch_measures`, `ratio`, `crm_label`)
- `stages[]`: `name`, `prob`, `status` (open|won|lost), `needs_close`, `bid`, `hold`
- `categories[]`: `name`, `recurring`, `default_for` (grow|netnew)
- `tabs[].book` (on one team tab): `label`, `audit_days`, `levels[]` (`value`, `color` g|y|r), `risk[]` (levels that count as at risk).
  A row is red past the audit window or at a red level, yellow at a yellow level or with no audit on record.
- `tabs[summit].tiles[]`: `type` (book_value | book_at_risk), `label`. They follow the Viewing scope.
- `goal_tiles[]`: `key`, `label`, `source` (won_recurring|manual), `goal`, `actual`, `as_of`,
  `deadline`, `coverage`. The values live in `goals.values` for the current year.

## Aspire probe (discovery only)

`supabase/functions/aspire-probe` logs in to Aspire and reports the shape of its data. It writes
nothing, to Aspire or to Summit. Every data call is a GET. The only POST is the login handshake, to a
fixed list of token paths, and the network wrapper refuses anything else before it is sent. There's a
hard cap of 70 calls, 350ms between calls, and backoff on 429. The report shows field names and types,
never record values, except the rep, branch and division fields, which show up to 3 examples. The
secret, the client id and the token never appear in the report.

What it reports:
1. Which login worked. It tries OAuth client credentials at `/connect/token`, `/oauth/token` and
   `/token` first, then Aspire's `POST /Authorization { ClientId, Secret }`. It proves the token with
   one GET, and reports the token field, the header format, the expiry and whether a refresh token came back.
2. Per endpoint (Opportunities, Properties, Contracts, Contacts, Invoices, Divisions, plus Branches
   and OpportunityStatuses): whether it exists, the record count (`$count`), the field names and types
   on one record, and whether a modified-since `$filter` works. It proves the filter is applied, not
   just accepted: a year-2100 cutoff must return nothing.
3. Open opportunities or only sold work: the statuses in the 500 most recent, plus an exact count
   of rows with no won date and no lost date.
4. Which fields identify the rep, the branch and the division, with examples.

Pass 2 (the default since the first run showed Aspire holds sold work, not open pipeline) asks whether the
weekly measures can come from Aspire. It pulls 500 opportunities and counts every SalesRepContactName, then tries
SiteAudits, Activities, ContactActivities, Meetings, Events, the audit and activity type lookups, Tasks, Notes,
PropertyContacts, Schedules and WorkTickets, each under its plural, singular and a few obvious variants. For each
one that exists it reports:
- the fields on a sample record
- the date field and the date range of the 50 most recent records
- the person fields, with counts of each name
- counts of any type field (for example, how many activities are Client Visits)
- whether a date filter and a person filter are really applied, not just accepted

Pass 3 (the default now) reconciles Aspire against Summit. Up to 300 calls, same spacing and 429 handling.
- Ownership: every opportunity that is not Won or Lost, plus everything Won in the last 180 days, with
  the 14 fields Summit needs, grouped by rep (counts, estimated and won dollars) and by status.
- Activity: activities created in the last 90 days, per CreatedByUserName per Monday-start week, with how many
  weeks each person has at least one (habit 75%+, patchy 50-74%, occasional under 50%). Also category
  filled versus blank, and how many link to a property, an opportunity, both, or neither.

Paging goes by key (`ID gt <last ID>`, ordered by ID), which works even where Aspire ignores `$skip`. If the key
filter is refused or ignored it falls back to `$skip`, and stops rather than double counts if that is ignored too.
Each pull is checked against Aspire's own `$count`, and every row is checked again here, so a filter Aspire
accepts but ignores cannot inflate a number. The report's `paging` block says what happened.

Send `{"part": "ownership"}` or `{"part": "activity"}` to run half, if the full run hits the time budget.
`?format=csv` returns the opportunity rows as a spreadsheet. `ASPIRE_PROBE_SECONDS` raises the time budget
(default 125, the free plan cuts off at 150). Send `{"pass": 1}` or `{"pass": 2}` to run an earlier pass.

Run it:
```
supabase functions deploy aspire-probe --project-ref tyrtzxnhwjchtemytfxv
```
Then in the dashboard: Edge Functions > aspire-probe > Test, with the service role. Or call the
function URL signed in as a Summit admin. Add `?format=text` for the summary lines only.
Only a Summit admin or the service role can run it. Everyone else gets 403.
`npm test` runs the probe against a simulated Aspire (`test/aspire-probe.test.js`).
