#!/usr/bin/env node
// End-to-end check of the running stack (no dependencies; Node 18+).
//
//   docker compose up -d --build
//   node scripts/e2e.mjs                       # through nginx, http://localhost:8080
//   node scripts/e2e.mjs http://localhost:3000 # or straight at the api
//
// Talks to the REAL tracker configured in .env: every run creates a few
// leads and sends a few conversions (well under the 30 req/min limit).
// Converting only records the event; the `worker` posts on a schedule
// (every 10 minutes), so instead of waiting for it this script triggers a
// batch pass itself — the same `process-conversions` command an operator
// would run. Override with E2E_TRIGGER_PASS if the stack isn't run through
// docker compose from this repo.

import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.argv[2] ?? "http://localhost:8080").replace(/\/$/, "");
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TRIGGER_PASS = process.env.E2E_TRIGGER_PASS ?? "docker compose exec -T api npm run -s process-conversions";
const RUN = Date.now();
let passed = 0;
let failed = 0;

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON (e.g. the React index.html) */
  }
  return { status: res.status, json, text };
}

function check(name, expected, actual, context) {
  if (Object.is(expected, actual) || String(expected) === String(actual)) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}  (expected ${expected}, got ${actual})`);
    if (context) console.log(`        ${String(context).slice(0, 200)}`);
  }
}

function section(title) {
  console.log(`\n== ${title}`);
}

/** Runs one batch pass now (rather than waiting for the worker's schedule),
 * then returns the lead's event once it has left pending/in_process. A
 * second pass covers the rare case where a worker tick claimed the event at
 * the same moment and is still posting it. */
async function postNowAndGet(leadId) {
  for (let pass = 1; pass <= 3; pass++) {
    execSync(TRIGGER_PASS, { cwd: REPO_ROOT, stdio: "ignore" });
    const event = (await req("GET", `/leads/${leadId}/conversion-event`)).json?.data;
    if (event && event.status !== "pending" && event.status !== "in_process") return event;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`lead ${leadId}: conversion still not posted after 3 triggered passes`);
}

async function createLead(fields) {
  const r = await req("POST", "/leads", fields);
  if (r.status !== 201) throw new Error(`setup: could not create lead: ${r.status} ${r.text}`);
  return r.json.data.id;
}

async function main() {
  section("infrastructure");
  let r = await req("GET", "/health");
  check("health", 200, r.status, r.text);
  if (r.status !== 200) {
    console.log(`\nStack not reachable at ${BASE} — is \`docker compose up -d\` running?`);
    process.exit(1);
  }
  r = await req("GET", "/");
  check("React app served at /", 200, r.status);
  r = await req("GET", "/conversion-events/tracker-ping");
  check("tracker ping (suggested test #1)", 200, r.status, r.text);
  check("tracker ping ok:true", true, r.json?.ok, r.text);

  section("create validation");
  const invalid = [
    ["no email/phone", { name: "X", amount: 5, currency: "USD" }, 422],
    ["no name", { email: "a@b.co" }, 422],
    ["invalid email", { name: "X", email: "not-an-email" }, 422],
    ["phone longer than 32", { name: "X", phone: "1".repeat(40) }, 422],
    ["phone with letters", { name: "X", phone: "abc-def-ghij" }, 422],
    ["negative amount", { name: "X", email: "a@b.co", amount: -5, currency: "USD" }, 422],
    ["non-numeric amount", { name: "X", email: "a@b.co", amount: "12abc", currency: "USD" }, 422],
    ["unsupported currency", { name: "X", email: "a@b.co", amount: 5, currency: "ZZZ" }, 422],
    ["amount without currency", { name: "X", email: "a@b.co", amount: 5 }, 422],
    ["malformed JSON", "{bad json", 400],
  ];
  for (const [name, body, expected] of invalid) {
    r = await req("POST", "/leads", body);
    check(`${name} -> ${expected}`, expected, r.status, r.text);
  }

  section("CRUD");
  const source = `e2e${RUN}`;
  r = await req("POST", "/leads", {
    name: `E2E ${RUN}`,
    email: `e2e${RUN}@example.com`,
    phone: "+972501111111",
    source,
    amount: 199.5,
    currency: "usd",
  });
  check("create -> 201", 201, r.status, r.text);
  const id = r.json.data.id;
  check("currency uppercased", "USD", r.json.data.currency);
  check("new lead starts as 'new'", "new", r.json.data.status);

  check("get by id -> 200", 200, (await req("GET", `/leads/${id}`)).status);
  check("non-numeric id -> 404", 404, (await req("GET", "/leads/abc")).status);
  check("missing id -> 404", 404, (await req("GET", "/leads/99999999")).status);
  check("filter by source", 1, (await req("GET", `/leads?source=${source}`)).json.data.length);
  check("filter by source + status", 1, (await req("GET", `/leads?source=${source}&status=new`)).json.data.length);
  check("filter excludes other statuses", 0, (await req("GET", `/leads?source=${source}&status=lost`)).json.data.length);
  check("unknown status filter -> 422", 422, (await req("GET", "/leads?status=bogus")).status);

  r = await req("PATCH", `/leads/${id}`, { status: "lost" });
  check("status via generic PATCH -> 400", 400, r.status, r.text);
  r = await req("PATCH", `/leads/${id}`, { email: "" });
  check("clear email (phone remains) -> 200", 200, r.status, r.text);
  check("email actually cleared", null, r.json.data.email);
  r = await req("PATCH", `/leads/${id}`, { phone: null });
  check("clearing the last contact -> 422", 422, r.status, r.text);
  r = await req("PATCH", `/leads/${id}`, { amount: null, currency: null });
  check("clear amount + currency -> 200", 200, r.status, r.text);
  check("amount actually cleared", null, r.json.data.amount);
  r = await req("PATCH", `/leads/${id}`, { email: `e2e${RUN}@example.com`, amount: 250, currency: "ILS" });
  check("update fields -> 200", 200, r.status, r.text);
  check("amount updated", 250, r.json.data.amount);

  section("status rules");
  const noAmount = await createLead({ name: `NoAmount ${RUN}`, phone: "+972502222222" });
  r = await req("PATCH", `/leads/${noAmount}/status`, { status: "converted" });
  check("convert without amount -> 422", 422, r.status, r.text);
  check("unknown status -> 422", 422, (await req("PATCH", `/leads/${noAmount}/status`, { status: "bogus" })).status);
  r = await req("PATCH", `/leads/${noAmount}/status`, { status: "contacted" });
  check("new -> contacted", "contacted", r.json.data.status);
  check("non-convert status sends nothing", undefined, r.json.conversionEvent);
  r = await req("PATCH", `/leads/${noAmount}/status`, { status: "lost" });
  check("-> lost", "lost", r.json.data.status);
  r = await req("PATCH", `/leads/${noAmount}/status`, { status: "converted" });
  check("convert a lost lead -> 409", 409, r.status, r.text);
  check("delete an unconverted lead -> 204", 204, (await req("DELETE", `/leads/${noAmount}`)).status);
  check("deleted lead is gone -> 404", 404, (await req("GET", `/leads/${noAmount}`)).status);

  section("conversion: recorded by the API, posted by the worker");
  r = await req("PATCH", `/leads/${id}/status`, { status: "converted" });
  check("convert -> 200", 200, r.status, r.text);
  let ev = r.json.conversionEvent;
  check("recorded as pending, not posted inline", "pending", ev.status, r.text);
  check("no attempt made yet", 0, ev.attempts);
  check("no tracker response yet", null, ev.responseStatus);
  const eventId = ev.eventId;
  check("event_id is conv_{lead_id}_{hex}", true, new RegExp(`^conv_${id}_[0-9a-f]{8}$`).test(eventId), eventId);
  check("request body persisted before send", eventId, JSON.parse(ev.requestBody).event_id);

  ev = await postNowAndGet(id);
  check("worker posted it: sent (suggested test #2)", "sent", ev.status, ev.responseBody);
  check("tracker responded 201", 201, ev.responseStatus, ev.responseBody);
  check("one attempt", 1, ev.attempts);
  check("claim released after posting", null, ev.processingStartedAt);

  r = await req("PATCH", `/leads/${id}/status`, { status: "converted" });
  ev = r.json.conversionEvent;
  check("re-convert re-queues the same event", "pending", ev.status, r.text);
  check("re-convert: same event_id", eventId, ev.eventId);
  ev = await postNowAndGet(id);
  check("re-post: tracker 200 (suggested test #3)", 200, ev.responseStatus, ev.responseBody);
  check("re-post: duplicate:true", true, JSON.parse(ev.responseBody).duplicate);
  check("re-post: 'sent'", "sent", ev.status);
  check("both attempts counted", 2, ev.attempts);

  check("GET /leads/:id/conversion-event -> 200", 200, (await req("GET", `/leads/${id}/conversion-event`)).status);
  r = await req("GET", "/conversion-events");
  check("event appears in /conversion-events", 1, r.json.data.filter((e) => e.eventId === eventId).length);
  check("delete a converted lead -> 409", 409, (await req("DELETE", `/leads/${id}`)).status);

  section("double-click convert (concurrency)");
  const dbl = await createLead({ name: `Double ${RUN}`, email: `dbl${RUN}@example.com`, amount: 20, currency: "USD" });
  const [a, b] = await Promise.all([
    req("PATCH", `/leads/${dbl}/status`, { status: "converted" }),
    req("PATCH", `/leads/${dbl}/status`, { status: "converted" }),
  ]);
  check("concurrent convert A -> 200", 200, a.status, a.text);
  check("concurrent convert B -> 200", 200, b.status, b.text);
  const events = (await req("GET", "/conversion-events")).json.data.filter((e) => e.leadId === dbl);
  check("exactly one event row for the lead", 1, events.length);
  check("that event gets posted: 'sent'", "sent", (await postNowAndGet(dbl)).status);

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nE2E run aborted: ${err.message}`);
  process.exit(1);
});
