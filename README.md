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

On startup, the `api` container runs `prisma migrate deploy` until MySQL
accepts connections, then starts the server. No manual DB setup is needed.

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
fire-and-forget. This is how the app handles it instead
(`api/src/services/conversionService.ts`):

1. **Persist first.** When a lead becomes `converted`, a `conversion_events`
   row is written (or the existing one reused) with `status = pending` and
   the exact outbound JSON in `request_body`. This happens *before* any
   network call.
2. **Send.** One immediate attempt is made, in the same request, so the
   common case returns its result right away.
3. **Record the outcome.** `status` becomes `sent` or `failed`, and
   `response_status`, `response_body`, `attempts`, and `last_attempt_at` are
   stored on the row. A reviewer can see exactly what was sent and what came
   back (`GET /conversion-events`, or the UI's "Conversion" button).
4. **Retryable failures** (network error, a 10s timeout, `5xx`, or `429`/`408`) stay `failed`, with
   `next_retry_at` set by exponential backoff (1m → 5m → 15m, then capped at
   15m). They are **not** retried in a blocking loop inside the HTTP
   request, because that would hold the request open and burn the tracker's
   30 req/min limit.
5. **The retry command** drains the backlog:
   ```bash
   docker compose exec api npm run process-conversions
   ```
   It picks up events that are `pending` (never attempted, e.g. the process
   died between steps 1 and 2) or `failed` with a due `next_retry_at`. It
   retries them one per second to stay under the rate limit. Run it on a
   schedule (cron / Task Scheduler) for continuous retries. `4xx` failures
   (422 validation, 401 auth) are **not** retried, because retrying won't
   fix them. They keep `next_retry_at = null` and stay visible for a human.

`duplicate: true` (HTTP 200) counts as success.

Concurrent converts of the same lead (e.g. a double-click) are safe.
`lead_id` is unique on `conversion_events`, so only one insert wins and the
other request reuses that row. The attempt counter is incremented
atomically.

### Why a table + command, not a queue broker

The assignment allows "a queue, a table + retry command, or an
equivalent." The table already gives the guarantees a broker would give
here: durable persistence before the attempt, at-least-once delivery, and
retry with backoff. Redis/BullMQ or Kafka would add another service to run
and explain, with no behavioral gain at this scale.

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

## Reproducing the suggested test sequence

**Through the UI** (http://localhost:8080): create a lead with an email,
amount, and currency. Set its status to `converted`. The "Conversion event
detail" panel shows `responseStatus: 201`. Set it to `converted` again and
you get `200` with `"duplicate": true`, same `eventId`.

**Through curl:**

```bash
curl -s http://localhost:8080/conversion-events/tracker-ping                  # 1. 200

curl -s -X POST http://localhost:8080/leads -H "Content-Type: application/json" \
  -d '{"name":"Dana Cohen","email":"dana@example.com","amount":199.5,"currency":"USD"}'

curl -s -X PATCH http://localhost:8080/leads/1/status -H "Content-Type: application/json" \
  -d '{"status":"converted"}'                                                  # 2. 201

curl -s -X PATCH http://localhost:8080/leads/1/status -H "Content-Type: application/json" \
  -d '{"status":"converted"}'                                                  # 3. 200 duplicate:true

curl -s http://localhost:8080/leads/1/conversion-event                        # stored request/response
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
start the bundled mock with forced 500s and point the API at it. Shell env
vars override `.env`:

```bash
MOCK_TRACKER_FORCE_500=true \
TRACKER_BASE_URL=http://mock-tracker:4000/api/candidate-tracker \
TRACKER_API_KEY=dev-mock-key \
docker compose --profile mock up -d --no-deps mock-tracker api

# convert a lead → event is "failed", responseStatus 500, next_retry_at ≈ +60s

MOCK_TRACKER_FORCE_500=false docker compose --profile mock up -d --no-deps mock-tracker
docker compose exec api npm run process-conversions   # before the window: "no conversion events due"
# …after ~60s:
docker compose exec api npm run process-conversions   # attempt #2 -> status=sent httpStatus=201, same event_id

# back to the real tracker:
docker compose --profile mock rm -sf mock-tracker
docker compose up -d --force-recreate --no-deps api
```

(PowerShell: set the variables with `$env:NAME = "value"` first.)

## Local development without Docker

```bash
docker compose up -d db                     # just MySQL
cd api && npm install
# api/.env: DATABASE_URL=mysql://callisto:callisto_dev_password@localhost:3306/callisto + TRACKER_* vars
npx prisma migrate deploy && npm run dev    # :3000
cd ../web && npm install && npm run dev     # :5173, Vite proxies API paths to :3000
```

## Project layout

```
api/
  prisma/schema.prisma, prisma/migrations/    MySQL schema + migration
  src/routes/          HTTP layer only (no tracker calls here)
  src/services/        leadService (rules), conversionService (outbox + send)
  src/lib/             trackerClient (the only code that touches the API key), backoff, constants
  src/jobs/            process-conversions retry command
  src/dev/             mock tracker
  entrypoint.sh        wait for DB → migrate → start
web/
  src/                 React app (components/, api.ts, types.ts)
  nginx.conf           static files + reverse proxy (re-resolves "api" via Docker DNS)
docker-compose.yml
postman/
```

## Out of scope

Per the assignment: multi-brand, roles, billing, real Facebook/Stripe/Google
integrations, pixel-perfect frontend.
