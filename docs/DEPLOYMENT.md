# Deployment

SEO OS runs as two services from one repository, sharing one Supabase project.

| Service    | What it is                                 | Config file           | Start command    |
| ---------- | ------------------------------------------ | --------------------- | ---------------- |
| **web**    | The Next.js app: UI, Server Actions, OAuth | `railway.json`        | `npm run start`  |
| **worker** | The job runner: daily syncs, detection     | `railway.worker.json` | `npm run worker` |

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
- `diagnosis.run` - one page diagnosis, requested from the app when the web
  service has `DIAGNOSIS_RUNNER=queue`. The worker runs it as the person who
  asked (their membership is re-checked at run time) and closes the request;
  the app follows the request row until the diagnosis exists. Without the
  setting, a diagnosis runs inside the web request as before.

The worker acts as a fixed system user (`system@seo-os.invalid`, created on
first run). Audit events written by jobs name that user as the actor. Its
organization membership exists only in memory for the duration of a job; it is
never a member anyone can list, and no sign-in can resolve to it.

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
own record of each pull is still `sync_run`, exactly as when a person presses
"Sync now".

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
