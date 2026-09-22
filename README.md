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
| `api` | REST API, business rules, tracker integration, retry command | Node.js 20, TypeScript, Express, Prisma |
| `web` | UI, plus a same-origin reverse proxy to the API | React 18 + Vite, served by nginx |
| `worker` | Periodic batch service: scans, claims, and posts pending conversions to the tracker | Node.js 20 (same image as `api`) |
| `mock-tracker` *(optional, `mock` profile)* | Local stand-in for the tracker, for testing retries | Express |

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
| `TRACKER_API_KEY` | Your personal tracker key. **Never commit this.** Only `.env.example` (placeholders) is in git |

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
   polls every 2s (`WORKER_POLL_INTERVAL_MS`). Each pass asks the repository
   for events that need posting: `pending`, `failed` with a due
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
5. **Retryable failures** (network error, a 10s timeout, `5xx`, or
   `429`/`408`) go back to `failed` with `next_retry_at` set by exponential
   backoff (1m → 5m → 15m, capped). The next scan picks them up once due.
   `4xx` failures (422 validation, 401 auth) are **not** retried — retrying
   won't fix them — and stay visible with `next_retry_at = null`.
6. **Crash recovery.** If a worker dies mid-post, its claimed event is stuck
   `in_process` with no one to finish it. Once `processing_started_at` is
   older than `WORKER_STALE_AFTER_MS` (default 5 minutes — comfortably more
   than a rate-limit wait plus the 10s tracker timeout), another scan treats
   it as due again and reposts it. This is safe because the `event_id` never
   changes, so a genuinely-delivered-but-unmarked event just gets
   `duplicate: true` back.

`duplicate: true` (HTTP 200) counts as success. A one-off pass can also be
triggered by hand instead of waiting for the poll loop:
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

It runs 57 checks through nginx against the real tracker and exits
non-zero on any failure: validation, CRUD (including clearing fields), the
status rules, suggested tests #1–#3, `event_id` reuse, and a concurrent
double-convert. Every run creates a few leads and sends a few conversions,
well under the rate limit. The 5xx → retry path needs the mock tracker; see
[Testing retries with the mock tracker](#testing-retries-with-the-mock-tracker).

## Reproducing the suggested test sequence

**Through the UI** (http://localhost:8080): create a lead with an email,
amount, and currency. Set its status to `converted` — the panel shows
`status: "pending"` and polls automatically until the worker posts it
(usually within ~2s), then shows `responseStatus: 201`. Set it to
`converted` again and, once posted, you get `200` with `"duplicate": true`,
same `eventId`.

**Through curl:**

```bash
curl -s http://localhost:8080/conversion-events/tracker-ping                  # 1. 200

curl -s -X POST http://localhost:8080/leads -H "Content-Type: application/json" \
  -d '{"name":"Dana Cohen","email":"dana@example.com","amount":199.5,"currency":"USD"}'

curl -s -X PATCH http://localhost:8080/leads/1/status -H "Content-Type: application/json" \
  -d '{"status":"converted"}'                                     # returns status: "pending"

sleep 3   # the worker posts it (poll every 2s by default)

curl -s http://localhost:8080/leads/1/conversion-event             # 2. status: "sent", responseStatus: 201

curl -s -X PATCH http://localhost:8080/leads/1/status -H "Content-Type: application/json" \
  -d '{"status":"converted"}'                                     # re-queues: back to "pending"

sleep 3
curl -s http://localhost:8080/leads/1/conversion-event             # 3. 200 duplicate:true, same event_id
```

Test #4 (no email/phone → 422) can't reach the tracker through the app,
because the app refuses such a lead earlier (its own 422). Tests #4 and #5
against the tracker itself are in the Postman collection's last folder.

**Postman:** import
[`postman/callisto-crm.postman_collection.json`](postman/callisto-crm.postman_collection.json),
set `tracker_api_key` if you want the direct-tracker folder, and run the
folders top to bottom.

## Testing retries with the mock tracker

The real tracker only returns 5xx when a request sends `simulate`, and the
app never forwards that. To exercise the app's own retry path end to end,
start the bundled mock with forced 500s and point the **worker** at it
(it's the worker that posts, not the api). Shell env vars override `.env`:

```bash
MOCK_TRACKER_FORCE_500=true \
TRACKER_BASE_URL=http://mock-tracker:4000/api/candidate-tracker \
TRACKER_API_KEY=dev-mock-key \
docker compose --profile mock up -d --no-deps mock-tracker worker

# convert a lead (through the api, as usual) → worker posts within ~2s,
# event ends up "failed", responseStatus 500, next_retry_at ≈ +60s

MOCK_TRACKER_FORCE_500=false docker compose --profile mock up -d --no-deps mock-tracker
# the worker's own poll loop retries automatically once next_retry_at passes
# (attempt #2 -> status=sent httpStatus=201, same event_id); to force it sooner:
docker compose exec api npm run process-conversions

# back to the real tracker:
docker compose --profile mock rm -sf mock-tracker
docker compose up -d --force-recreate --no-deps worker
```

(PowerShell: set the variables with `$env:NAME = "value"` first.)

## Local development without Docker

```bash
docker compose up -d db                     # just MySQL (creates the tables on first start)
cd api && npm install
# api/.env: DATABASE_URL=mysql://callisto:callisto_dev_password@localhost:3306/callisto + TRACKER_* vars
npm run dev                                 # :3000 — api only; nothing posts conversions without the worker
npm run dev:worker                          # in another terminal — polls and posts pending conversions
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
  src/container.ts     composition root: wires Prisma + HTTP tracker into the services
  src/lib/             backoff policy, constants
  src/jobs/            conversionWorker.ts (the `worker` service's poll loop);
                       processConversionEvents.ts (same batch pass, run once by hand)
  src/dev/             mock tracker
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
