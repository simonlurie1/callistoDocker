# Callisto Mini CRM + Conversion Tracker

A small CRM for leads. When a lead is marked `converted`, the app reports a
conversion event to Callisto's tracker. It's one flow, not two apps:

```
lead created → status changed to converted → outbound conversion request
```

## Stack

| Service | What | Tech |
|---|---|---|
| `db` | Leads + outbound conversion events | MySQL 8.4 |
| `api` | REST API and business rules; records conversions (never calls the tracker to post them) | Node.js 20, TypeScript, Express, Prisma, winston |
| `web` | UI, plus a same-origin reverse proxy to the API | React 18 + Vite, served by nginx |
| `worker` | Scheduled batch service (node-cron, every 5 seconds): claims and posts pending conversions to the tracker, retrying failures with backoff | Node.js 20 (same image as `api`) |
| `mock-tracker` *(optional, `mock` profile)* | Local stand-in for the tracker that can simulate each failure mode | Express |

```
browser ──► web (nginx :8080) ──► /leads, /conversion-events, /health ──► api (:3000) ──► db (MySQL)
                 │                                                            │
                 └── React static files                                       └──► Callisto tracker (HTTPS)
```

The browser only talks to nginx. nginx serves the React build and proxies
the API paths to the `api` container. There's no CORS to configure, and the
React code only uses relative paths (`/leads`, …).

## Quick start

Requires Docker Desktop (or Docker Engine + Compose v2).

```bash
cp .env.example .env
# edit .env and paste your real TRACKER_API_KEY
docker compose up -d --build
```

- UI: **http://localhost:8080**
- API directly: http://localhost:3000 (the same API nginx proxies to)

No manual DB setup is needed. On the first start, MySQL runs
[`db/init.sql`](db/init.sql), which creates the tables. The `api` container
waits until MySQL is healthy before starting.

`init.sql` only runs when the database volume is empty. After changing it,
run `docker compose down -v` (**this deletes all data**) and then `up` again,
so it runs on a fresh database.

### Environment variables (`.env`, git-ignored)

| Var | Purpose |
|---|---|
| `MYSQL_ROOT_PASSWORD`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD` | MySQL container credentials |
| `MYSQL_PORT` | Host port for MySQL (default 3306; change it if you already run MySQL locally) |
| `DATABASE_URL` | Prisma connection string. Uses host `db`, the service name on the compose network |
| `API_PORT`, `WEB_PORT` | Host ports (defaults 3000 / 8080) |
| `TRACKER_BASE_URL` | `https://bipro2interface.sseku.com/api/candidate-tracker` |
| `TRACKER_API_KEY` | Your personal tracker key. **Never commit this.** Only `.env.example` (placeholders) is in git. It is also never logged (see [Logging](#logging)) |

Optional tuning (defaults shown; all have sensible defaults and can be left unset):

| Var | Default | Purpose |
|---|---|---|
| `WORKER_CRON_SCHEDULE` | `*/5 * * * * *` | When the worker runs a batch pass (cron syntax; the optional 6th leading field is seconds). It also runs one pass at startup |
| `WORKER_BATCH_SIZE` | `10` | Max events claimed per pass |
| `WORKER_STALE_AFTER_MS` | `300000` (5 min) | How old an `in_process` claim must be before it's treated as abandoned and reclaimed |
| `TRACKER_TIMEOUT_MS` | `10000` | Per-request timeout for tracker calls |
| `TRACKER_MIN_INTERVAL_MS` | `2100` | Minimum gap between posts, to stay under the tracker's 30 req/min |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |
| `LOG_FORMAT` | `json` | `json` (one object per line) or `pretty` (readable, for local dev) |
| `LOG_MAX_BODY_CHARS` | `4096` | Request/response bodies longer than this are truncated in logs |

## API

All responses are JSON. Errors look like `{"error": "...", "errors": {field: [messages]}}`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/leads?status=&source=` | list, with optional filters |
| `POST` | `/leads` | create |
| `GET` | `/leads/:id` | fetch one |
| `PATCH` | `/leads/:id` | update fields. **Rejects `status`** (400) |
| `DELETE` | `/leads/:id` | delete. 409 if the lead has a conversion event |
| `PATCH` | `/leads/:id/status` | **the only way to change status**. Body: `{"status": "converted"}` |
| `GET` | `/leads/:id/conversion-event` | the stored outbound event (request + response) for a lead |
| `GET` | `/conversion-events` | every outbound event, newest first |
| `GET` | `/conversion-events/tracker-ping` | proxies the tracker's `GET /ping` as a connectivity check |
| `GET` | `/health` | liveness |

### Lead rules

- `name` is required. `email` or `phone` is **always** required, not only before conversion.
- `email` must look like a valid address, and `phone` must be 6–32 characters of digits/spaces/dashes/parentheses with an optional leading `+`. This matches the tracker's own limits, so bad contact data is rejected when it's saved rather than failing the conversion permanently later.
- `amount` must be a number greater than 0. `currency` must be in a supported ISO 4217 allowlist and is uppercased on save. `amount` and `currency` must be sent together.
- `PATCH /leads/:id`: an omitted field keeps its value, and a field sent as `null` or `""` is cleared. The merged result must still pass these rules, so you can't clear the last contact.
- Converting requires contact + `amount` + `currency` (422 otherwise).
- A `lost` lead cannot be converted (409).
- Converting an already-`converted` lead is allowed: it re-sends the same `event_id`, and the tracker replies `duplicate: true`.

## Outbound conversion design

The assignment rules out calling the tracker from the controller as
fire-and-forget. This app goes a step further: **the HTTP request never
calls the tracker at all.** It only records the conversion; a separate
periodic **worker** service does the posting. This is a proper outbox
relay, not just "persist-then-send-inline":

1. **Persist.** When a lead becomes `converted`
   (`LeadService.changeStatus` → `ConversionService.recordConversion`), a
   `conversion_events` row is written (or the existing one re-queued) with
   `status = pending` and the exact outbound JSON in `request_body`. The API
   response returns immediately with the event still `pending` — no network
   call has happened yet.
2. **Scan.** The `worker` service (its own container, `api/src/jobs/conversionWorker.ts`)
   runs a batch pass on a **node-cron** schedule — every 5 seconds by
   default (`WORKER_CRON_SCHEDULE`) — plus once at startup, so a new
   conversion reaches the tracker within seconds. The schedule only decides
   how often the table is checked; how long a *failed* event waits is
   decided per event by the backoff in step 5. Overlapping passes are
   prevented (`noOverlap`): if one ever runs past the next tick, that tick is
   skipped. Each pass first repairs any orphaned conversions (see
   [Failure scenarios](#failure-scenarios-during-posting)), then asks the
   repository for events that need posting: `pending`, `failed` with a due
   `next_retry_at`, or `in_process` whose claim has gone stale (see step 3).
3. **Claim.** Before posting, the worker marks the event `in_process` and
   sets `processing_started_at` to now — in one atomic conditional `UPDATE`
   (`PrismaConversionEventRepository.claimForPosting`), so if several workers
   run at once, exactly one of them wins each row. This is what lets the
   service scale horizontally (`docker compose up -d --scale worker=3`)
   without posting the same conversion twice.
4. **Post & record.** The worker posts the claimed event and writes the
   outcome — `status` becomes `sent` or `failed`, plus `response_status`,
   `response_body`, `attempts`, `last_attempt_at` — and clears
   `processing_started_at`, releasing the claim. A reviewer can see exactly
   what was sent and what came back (`GET /conversion-events`, or the UI's
   "Conversion" button, which polls while an event is `pending`/`in_process`).
   Recording is **fenced** by the claim: it only succeeds if
   `processing_started_at` still holds the value this worker's claim set
   (see scenario 10 below).
5. **Retryable failures** (network error, a 10s timeout, `5xx`, `429`/`408`,
   or a response that doesn't match the documented shapes) go back to
   `failed` with `next_retry_at` set by exponential backoff — 10s → 30s →
   2m → 10m → 30m → 1h, then hourly — with ±20% jitter so events that failed
   together (an outage) don't all retry at the same instant
   (`api/src/lib/backoff.ts`). Short early steps recover a brief blip in
   seconds; the 1h cap keeps a long outage from hammering the tracker's
   30 req/min limit. If the tracker sends a `Retry-After` header (e.g. with a
   `429`), that delay is used instead, capped at 1h. A later pass picks the
   event up once due. The two documented
   rejections — `422` (validation) and `401` (bad key) — are **not** retried,
   since resending the same request can't fix them; they stay visible with
   `next_retry_at = null` and are logged as errors needing a human.
6. **Crash recovery.** If a worker dies mid-post, its claimed event is stuck
   `in_process` with no one to finish it. Once `processing_started_at` is
   older than `WORKER_STALE_AFTER_MS` (default 5 minutes — comfortably more
   than a rate-limit wait plus the 10s tracker timeout), a later pass treats
   it as due again and reposts it. This is safe because the `event_id` never
   changes, so a genuinely-delivered-but-unmarked event just gets
   `duplicate: true` back.

`duplicate: true` (HTTP 200) counts as success. A pass can also be triggered
on demand (a script, an ops fix). It posts only what is already due — it
doesn't skip a failed event's backoff wait — and is safe to run while the
worker is running, since events are claimed before posting:
```bash
docker compose exec api npm run process-conversions
```

Concurrent converts of the same lead (e.g. a double-click) are safe the same
way: `lead_id` is unique on `conversion_events`, so only one insert wins and
the other request reuses that row. Attempt counts increment atomically.

### Why a separate worker, and a table instead of a queue broker

The assignment allows "a queue, a table + retry command, or an
equivalent." A table with atomic claim-by-update already gives the
guarantees a broker would give here — durable persistence before any send,
exactly-one-claimant delivery, retry with backoff, safe horizontal scaling —
without an extra service (Redis/BullMQ, Kafka) to run and explain. Splitting
the scan/claim/post loop into its own `worker` container (rather than firing
it inline from the HTTP handler) is what actually makes "the API never talks
to the tracker" true, and is what makes running more than one poster safe.

### Idempotency and `event_id`

There is one event row per lead (`lead_id` is unique). Its `event_id` is
generated **once**, as `conv_{lead_id}_{8 random hex chars}`, and stored.
Every later attempt (retry, re-convert, a second `PATCH …/status`) reuses
that row and resends the exact same `event_id`.

**Why not bare `conv_{lead_id}`, as in the assignment's example?** Lead IDs
restart at 1 whenever the DB is reset or another environment is created,
but the tracker's dedup is per API key and permanent. With bare
`conv_{lead_id}`, a brand-new lead #1 on a fresh DB gets `duplicate: true`
for a conversion the tracker never actually received from it. This really
happened while building this: the key had already sent `conv_1`…`conv_5`
from an earlier database. The random suffix keeps the ID stable per
conversion and unique across environments.

### Failure scenarios during posting

Every scenario below was reproduced against the running stack (using the
mock tracker's failure modes and by stopping/killing containers), not just
reasoned about. Nothing in this table loses a conversion or double-counts one
at the tracker.

| # | What goes wrong | What happens | Where |
|---|---|---|---|
| 1 | Tracker unreachable (DNS, refused, network down) | `failed`, `http = null`, `last_error` set, retried with backoff | `HttpConversionTracker.send` |
| 2 | Tracker hangs | Aborted after `TRACKER_TIMEOUT_MS` (10s), treated like 1 | `AbortSignal.timeout` |
| 3 | Tracker returns `5xx` | `failed`, retried with backoff | `classify()` |
| 4 | Tracker returns `429` (rate limit) / `408` | Same as 3, but a `Retry-After` header, if sent, sets the wait. Posts are also throttled to ~28/min per worker to avoid it | `classify()`, `parseRetryAfter()`, `throttle()` |
| 5 | Tracker returns `401` (bad/expired key) | `failed`, **not** retried; logged as an error that names `TRACKER_API_KEY`, since it affects every conversion, not one record | `classify()`, `logBatchResult` |
| 6 | Tracker returns `200` with a body that isn't the documented `duplicate:true` JSON (e.g. an HTML page from a proxy) | Treated as retryable, not as success or as a permanent failure — we can't tell whether it was delivered, and retrying is harmless (`event_id` dedupes) | `classify()` |
| 7 | Database down when a pass starts | The pass fails and is logged; the worker process keeps running and the next tick retries. No restart needed | `conversionWorker.ts` |
| 8 | Database down **while a record is `in_process`** (the tracker may even have accepted it) | Recording the outcome fails; that error is isolated and the rest of the pass continues. The row stays `in_process`, is reclaimed once stale, and reposted — the tracker answers `duplicate: true` if it already had it | `ConversionBatchService.runOnce`, reclaim |
| 9 | Worker crashes / is `SIGKILL`ed mid-post | Row left `in_process`; reclaimed once stale (6 above) and reposted idempotently | reclaim in `needsPosting()` |
| 10 | A worker's claim goes stale while its post is still in flight, another worker reclaims and posts, then the first one's response arrives | The first worker's write is **rejected by the fencing check** (`processing_started_at` no longer matches its claim) and logged as a lost claim; the second worker's result stands, attempts aren't double-counted | `recordAttempt(id, claimedAt, …)` |
| 11 | Crash between setting a lead to `converted` and creating its conversion event (two separate writes) | Each pass looks for `converted` leads with no event and creates the missing one, which is then posted in the same pass | `reconcileOrphanedConversions` |
| 12 | Worker is stopped (`SIGTERM`, e.g. a deploy) mid-post | Stops the schedule, lets the in-flight post finish, claims nothing new, exits 0. `stop_grace_period: 20s` covers the worst case (rate-limit wait + timeout) | `shutdown()`, compose |

Multiple worker replicas racing for the same rows are covered by the atomic
claim (step 3 above).

## Logging

All three processes (`api`, `worker`, and the one-off `process-conversions`)
log through one [winston](https://github.com/winstonjs/winston) logger
(`api/src/lib/logger.ts`), as one JSON object per line on stdout:

```bash
docker compose logs -f api worker
LOG_FORMAT=pretty docker compose up -d api worker   # human-readable instead of JSON
```

- **Incoming requests and responses** (`api/src/middleware/requestLogger.ts`):
  every request is logged on arrival (method, URL, client IP, headers) and
  again when the response is sent (status, duration, the request body, the
  response body). The middleware runs before body parsing, so even a request
  whose JSON is malformed is logged, with its raw text.
- **Errors returned to clients**: responses with `4xx` are logged at `warn`,
  `5xx` at `error`, with the exact error body the client received and the
  exception that produced it (`ValidationError`, `NotFoundError`, ...). For an
  unexpected `500`, the real error and stack trace are logged too (the client
  only gets a generic message).
- **Outgoing tracker calls** (`HttpConversionTracker`): every request (method,
  URL, headers, body) and every response (status, headers, body, duration,
  classified outcome) — or, when no response arrives, whether it timed out or
  the connection failed.
- **Correlation**: every line written while handling an HTTP request carries
  its `requestId` (taken from nginx's `X-Request-Id`, and echoed back in the
  response); every line from a batch pass carries its `passId`. This includes
  the tracker calls made deep inside the services, via `AsyncLocalStorage` —
  so a request or a pass can be followed end to end with one filter.
- **Secrets**: `Authorization` (the tracker API key), `Cookie`, and similar
  headers are replaced with `[REDACTED]` in both directions. Bodies over
  `LOG_MAX_BODY_CHARS` are truncated. Note that request and response bodies
  include lead contact details (email/phone), so log access should be
  treated like database access.

## Assumptions

Where the tracker doc was silent, per "document the assumption":

1. **`currency` is required together with `amount`.** An amount without a
   currency is meaningless to the tracker.
2. **Re-converting a `converted` lead re-sends the event.** This is what
   makes suggested test #3 ("convert the same lead again → `200` +
   `duplicate: true`") reproducible through the app.
3. **`event_name` is always `"purchase"`.** It's optional and nothing in the
   lead model maps to a more specific name.
4. **`occurred_at` is set once, at first send,** and not regenerated on
   retries. It records when the conversion happened.
5. **`currency` is checked against ~27 common ISO 4217 codes**
   (`api/src/lib/constants.ts`), not the full ~180-code list.
6. **`event_id` carries a random suffix.** See above.
7. **A lead with a conversion event can't be deleted (409).** Deleting it
   would erase the delivery audit trail.

## Verifying it works

With the stack up, run the end-to-end check (Node 18+, no dependencies):

```bash
node scripts/e2e.mjs
```

It runs 63 checks through nginx against the real tracker and exits
non-zero on any failure: validation, CRUD (including clearing fields), the
status rules, that converting only records a `pending` event, suggested
tests #1–#3, `event_id` reuse, and a concurrent double-convert. Rather than
wait for the worker's next tick, it triggers passes itself
with `docker compose exec api npm run process-conversions` (override with
`E2E_TRIGGER_PASS`). Every run creates a few leads and sends a few
conversions, well under the rate limit. The failure paths need the mock
tracker; see [Testing failures with the mock tracker](#testing-failures-with-the-mock-tracker).

## Reproducing the suggested test sequence

**Through the UI** (http://localhost:8080): create a lead with an email,
amount, and currency. Set its status to `converted` — the panel shows
`status: "pending"` and keeps polling. The worker posts it on its next pass
(within ~5 seconds) and the panel switches to `responseStatus: 201` on its
own. Set it to `converted` again and, once
posted, you get `200` with `"duplicate": true`, same `eventId`.

**Through curl:**

```bash
curl -s http://localhost:8080/conversion-events/tracker-ping                  # 1. 200

curl -s -X POST http://localhost:8080/leads -H "Content-Type: application/json" \
  -d '{"name":"Dana Cohen","email":"dana@example.com","amount":199.5,"currency":"USD"}'

curl -s -X PATCH http://localhost:8080/leads/1/status -H "Content-Type: application/json" \
  -d '{"status":"converted"}'                                     # returns status: "pending"

sleep 5                                                          # the worker posts it on its next pass

curl -s http://localhost:8080/leads/1/conversion-event             # 2. status: "sent", responseStatus: 201

curl -s -X PATCH http://localhost:8080/leads/1/status -H "Content-Type: application/json" \
  -d '{"status":"converted"}'                                     # re-queues: back to "pending"

sleep 5
curl -s http://localhost:8080/leads/1/conversion-event             # 3. 200 duplicate:true, same event_id
```

Test #4 (no email/phone → 422) can't reach the tracker through the app,
because the app refuses such a lead earlier (its own 422). Tests #4 and #5
against the tracker itself are in the Postman collection's last folder.

**Postman:** import
[`postman/callisto-crm.postman_collection.json`](postman/callisto-crm.postman_collection.json),
set `tracker_api_key` if you want the direct-tracker folder, and run the
folders top to bottom. Before each "once the worker posted it" request, wait
~5 seconds for the worker (or run
`docker compose exec api npm run process-conversions`).

## Testing failures with the mock tracker

The real tracker only fails when a request sends `simulate`, and the app
never forwards that. The bundled mock can simulate each failure mode
instead, set with `MOCK_TRACKER_BEHAVIOR`:

| Behavior | POST /conversions answers |
|---|---|
| `normal` | 201, then 200 `duplicate:true` (as documented) |
| `server_error` | 500 |
| `rate_limited` | 429 with `Retry-After: 30` (the retry is scheduled ≈ +30s instead of by the backoff) |
| `garbled_ok` | 200 with an HTML body instead of the documented JSON |
| `hang` | never answers (exercises the timeout) |
| `slow_first` | holds the first request per `event_id` for `MOCK_TRACKER_SLOW_MS` (8s), answers later ones at once (for racing a stale claim) |

Start it and point the `worker` at it. Since the worker posts within
seconds, it has to be the one talking to the mock — otherwise it would post
your test conversion to the real tracker first. Variables set on the
command line override `.env` for the recreated container only:

```bash
MOCK_TRACKER_BEHAVIOR=server_error docker compose --profile mock up -d --build mock-tracker
TRACKER_BASE_URL=http://mock-tracker:4000/api/candidate-tracker TRACKER_API_KEY=dev-mock-key \
  docker compose up -d --no-deps --force-recreate worker

# convert a lead through the UI or the api as usual; within ~5s:
# -> event "failed", http 500, retry scheduled ≈ +10s (then 30s, 2m, …)

# switch the mock back to normal; the next due retry succeeds:
MOCK_TRACKER_BEHAVIOR=normal docker compose --profile mock up -d --force-recreate mock-tracker
# -> attempt #N, status "sent", http 201, same event_id

# done: put the worker back on the real tracker (.env) and remove the mock
docker compose up -d --no-deps --force-recreate worker
docker compose --profile mock rm -sf mock-tracker
```

PowerShell: set the two variables with `$env:NAME = "value"` first, and
`Remove-Item Env:NAME` before restoring the worker.

## Local development without Docker

```bash
docker compose up -d db                     # just MySQL (creates the tables on first start)
cd api && npm install
# api/.env: DATABASE_URL=mysql://callisto:callisto_dev_password@localhost:3306/callisto + TRACKER_* vars
LOG_FORMAT=pretty npm run dev               # :3000 — api only; nothing posts conversions without the worker
LOG_FORMAT=pretty npm run dev:worker        # in another terminal — runs a pass now, then every 5s
cd ../web && npm install && npm run dev     # :5173, Vite proxies API paths to :3000
```

## Project layout

```
db/init.sql            creates the tables (run by MySQL on first start)
api/
  prisma/schema.prisma describes the same tables for Prisma's typed client (keep in sync with init.sql)
  src/routes/          HTTP layer: request parsing/format checks, response presenters, error → status mapping (app.ts)
  src/services/        business logic only (lead rules, outbox flow, retry policy); depend only on interfaces
  src/domain/          Lead / ConversionEvent types and domain errors (no HTTP status codes)
  src/repositories/    LeadRepository, ConversionEventRepository interfaces
  src/repositories/prisma/  Prisma implementations — the only code that imports @prisma/client
  src/tracker/         ConversionTracker interface; http/ is the only code that knows the tracker's
                       URL, API key and status codes (translated into accepted / duplicate / retryable / permanent)
  src/container.ts     composition root: wires Prisma + HTTP tracker + logger into the services
  src/middleware/      requestLogger: logs every incoming request and its response
  src/lib/             logger (winston: context, redaction, truncation), backoff policy, constants
  src/jobs/            conversionWorker.ts (the `worker` service: node-cron schedule);
                       processConversionEvents.ts (the same batch pass, run once on demand);
                       logBatchResult.ts (how a pass's outcome is logged, shared by both)
  src/dev/             mock tracker (simulates each failure mode)
web/
  src/                 React app (components/, api.ts, types.ts)
  nginx.conf           static files + reverse proxy (re-resolves "api" via Docker DNS)
scripts/e2e.mjs       end-to-end check of the running stack
docker-compose.yml
postman/
```

## Out of scope

Per the assignment: multi-brand, roles, billing, real Facebook/Stripe/Google
integrations, pixel-perfect frontend.
