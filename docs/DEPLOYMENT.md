# Deployment

SEO OS runs as two services from one repository, sharing one Supabase project.

Current stable commit: the head of `main`. As of P4 M6.1 the schema is at 28
migrations; `npx prisma migrate status` should say the database is up to date
before and after a deploy. Deploys from `main` are manual: press Deploy in
the Railway dashboard. The web service runs `prisma migrate deploy` before
each deploy, and the health check is `/api/health`.

A migration that has been applied to this database is history. Never edit its
file or repair its recorded checksum afterwards; correct it with a new
follow-up migration instead.

| Service    | What it is                                         | Config file           | Start command    |
| ---------- | -------------------------------------------------- | --------------------- | ---------------- |
| **web**    | The Next.js app: UI, Server Actions, OAuth         | `railway.json`        | `npm run start`  |
| **worker** | The job runner: daily syncs, "Sync now", detection | `railway.worker.json` | `npm run worker` |

**Both services are required in production.** Since the sync hardening,
"Sync now" on Data Health no longer pulls from Google inside the web request;
it queues a job that only the worker runs. A deployment with the web service
alone still serves every page, but every "Sync now" waits in the queue until
a worker exists. Railway does not start two processes from one service, so the
worker is a second service (below), not a flag on the first.

Only the web service runs migrations (`prisma migrate deploy` before each deploy).
The worker never changes the application schema; pg-boss creates and maintains
its own `pgboss` schema on first start.

## The worker

`npm run worker` starts `src/server/jobs/worker.ts`: it opens the queue in
Postgres (pg-boss over `DIRECT_URL`), registers the job handlers, and installs
the daily schedule. There is no HTTP server and no health-check URL; Railway
restarts it if it exits.

Jobs (docs/P1_SPEC.md section 23):

- `sync.daily` - fires on `SYNC_DAILY_CRON` (default `0 3 * * *`, UTC) and
  enqueues one `website.sync` per active, non-demo website, a few seconds apart.
- `website.sync` - for one website: Search Console, GA4, Semrush and Ahrefs
  where each is CONNECTED, every registered sitemap, then signal and
  opportunity detection. A provider that fails is recorded in the job's
  summary; the rest of the steps still run. Anything unexpected fails the job,
  which pg-boss retries (3 attempts, backing off from 10 minutes).
- `connection.sync` - one provider (Search Console or GA4) for one website,
  queued when a person presses "Sync now". The web request only checks that
  the person may ask and that nothing is already queued or running for that
  source, then enqueues; the worker pulls, finalises the `sync_run`, advances
  freshness only on success, and re-runs signal detection. Retried twice
  (after 10 and then 20 minutes) when the provider was busy or unreachable or
  the run could not finalise; not retried for a bad credential, a missing
  property, a revoked permission or an exhausted quota. The job heartbeats
  every 30 seconds, so one whose worker died is released for retry within
  about two minutes rather than at the two-hour ceiling, and a run whose job
  is still heartbeating is never mistaken for an orphan, however long it runs.
- `diagnosis.run` - one page diagnosis, requested from the app when the web
  service has `DIAGNOSIS_RUNNER=queue`. The worker runs it as the person who
  asked (their membership is re-checked at run time) and closes the request;
  the app follows the request row until the diagnosis exists. Without the
  setting, a diagnosis runs inside the web request as before.

The worker acts as a fixed system user (`system@seo-os.invalid`, created on
first run). Audit events written by jobs name that user as the actor. Its
organization membership exists only in memory for the duration of a job; it is
never a member anyone can list, and no sign-in can resolve to it.

## "Sync now" runs on the worker

What a press of the button does now:

```text
browser -> server action: check role, website and connection; refuse if a run is
           already in flight or a job already waiting; enqueue connection.sync
        <- "Sync queued" at once
worker  -> claims the job, claims or creates the sync_run (retiring a stale one
           first), pulls from the provider, writes rows, finalises the run,
           advances lastSyncedAt / latestDataDate only on SUCCEEDED or PARTIAL,
           re-runs signal detection
```

Data Health's **Latest attempt** column follows it: `Queued since HH:MM` (with
a note after two minutes if nothing has picked it up), `Sync starting`,
`Syncing since HH:MM`, then `Succeeded`, `Partial`, `Failed · code`, or
`Interrupted` for a run whose process died. Reload the page to see the next
state; there is no live channel and none is needed for a sync that takes
minutes.

Pressing the button again while a sync is queued or running does not start a
second one: the request says so, and the queue's own singleton rule catches a
click that races it. The sync service's `already_running` check remains the
final authority underneath both.

**Startup order.** The worker creates the `pgboss` schema and its queues on
first start. Deploy or restart the worker before relying on "Sync now" from a
freshly deployed web service: a web service whose queue schema does not exist
yet answers the button with "The sync could not be queued. The worker service
may not be running." and creates no run. A web service deployed with a new
queue name before the worker is redeployed can still enqueue - it creates the
queue it needs - and the job waits for the worker.

**Shutdown.** On SIGTERM the worker stops claiming jobs and gives the one in
flight up to 60 seconds to finish. Set the service's stop grace period on
Railway to at least that long if the setting is available; if the platform
kills the process sooner, nothing is lost: the job's heartbeat lapses, pg-boss
releases it for retry within about two minutes, the next attempt retires the
orphaned `sync_run` as `stale_run_recovered`, and the pull starts again from
the beginning. Metric rows are written with deterministic upserts on their
documented grain, so a restarted pull rewrites the same rows rather than
duplicating them, and freshness moves only when a pull completes.

**Verifying after a deploy.**

1. Worker logs show `{"at":"worker","event":"started", ... "queues":[...]}`
   with `connection.sync` among the queues.
2. On Data Health for a website with Search Console connected, press
   **Sync now**. The page should answer "Sync queued" within a second.
3. Reload: the Latest attempt column reads `Queued since`, then `Syncing since`
   within a few seconds. If it still reads `Queued since` after two minutes the
   page says so - the worker is not running or cannot reach the database.
4. Worker logs show `{"at":"connection.sync","event":"completed", ...}` with
   `status`, `runId`, `written` and `actor`; Data Health shows `Succeeded` and
   a Latest data date; Recent runs shows the run with its counts.
5. Press the button again immediately: "A sync for this source is already
   queued" or "already running", and no second run appears.

## Railway: adding the worker service

The web service already exists. The worker is a second service on the same
project, built from the same GitHub repository.

1. In the project, **+ New** -> **GitHub Repo** -> choose the `seo-os`
   repository again. Railway creates a second service.
2. Rename it `worker` (Settings -> Service name).
3. Settings -> **Config-as-code** -> set the file path to `railway.worker.json`.
   This gives it its own build and start commands and no health check.
4. Variables -> add the same values the web service has for:

   ```
   DATABASE_URL
   DIRECT_URL
   CREDENTIAL_ENCRYPTION_KEY
   GOOGLE_CLIENT_ID
   GOOGLE_CLIENT_SECRET
   ```

   The quickest way is to reference them: a variable's value can be
   `${{web.DATABASE_URL}}` (using your web service's name), so there is one
   copy to rotate. Optional, worker-only:

   ```
   SYNC_DAILY_CRON=0 3 * * *
   SYNC_ON_START=1
   ```

   `SYNC_ON_START=1` runs the daily fan-out once as soon as the worker starts,
   so the first deploy can be checked without waiting for 03:00. Remove it after.

   For queued diagnoses, the worker also needs the web service's
   `ANTHROPIC_API_KEY` and `AI_*` values, and the **web** service needs
   `DIAGNOSIS_RUNNER=queue`. Set that last one only once the worker is up:
   with it set and no worker, a diagnosis request waits, and the request page
   says so after two minutes.

5. Deploy. The logs should show one line like:

   ```
   {"at":"worker","event":"started","cron":"0 3 * * *","schema":"pgboss","pid":...}
   ```

   and, with `SYNC_ON_START=1`, a `sync.daily` completion followed by one
   `website.sync` completion per website, each with its step summary.

Set the worker to one replica. Two workers would not corrupt anything - pg-boss
hands each job to exactly one of them - but two schedulers is one more than
needed, and the sync services already refuse to run the same window twice.

## Checking the queue

In Supabase's SQL editor:

```sql
select name, state, retry_count, created_on, completed_on, output
from pgboss.job
order by created_on desc
limit 50;
```

`state` is `created` (waiting), `active`, `completed`, `retry`, or `failed`.
`output` holds the job's summary, or the error that failed it. The application's
own record of each pull is still `sync_run`; a manual sync is the
`connection.sync` job plus the `sync_run` it claimed.

Is the worker running, and is it keeping up? Three questions, three queries:

```sql
-- Backing up: jobs waiting longer than the worker's polling interval allows.
select name, count(*), min(created_on) as oldest
from pgboss.job
where state in ('created', 'retry') and start_after < now() - interval '2 minutes'
group by name;

-- Claiming: anything active right now, and whether its heartbeat is fresh.
select name, id, started_on, heartbeat_on, now() - heartbeat_on as silence
from pgboss.job
where state = 'active';

-- The last thing that failed, and why (our own summary; never provider output).
select name, completed_on, output
from pgboss.job
where state = 'failed'
order by completed_on desc
limit 10;
```

An empty first result and a `started` line in the worker logs means it is
alive and idle. Rows in the first result with nothing in the second means no
worker is claiming. A `silence` over a minute in the second means the worker
that held that job is gone; pg-boss releases the job shortly after.

## Running the worker locally

```
npm run worker:dev
```

reads `.env.local` and runs against the same database as `npm run dev`. It uses
the schema in `PGBOSS_SCHEMA` (default `pgboss`), so a local worker and a
deployed one pointed at the same database would share a queue; set
`PGBOSS_SCHEMA=pgboss_local` locally if both need to run at once.

Ctrl+C stops it gracefully: the job in flight finishes (up to a minute), then
the process exits.

## Environment variables by service

| Variable                        | web |        worker         |
| ------------------------------- | :-: | :-------------------: |
| `DATABASE_URL`                  | yes |          yes          |
| `DIRECT_URL`                    | yes |          yes          |
| `CREDENTIAL_ENCRYPTION_KEY`     | yes |          yes          |
| `GOOGLE_CLIENT_ID`              | yes |          yes          |
| `GOOGLE_CLIENT_SECRET`          | yes |          yes          |
| `NEXT_PUBLIC_APP_URL`           | yes |           -           |
| `NEXT_PUBLIC_SUPABASE_URL`      | yes |           -           |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes |           -           |
| `ANTHROPIC_API_KEY` and `AI_*`  | yes | with queued diagnoses |
| `DIAGNOSIS_RUNNER`              | opt |           -           |
| `SYNC_DAILY_CRON`               |  -  |          opt          |
| `SYNC_ON_START`                 |  -  |          opt          |
| `PGBOSS_SCHEMA`                 |  -  |          opt          |

`NEXT_PUBLIC_APP_URL` is the **public** address (`https://<service>-production-xxxx.up.railway.app`, or your own domain) - never `*.railway.internal`, which is Railway's private network. It is the return address handed to Google and Supabase, and like every `NEXT_PUBLIC_` value it is baked in at build time, so redeploy after changing it.

`DIAGNOSIS_RUNNER` is blank (inline) by default: a diagnosis runs inside the
web request, which needs no worker. Set it to `queue` on the web service to
hand diagnoses to the worker, which then needs the AI variables too.

## The test suite's transaction budget

Nothing in this section applies to a deployed service.

The test suite runs about a hundred files in parallel against the shared
Supabase project, each building whole tenants inside interactive transactions.
Measured from a developer machine, a round trip is 61ms at the median and
319ms at the ninetieth percentile under that load, and a healthy tenant
transaction was measured taking six to twelve seconds. Prisma's defaults give
an interactive transaction two seconds to start and five to finish, so tests
failed on the stopwatch, in unrelated suites, and passed alone.

Under `NODE_ENV=test` only, the Prisma client is constructed with a larger
budget: 10 seconds to acquire a connection, 30 seconds to run. The values live
in `src/server/db/transaction-budget.ts` and can be overridden for an
experiment with `PRISMA_TEST_TRANSACTION_MAX_WAIT_MS` and
`PRISMA_TEST_TRANSACTION_TIMEOUT_MS`; a value that is not a positive whole
number of milliseconds falls back to the default for that value. In every
other environment the option is absent and Prisma's defaults stand. This is a
change to how patient the suite is, not to what any product transaction does.

The same file caps how many connections a test client may open: three for the
shared client, one for a test-only client on `DIRECT_URL` (two for
`database.test.ts`, which issues concurrent reads). pg defaults to ten per
pool, and twelve workers at ten each exhausted the pooler with
`unable to check out connection from the pool after 15000ms`. Overridable
with `PRISMA_TEST_POOL_MAX` and `PRISMA_TEST_DIRECT_POOL_MAX`. Outside test
no maximum is passed and pg's default stands.

Fixture tenants are recorded in a ledger the moment they are created and
swept by the run's global teardown, so a run that is killed does not leave
them behind; see `tests/helpers/teardown.ts`.

## The investor demo data

Nothing seeds itself. The demo data is created by hand, on the demo website
only, by running the seeds in order against the shared database:

```bash
DEMO_OWNER_EMAIL=<the demo owner's email> npm run db:seed:demo      # P0
DEMO_OWNER_EMAIL=<the demo owner's email> npm run db:seed:demo:p1
DEMO_OWNER_EMAIL=<the demo owner's email> npm run db:seed:demo:p2
DEMO_OWNER_EMAIL=<the demo owner's email> npm run db:seed:demo:p3
DEMO_OWNER_EMAIL=<the demo owner's email> npm run db:seed:demo:p4
```

The P4 seed is the one that matters for M5. It is deterministic: run it twice
and the visible state is the same. It resets only the work items and the
recommendations it owns on the demo website, and it refuses to run against a
website that is not marked as a demo - `thecreativeseo.com` among them. AI
runs and evidence packages from earlier work are left alone as history.

It writes through the real services with a stub provider, so no API key is
needed to seed, and the three M5 stories it leaves are:

| Story                 | Where it ends           | What it shows                                                                                    |
| --------------------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| Refresh               | Approved for CMS        | QA passed with warnings, measured and judged findings, a person's approval on one exact revision |
| Export                | QA blocked              | A claim whose approved fact was withdrawn: a measured, blocking finding                          |
| Title and description | Awaiting final approval | A check that could not run at all, waiting on a person to accept it                              |

Semantic QA needs `ANTHROPIC_API_KEY` on the web service. Without it the
deterministic checks still run and the judged ones are recorded as not
checked, with the reason - the product works, and says what it could not do.

## History-preserving tables

Some rows are immutable at the database, by trigger: approved
`business_context_version` rows (P0), approved `content_brief` versions, every
`content_revision`, decided `content_draft_review` and `publish_approval` rows, every `execution_step`,
every `content_qa_result`, completed `content_qa_run` rows and `content_cms_approval` rows
(P4). Updates are refused. Deletes are refused too - which also stops an
organization that holds such history from being deleted by cascade. That is
deliberate. To tear one down on purpose, say so inside the same transaction:

```sql
BEGIN;
SET LOCAL app.allow_approved_context_delete = 'on';
DELETE FROM organization WHERE id = '...';
COMMIT;
```

The setting is transaction-scoped and the application never sets it.
