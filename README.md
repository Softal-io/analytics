# Personal Web Analytics

A self-hosted, cookieless, privacy-friendly web analytics tool for
personal projects, with admins, approved viewers, and unlimited sites. Runs entirely on
Cloudflare Workers + D1 + Durable Objects. See
[`web-analytics-spec.md`](./web-analytics-spec.md) for the full design
doc (data model, session logic, sizing/cost, etc.) — this README is the
"how do I actually use it" version.

**Stack:** TanStack Start (Vite) on Cloudflare Workers, D1 (SQLite) via
Drizzle ORM, a Durable Object for the live-visitor count, a Cron Trigger
for daily rollups, Kumo (`@cloudflare/kumo`) for the dashboard UI.

> [!NOTE]
> If you do not want to use D1, please tell your agent to replace it with your own Postgres/MySQL DB and put Cloudflare Hyperdrive on top of it.

## What's different in this fork

- **Authentication and access control:** Google sign-in via Better Auth, admin and read-only viewer roles, and user access management through the dashboard or CLI.
- **Public analytics views:** Share selected metrics and sections at a custom public URL, with no sign-in required and a layout matching the private dashboard.
- **Icon and flag fixes:** Correct country flag URLs and consistent country, browser, OS, and device icons across private and public views.
- **Reliable live counts:** Active visitor presence survives Durable Object eviction and WebSocket hibernation; live connections close when access is revoked or sessions expire.
- **Private deployment configuration:** Shared Wrangler structure, individual private build variables, and runtime secrets keep deployment details out of the public repository.

## First-time setup

```bash
# 1. install
pnpm install   # or npm / yarn

# 2. apply the included migrations locally (no Cloudflare account needed)
npm run db:migrate

# 3. create your private local secrets file
cp .dev.vars.example .dev.vars
```

In `.dev.vars`, configure Google OAuth and a random
`BETTER_AUTH_SECRET`, and grant your Google email admin access:

```bash
npm run access:grant -- admin@example.com admin --local
```

Run `npm run dev`, open http://localhost:3006, and sign in with Google.
Admins can add your first site (name, domain, timezone). Once created, you get a
`site_id` (a uuid), which is what the tracking snippet needs.

> Local dev data lives in `.wrangler/state/` (D1 + the Durable Object).
> Want to populate the dashboard with realistic fake data instead of
> waiting on real traffic? See [Seeding demo data](#seeding-demo-data)
> below.

## Adding the tracking snippet to a site

Every site you track needs the tiny snippet from `public/script.js`
added to its pages. It's cookieless and posts to `/collect` on
every pageview (plus SPA route changes via `pushState`/`replaceState`).

```html
<script
  defer
  src="https://analytics.example.com/script.js"
  data-site="YOUR_SITE_ID"
></script>
```

- Use `http://localhost:3006/script.js` instead while developing locally.
- `data-site` is the `id` of the site you created (see it in the
  dashboard's site switcher, or `GET /api/sites`).
- The tracker uses no cookies or persistent browser storage. This alone does
  not establish an exemption from consent requirements. The website owner
  must assess the analytics setup under the rules that apply to their visitors.

### Tracking custom events

The snippet exposes a small global for one-off events (signups, clicks,
conversions, etc.):

```html
<script>
  window.wa.track("signup", { plan: "pro" })
</script>
```

`name` is required; `props` is an optional JSON-serializable object
(kept small — it's stored as a raw JSON blob per event).

## Dashboard

`http://localhost:3006/` (or your deployed URL) — one page, a site
switcher + date-range picker (`today` / `7d` / `30d` / `6m` / `1y`) at
the top, stat cards + chart + filterable ranked lists (top/entry/exit
pages, outbound links, referrers/campaigns, recent activity, browser/OS/device type,
country/region/city, and custom events) below. Add more sites any time
from the same page.

Live visitor count (top-left badge) is pushed over a WebSocket from the
site's `LiveVisitors` Durable Object — no polling. Five-minute visitor presence
is persisted in its SQLite storage so the count survives idle eviction and
WebSocket hibernation.

### Search engines and AI crawlers

The analytics host opts out of search indexing and AI crawling, including login,
private dashboards, public views, and APIs. The shared HTML layout declares
`noindex, nofollow, noarchive, nosnippet`; Worker responses and static assets also
send the same directives in `X-Robots-Tag`. `public/robots.txt` disallows all
crawling and sets `search=no, ai-input=no, ai-train=no` content signals.

These directives rely on crawler cooperation. Public views remain accessible to
anyone with the link. For enforced bot blocking, create a Cloudflare WAF custom
rule scoped to `http.host eq "YOUR_ANALYTICS_HOST"`, rather than enabling a
zone-wide setting that also affects other subdomains. Already indexed URLs may
require removal through the search engine's webmaster tools, because a crawler
blocked by `robots.txt` cannot fetch the page's `noindex` directive.

## API

The dashboard, private API, server functions, and realtime WebSocket require
a verified Google sign-in through Better Auth and an explicit access grant.
Admins can read everything and manage websites, user access, and public views.
Approved viewers can read private analytics. Other signed-in users wait for
an admin to grant access. Grant changes take effect on the next request. Existing live connections are
checked before every update and at least once per minute, and closed when
their access is revoked or their session expires.
The tracking script and `/collect` remain public.

Better Auth stores users, accounts, sessions, and OAuth verification state
in the existing analytics D1 database (`auth_*` tables). Email/password login
is disabled. Cloudflare Zero Trust is not required.

### Google sign-in and admins

Configure a Google OAuth client of type **Web application** with these
authorized redirect URIs:

- `https://analytics.example.com/api/auth/callback/google`
- `http://localhost:3006/api/auth/callback/google`

Put `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_SECRET`, and the
local `BETTER_AUTH_URL` in `.dev.vars`. Set production credentials as Worker
secrets. Set `ANALYTICS_ORIGIN` as a private build variable for the production URL
(see [Deploying](#deploying)). If the OAuth consent
screen is in Testing, include every Google account that will sign in as a test
user, or publish the consent screen for those accounts.

No admin account is bundled with the project. Bootstrap your first admin
with the command below, using the email of your Google account. Admins can
then use **Account menu → Manage user access** to add emails as admins or viewers,
change roles, or revoke access. A grant can be created before the person signs
in. The UI and terminal command prevent removing or demoting the last admin
who has signed in with a verified account. Pending invitations do not count
as a replacement for that admin.

You can also grant access from the terminal (before or after sign-in):

```bash
# First admin or additional admins in production
npm run access:grant -- admin@example.com admin --remote

# Local development admin
npm run access:grant -- admin@example.com admin --local

# Optional read-only access in production
npm run access:grant -- viewer@example.com viewer --remote
```

### Public analytics views

Select a website and choose **Public sharing**. Admins choose a URL name,
enable sharing, and select individual overview metrics and dashboard sections.
Save to obtain `https://analytics.example.com/public/your-url-name`. Anyone with
the link can view the selected items without signing in. Each website has
one configurable public view, disabled until an admin enables it.

The public page and API return only selected aggregates and the site name and
domain. The chart includes visitors and pageviews; geographic sections reveal
only the chosen granularity. Realtime shares only a count, never coordinates
or visitor identities. Raw events, event properties, user accounts, and
credentials are excluded. Disabling sharing immediately closes the public
page and API to new requests. Public responses are not cached.

The read-only `/ext/v1/*` API uses a separate `ANALYTICS_API_TOKEN` Bearer
token for integrations such as another application’s dashboard. Keep that token on
the calling server, never in browser code. Unset tokens disable the external API.

| Route                        | Method                 | Notes                                                   |
| ---------------------------- | ---------------------- | ------------------------------------------------------- |
| `/collect`                   | `POST`                 | **Public.** Ingestion — called by the tracking snippet. |
| `/api/sites`                 | `GET`, `POST`          | List / create sites.                                    |
| `/api/sites/:id`             | `GET`, `DELETE`        | Fetch / delete a site.                                  |
| `/api/sites/:id/summary`     | `GET`                  | Stat-card totals for `?range=`.                         |
| `/api/sites/:id/timeseries`  | `GET`                  | Chart data — daily points, or hourly for `range=today`. |
| `/api/sites/:id/pages`       | `GET`                  | `?view=top\|entered\|exited`.                           |
| `/api/sites/:id/sources`     | `GET`                  | `?view=referrer\|links\|utm`.                           |
| `/api/sites/:id/devices`     | `GET`                  | `?view=browser\|os\|device`.                            |
| `/api/sites/:id/locations`   | `GET`                  | `?view=country\|region\|city`.                          |
| `/api/sites/:id/events`      | `GET`                  | Top custom events.                                      |
| `/api/sites/:id/realtime/ws` | `GET` (WS upgrade)     | Live visitor count, proxied to the `LiveVisitors` DO.   |
| `/api/sites/:id/public-view` | `GET`, `PUT`           | Admin-only public sharing settings.                     |
| `/api/admin/access`          | `GET`, `PUT`, `DELETE` | Admin-only email grants and roles.                      |
| `/api/public/:slug`          | `GET`                  | Public, selected analytics only; 404 when disabled.     |
| `/api/public/:slug/realtime` | `GET`                  | Public count only, if explicitly enabled.               |
| `/api/auth/*`                | Better Auth            | Google sign-in, callback, session, and sign-out.        |

`range` accepts `today | 7d | 30d | 6m | 1y | custom` (custom takes
`from`/`to` as `YYYY-MM-DD`). Current, complete past days use cached
`daily_*` totals and breakdowns. Today and any missing or invalidated days
use raw records. Unique visitors are
deduplicated across the full selected range using an indexed query of retained
visits; adding daily unique counts would count returning visitors repeatedly.

## Daily aggregation

An hourly Cron Trigger (`10 * * * *`, see `wrangler.jsonc` → `triggers.crons`)
rolls the previous day in each site's timezone into `daily_summary`/`daily_pages`/
`daily_sources`/`daily_devices`/`daily_locations`/
`daily_outbound_links`/`daily_events` for every site
(`src/lib/aggregate.ts`). Each day is replaced atomically, so repeating
a day is safe. Each run builds up to three missing or invalidated days, taking
one day per website per round and rotating the first website each hour. Recent
days go first within each website. Failed days save their retry timing in D1:
the delay starts at two hours, doubles after repeated failures, and caps at
24 hours. Other websites and older healthy days can continue processing.
Successful days clear their retry state. Runs use at most 49 queries normally,
or 50 when failures need to be recorded, within the free Worker query budget.

Test it locally by hitting the scheduled handler:

```bash
curl "http://localhost:3006/cdn-cgi/handler/scheduled"
```

## Seeding demo data

For local dev, `scripts/seed-demo-data.mjs` replaces a site's analytics
rows with realistic fake traffic (real referrer domains, real
cities/countries, real browser/OS/device combos, outbound-link clicks, a
fictional SaaS site's pages, and a handful of custom events). The default
generates 30 UTC calendar days of raw activity. Reports group those records
using the site's configured timezone; cron builds historical caches normally.

```bash
node scripts/seed-demo-data.mjs <site-id> [days]   # default 30 calendar days
npm run cf -- d1 execute DB --local --file=./seed-output.sql
```

## Scripts

| script            | what it does                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `dev`             | Vite dev server with the Cloudflare plugin + local D1/DO (runs `db:migrate` first via `predev`) |
| `build`           | Validate deployment inputs, generate private Wrangler config, and build                         |
| `preview`         | Build + serve via `vite preview`                                                                |
| `deploy`          | Build + `wrangler deploy`                                                                       |
| `cf-typegen`      | Regenerate `worker-configuration.d.ts` from `wrangler.jsonc`                                    |
| `db:generate`     | Generate SQL migrations from `src/db/schema.ts`                                                 |
| `db:migrate`      | Apply migrations to **local** D1                                                                |
| `db:migrate:prod` | Apply migrations to **remote** D1                                                               |
| `db:studio`       | Open Drizzle Studio                                                                             |
| `typecheck`       | `tsc --noEmit`                                                                                  |
| `access:grant`    | Grant an email admin or viewer access in local or remote D1                                     |
| `cf`              | Run Wrangler with generated config (or an explicit `--config` override)                         |

## Project layout

```
src/
  server.ts                 # custom Worker entry — fetch + scheduled (cron) + exports the DO
  durable-objects/
    live-visitors.ts         # LiveVisitors DO — live visitor count over WebSocket (Hibernation API)
  db/
    schema.ts                # raw tables + daily_* rollup tables (drizzle)
    index.ts                 # drizzle client (uses env.DB)
  lib/
    aggregate.ts              # cron: rolls raw tables into daily_* rollups
    api-context.ts            # shared "load site + resolve ?range=" helper for API routes
    collect-schema.ts         # zod schema for POST /collect
    dates.ts                  # timezone-aware date-range resolution
    echarts.ts                # central ECharts module registration
    format.ts                 # number/duration/percent formatting
    geo.ts                    # reads request.cf for country/region/city
    lookups.ts                # resolves/inserts sources/devices/locations lookup rows
    raw-stats.ts              # aggregates uncached intervals
    session.ts                # 30-min session window / visit upsert logic
    summary.ts, timeseries.ts, top-lists.ts   # dashboard query logic
    ua.ts                     # lightweight User-Agent parser
    visitor-id.ts             # sha256(site_id + IP + UA) — cookieless visitor id
  components/dashboard/       # dashboard-only UI (kumo-based)
  hooks/use-live-visitors.ts  # WebSocket hook for the live-visitor badge
  routes/
    __root.tsx
    index.tsx                 # the dashboard (single page)
    collect.ts                 # POST /collect — public ingestion route
    api/
      sites.ts, sites.$siteId.ts
      sites.$siteId.summary.ts, .timeseries.ts, .pages.ts, .sources.ts,
      .devices.ts, .locations.ts, .events.ts, .realtime.ws.ts
public/
  script.js                  # the tracking snippet — see "Adding the tracking snippet" above
scripts/
  seed-demo-data.mjs         # generates realistic fake traffic for local dev
  grant-access.mjs           # grants admin/viewer access by email
  deployment-config.mjs      # combines shared structure with private build inputs
  wrangler.mjs               # prepares configuration for Wrangler commands
drizzle/                     # generated SQL migrations
wrangler.jsonc                # generic bindings, cron trigger, and Worker config
.deployment.env.example       # sample private deployment inputs
.deployment.env.local         # your deployment inputs (Git-ignored)
wrangler.local.jsonc          # generated configuration (Git-ignored; do not edit)
wrangler.dev.local.jsonc      # generated local development config (Git-ignored)
web-analytics-spec.md         # the full design spec this app implements
```

## Deploying

`wrangler.jsonc` defines the shared Worker structure: bindings, compatibility
flags, observability, and the cron trigger. Keep its sample domain and database
ID generic. `scripts/deployment-config.mjs` reads it and generates the Git-ignored
`wrangler.local.jsonc` for production builds and remote commands, and
`wrangler.dev.local.jsonc` for local commands. Separate output files let local
development and production builds run together. Do not edit these generated
files; change the template or the private inputs instead.

### What goes where

| Setting                                                                  | Location                                                         |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Bindings, Worker name, database name, compatibility flags, cron          | Committed `wrangler.jsonc`                                       |
| `ANALYTICS_ORIGIN` (your HTTPS origin, without a path)                   | Private build variable; locally, `.deployment.env.local`         |
| `D1_DATABASE_ID` (UUID from D1 creation)                                 | Private build variable; locally, `.deployment.env.local`         |
| `CLOUDFLARE_ACCOUNT_ID` (optional if Wrangler identifies your account)   | Private build variable; locally, `.deployment.env.local`         |
| `BETTER_AUTH_URL`, `TRACKER_ORIGIN`, custom domain route                 | Generated from `ANALYTICS_ORIGIN`                                |
| `BETTER_AUTH_SECRET`, Google credentials, optional `ANALYTICS_API_TOKEN` | Worker runtime secrets; locally, `.dev.vars`                     |
| Cloudflare deployment API token                                          | Cloudflare Builds' API token setting, or your CLI authentication |

The domain and resource IDs are deployment metadata, rather than credentials,
but do not need to be published in Git. The domain will still be visible to
visitors of the deployed application. Build variables are separate from runtime
bindings: the preparer copies only the two derived URLs into `vars`; it never
copies login credentials or API tokens.

### First production deployment

1. Create a D1 database: `npm run cf -- d1 create web-analytics-db`.
2. Copy `.deployment.env.example` to `.deployment.env.local`. Replace
   `ANALYTICS_ORIGIN` and `D1_DATABASE_ID` with your real values. Use a domain in
   your Cloudflare account. Set the optional account ID if needed. If changing
   the generic Worker or database name, edit `wrangler.jsonc` as well.
3. Apply migrations to the remote DB: `npm run db:migrate:prod`.
4. Set `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET`
   using `npm run cf -- secret put NAME` for each secret. Generate a random
   auth secret and configure the Google redirect URLs described above.
5. Grant your Google account admin access:
   `npm run access:grant -- admin@example.com admin --remote`.
6. Optionally enable the read-only integration API:
   `npm run cf -- secret put ANALYTICS_API_TOKEN`.
7. Deploy: `npm run deploy`.

Production builds and remote database commands fail early when the domain or
database ID is missing or invalid. Local development can run without production
inputs, using localhost and local D1. When inputs are present, local commands
use the same D1 ID so existing local data stays in the same database namespace.
If you begin without production inputs, adding a real database ID later switches
the local D1 namespace; recreate your local admin and demo data in that namespace.
Local auth and tracker URLs can be overridden in `.dev.vars` as shown in the
example. Environment variables override `.deployment.env.local`; CI ignores that
local file entirely. An explicit `npm run cf -- ... --config path/to/config.jsonc`
uses that file directly and bypasses preparation and validation.

After changing bindings, edit only the shared template and run
`npm run cf-typegen`. Type generation uses the generic template so tracked types
do not contain private deployment metadata. Future builds automatically receive
changes to the shared structure.

### Cloudflare Workers Builds

Connect your Git repository to the Worker and set:

- **Build command:** `pnpm run build`
- **Deploy command:** `npx wrangler deploy`
- **Build variables and secrets:** `ANALYTICS_ORIGIN`, `D1_DATABASE_ID`, and,
  optionally, `CLOUDFLARE_ACCOUNT_ID`. You can select the Secret type to mask these
  deployment details in the settings UI.

Vite writes the built Worker configuration and Wrangler's deploy redirect, so
the deploy command uses the configuration produced by the build. There is no
inline shell script or full Wrangler JSON build secret. Set application
credentials under the Worker's runtime **Variables and Secrets**, separately
from its build settings. Add secrets directly to the existing Worker, or use
`npm run cf -- secret put NAME`.

Builds do not apply remote migrations automatically. Apply new migrations before
deploying code that needs them, using the same private database inputs.

### Migrating from the previous private Wrangler copy

Before running an updated command, copy the existing private config's
`vars.BETTER_AUTH_URL` into `ANALYTICS_ORIGIN`, the `DB` binding's `database_id`
into `D1_DATABASE_ID`, and optional `account_id` into `CLOUDFLARE_ACCOUNT_ID` in
`.deployment.env.local`. The two old runtime URLs should share one origin. Move
any custom binding declarations into the shared template, keeping private IDs
out of Git. The previous `wrangler.local.jsonc` becomes generated output.

For Cloudflare Builds, add those individual build variables, change the build
command to `pnpm run build`, and remove the obsolete `WRANGLER_CONFIG_JSON` build
secret after verifying the new deployment. Existing Worker runtime secrets,
database contents, and Durable Objects stay in place.

Create a site in the dashboard, then copy its **Install script** snippet into
the shared page layout of that website. This works on Workers, static sites,
and other hosting providers. No service binding or Cloudflare analytics switch
is needed in the tracked site's Worker.

## Metric definitions

- Visitors are distinct recognized visitor IDs whose visits overlap the selected range,
  including visits that continue across midnight. The
  cookieless IP and user-agent identity is an estimate of people. Daily chart
  counts can include the same person on multiple days. Keep raw visits for
  historical visitor deduplication.
- Visits use a 30-minute inactivity window, refreshed by pageviews, visible-page
  time reports, and tracked interactions.
- Average duration includes visible, focused reading time on single-page visits.
  The snippet reports cumulative page time every 15 seconds and on tab hiding,
  blur, navigation, and page exit. Hidden tabs do not accrue time. Retries and
  out-of-order totals do not double-count time. Old visits retain their previous
  first-to-last-pageview estimates; reading time cannot be backfilled.
- A visit is engaged after more than 10 seconds of active time, a second
  pageview, an outbound click, or a custom event. Bounce rate is the percentage
  of visits that have not engaged. Old visits retain their old definition.
- Recent activity counts visitors with recorded activity in the last five
  minutes and is independent of the selected date range.
- Direct means the browser explicitly reported no external referrer. Unknown
  means referrer attribution was omitted or invalid. Browsers that suppress
  referrers can still look like Direct; analytics cannot recover that origin.
- Sources tooltips show the full UTM source, medium, and campaign values, plus
  clickable recorded referring URLs and tagged landing URLs. Each group shows
  its five most visited URLs of each kind, sorted by visits in descending order.
  Source details open on hover or by clicking the source label. Keyboard users
  can press Enter or Space to open the details, Tab through the URLs, and Escape
  to close them and return to the label. URL rankings load when details open and are cached for five minutes in D1
  and browser memory, so repeated opens reuse the results. The tooltip shows
  when its URLs were updated. Referring URLs contain only what the
  browser supplies; many browsers strip paths on cross-site navigation. Older
  records have no full URLs and fall back to their recorded domain. These URL
  details are included when the owner shares referrers or campaigns publicly.
- Outbound clicks include middle-button clicks. For applications that use URL
  fragments as routes, opt in with `data-hash-routing="true"` on the tracker
  script. Ordinary fragment anchors remain part of the same page by default.
- Ranked lists label their units: pageviews, visits, clicks, or events. Event
  percentages include all event types, even when only the top ten are displayed.

- Recorded HTTP(S) URLs retain their paths, query strings, and fragments up to
  500 characters. Longer URLs are omitted rather than truncated into misleading
  links. Referrer domains, visits, and engagement still count; outbound clicks
  with longer destinations appear under "URL exceeds recording limit".
  Change `MAX_RECORDED_URL_CHARS` in `src/lib/analytics-config.ts` to configure
  the server limit. Generated install snippets carry that value in
  `data-url-limit`; update installed snippets when changing the limit. The
  tracker defaults to 500 when the attribute is absent. Existing stored records
  are not deleted, but source URL rankings omit URLs beyond the current limit.
  Website owners should account for URL recording when including personal
  information or tokens in URLs and when choosing to share outbound-link lists.
- Page path dimensions retain their existing 2,048-character limit. Longer
  paths appear as "Page path exceeds recording limit" without a navigation link;
  their pageviews, reading time, and actions still count. Navigation between
  different oversized paths still counts each page. Configure
  `MAX_RECORDED_PATH_CHARS` and the install snippet's `data-path-limit` together.
  Campaign URL lookups use complete index searches for each matching UTM tuple,
  including legacy NULL values. Equivalent campaign identifiers share a cache
  key regardless of JSON spacing or escape formatting.

Reports carry page context and private, memory-only credentials. Acknowledged
requests have been persisted; transient failures are retried while the page
exists. Page and action IDs prevent duplicate counts. Exit delivery remains
best effort because a browser can destroy the page before a request completes.
A memory-only document key keeps reports from the same open page associated
with one recognized visitor even if their network changes or reports arrive
out of order. The server stores only the key's hash and removes mappings after
two days without activity. This does not use cookies or browser storage.
Past-day rollups are a cache: late activity invalidates affected days, queries
fall back to raw records, and cron rebuilds them atomically. Existing rollups
without a current marker or metric version are rebuilt gradually after the migration.
Late reports that connect adjacent visits merge their pages and events atomically,
preserving the original arrival source. Reports use the persisted page timeline so
duplicates cannot extend live presence. New snippets freeze each page's start time
on a document-wide clock, preserving page order and campaign attribution when
requests are delayed in transit. Old snippets, future page starts, and device
timestamps differing from server time by more than a minute use server-relative
timing instead. This adds no database queries or browser storage.
Chart queries bind day boundaries as JSON
data rather than growing their SQL text, and hourly charts include 23-hour and
25-hour local days. Both chart labels and hover timestamps use the site's
timezone. Invalid new timezones are rejected; existing invalid sites and failed
aggregation days are logged without stopping aggregation for other sites.

The default local port for both dev and preview is 3006, with strict port checking so OAuth callbacks do
not silently break when a different application occupies the port. Configure
Google's local callback as `http://localhost:3006/api/auth/callback/google`.
