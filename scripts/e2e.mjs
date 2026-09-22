#!/usr/bin/env node
// End-to-end check of the running stack (no dependencies; Node 18+).
//
//   docker compose up -d --build
//   node scripts/e2e.mjs                       # through nginx, http://localhost:8080
//   node scripts/e2e.mjs http://localhost:3000 # or straight at the api
//
// Talks to the REAL tracker configured in .env: every run creates a few
// leads and sends a few conversions (well under the 30 req/min limit).

const BASE = (process.argv[2] ?? "http://localhost:8080").replace(/\/$/, "");
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

  section("conversion against the tracker");
  r = await req("PATCH", `/leads/${id}/status`, { status: "converted" });
  check("convert -> 200", 200, r.status, r.text);
  let ev = r.json.conversionEvent;
  check("event sent (suggested test #2)", "sent", ev.status, r.text);
  check("tracker responded 201", 201, ev.responseStatus, ev.responseBody);
  const eventId = ev.eventId;
  check("event_id is conv_{lead_id}_{hex}", true, new RegExp(`^conv_${id}_[0-9a-f]{8}$`).test(eventId), eventId);
  check("request body persisted before send", eventId, JSON.parse(ev.requestBody).event_id);

  r = await req("PATCH", `/leads/${id}/status`, { status: "converted" });
  ev = r.json.conversionEvent;
  check("re-convert: tracker 200 (suggested test #3)", 200, ev.responseStatus, ev.responseBody);
  check("re-convert: duplicate:true", true, JSON.parse(ev.responseBody).duplicate);
  check("re-convert: same event_id", eventId, ev.eventId);
  check("re-convert: still 'sent'", "sent", ev.status);
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
  check("that event is 'sent'", "sent", events[0]?.status);

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nE2E run aborted: ${err.message}`);
  process.exit(1);
});
