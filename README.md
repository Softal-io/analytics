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

Run `npm run dev`, open http://localhost:3000, and sign in with Google.
Admins can add your first site (name, domain, timezone). Once created, you get a
`site_id` (a uuid), which is what the tracking snippet needs.

> Local dev data lives in `.wrangler/state/` (D1 + the Durable Object).
> Want to populate the dashboard with realistic fake data instead of
> waiting on real traffic? See [Seeding demo data](#seeding-demo-data)
> below.

## Adding the tracking snippet to a site

Every site you track needs the tiny snippet from `public/script.js`
added to its pages. It's ~2KB, cookieless, and posts to `/collect` on
every pageview (plus SPA route changes via `pushState`/`replaceState`).

```html
<script
  defer
  src="https://analytics.example.com/script.js"
  data-site="YOUR_SITE_ID"
></script>
```

- Use `http://localhost:3000/script.js` instead while developing locally.
- `data-site` is the `id` of the site you created (see it in the
  dashboard's site switcher, or `GET /api/sites`).
- That's the whole integration — no cookie banner needed, since nothing
  is stored client-side and visitor identity is derived server-side from
  `IP + User-Agent` (§4 of the spec).

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

`http://localhost:3000/` (or your deployed URL) — one page, a site
switcher + date-range picker (`today` / `7d` / `30d` / `6m` / `1y`) at
the top, stat cards + chart + filterable ranked lists (top/entry/exit
pages, referrers/outbound links/UTM, browser/OS/device type,
country/region/city, and custom events) below. Add more sites any time
from the same page.

Live visitor count (top-left badge) is pushed over a WebSocket from the
site's `LiveVisitors` Durable Object — no polling. Five-minute visitor presence
is persisted in its SQLite storage so the count survives idle eviction and
WebSocket hibernation.

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
- `http://localhost:3000/api/auth/callback/google`

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
`from`/`to` as `YYYY-MM-DD`). Any range that doesn't include "today"
reads exclusively from the `daily_*` rollup tables — never a scan of raw
events, no matter how far back the range goes (§8).

## Daily aggregation

A Cron Trigger (`10 0 * * *`, see `wrangler.jsonc` → `triggers.crons`)
rolls the previous UTC day's raw rows into `daily_summary`/`daily_pages`/
`daily_sources`/`daily_devices`/`daily_locations`/
`daily_outbound_links`/`daily_events` for every site
(`src/lib/aggregate.ts`). It's idempotent (`INSERT ... ON
CONFLICT DO UPDATE`), so re-running it for an already-aggregated day is
safe.

Test it locally by hitting the scheduled handler:

```bash
curl "http://localhost:3000/cdn-cgi/handler/scheduled"
```

## Seeding demo data

For local dev, `scripts/seed-demo-data.mjs` replaces a site's analytics
rows with realistic fake traffic (real referrer domains, real
cities/countries, real browser/OS/device combos, outbound-link clicks, a
fictional SaaS site's pages, and a handful of custom events). The default
matches the dashboard's "Last 30 days" range: 29 complete days of daily
rollups plus raw rows for today.

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
    raw-stats.ts              # aggregates raw tables for "today"
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
