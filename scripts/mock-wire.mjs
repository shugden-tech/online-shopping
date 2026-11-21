// Local mock of the Wire API (only what src/lib/payments/wire.ts uses), plus signed webhook delivery. No dependencies.
//   node scripts/mock-wire.mjs     (PORT=8896 by default)
//   MOCK_WIRE_KEY      the only accepted Bearer key   (default sk_live_mock_0123456789abcdef — a fake, not a real key)
//   MOCK_WIRE_SECRET   whsec_ used to sign deliveries  (default whsec_mock_0123456789abcdef)
//
// Wire endpoints (as documented at https://docs.wire.mn/en/docs):
//   POST /v1/payment_intents            { amount, currency:"MNT", description?, metadata?, expires_at? } -> pi_… requires_payment_method
//   POST /v1/checkout/sessions          { payment_intent, success_url?, cancel_url? } -> cs_… url https://pay.wire.mn/c/cs_…
//   POST /v1/payment_intents/{id}/confirm {}  (direct QR mode) -> requires_action + next_action
//        { type:"qr", qr:{ text:"000201…", deeplinks:[{name, link}] } } by default; /_control/next_action picks another type
//        (redirect_to_url / poll / loan_app / …). Only a requires_payment_method intent can be confirmed (else 400
//        payment_intent_unexpected_state), so a second confirm with a NEW key never makes a second QR.
//   GET  /v1/payment_intents/{id}
//   GET  /v1/events/{id}
// Every POST needs Idempotency-Key (400 parameter_missing), JSON body (400 invalid_json). Same key + same body replays
// (header Idempotent-Replayed: true); same key + other body -> 409 idempotency_key_in_use. Errors use the
// { error: { type, code, message, param, request_id } } envelope.
// Control endpoints (tests only):
//   POST /_control/set     { intent | order_id, status: succeeded|payment_failed|canceled|<any>, deliver?: url, t?: unix,
//                            event_id?, sign?: false } changes the intent and (with deliver) POSTs the signed event
//                            -> { intent, event, delivery: { status, body } | null }
//   POST /_control/sign    { body: string, t? } -> { header }   (WirePayment-Signature for an arbitrary raw body)
//   POST /_control/fail    { endpoint: "intent"|"session"|"get"|"confirm", count, status?, code?, after? } the next calls answer an
//                          error (`after: true`, confirm only: the confirm happens, then the answer is an error)
//   POST /_control/next_action { type: "qr"|"redirect_to_url"|"poll"|<any>, count? }  what the next confirm(s) return
//   POST /_control/set     … also { intent, next_action: {…} } (no status) replaces an intent's next_action (poll -> qr)
//   GET  /_control/intents?order_id=      -> { items, sessions } (each with `_key` = the Idempotency-Key that created it)
//   GET  /_control/stats                  -> { intents, sessions, gets, replays, posts, missingKey, confirms, confirmKeys }
//   POST /_control/reset
import { createServer } from "node:http";
import { createHash, createHmac, randomBytes } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8896);
const KEY = process.env.MOCK_WIRE_KEY ?? "sk_live_mock_0123456789abcdef";
const SECRET = process.env.MOCK_WIRE_SECRET ?? "whsec_mock_0123456789abcdef";

const id = (p) => `${p}_${randomBytes(13).toString("hex").slice(0, 26)}`;
let intents, sessions, events, idem, keys, fail, stats, nextAction;
function reset() {
  intents = new Map();
  sessions = new Map();
  events = new Map();
  idem = new Map();
  keys = new Map(); // object id -> the Idempotency-Key that created it (for tests)
  fail = { intent: null, session: null, get: null, confirm: null };
  stats = { intents: 0, sessions: 0, gets: 0, replays: 0, posts: 0, missingKey: 0, confirms: 0, confirmKeys: {} };
  nextAction = [];
}
reset();

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const err = (res, status, code, message, param, type = "invalid_request_error") =>
  send(res, status, { error: { type, code, message, ...(param ? { param } : {}), request_id: id("req") } });
const readRaw = (req) =>
  new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });
const sign = (t, raw) => `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${raw}`).digest("hex")}`;
const now = () => Math.floor(Date.now() / 1000);
const takeFail = (k) => {
  const f = fail[k];
  if (!f || f.count <= 0) return null;
  f.count--;
  return f;
};

/** A made-up EMVCo-style payload (not a real merchant): enough for a scannable QR in tests. */
const mockQr = (pi) => ({
  text: `00020101021226${String(14 + pi.id.length).padStart(2, "0")}0010mn.wire.mock01${String(pi.id.length).padStart(2, "0")}${pi.id}5204599953034965406${String(pi.amount).padStart(6, "0").slice(-6)}5802MN5906GenZst6011Ulaanbaatar6304ABCD`,
  deeplinks: [
    { name: "Khan Bank", link: `khanbank://q?qPay_QRcode=${pi.id}` },
    { name: "Golomt Bank", link: `socialpay-payment://q?qPay_QRcode=${pi.id}` },
    { name: "TDB online", link: `tdbbank://q?qPay_QRcode=${pi.id}` },
    { name: "Bad link", link: `javascript:alert(1)` },
  ],
});
function actionFor(pi, type) {
  if (type === "qr") return { type, qr: mockQr(pi) };
  if (type === "redirect_to_url") return { type, redirect_to_url: { url: `https://pay.wire.mn/r/${pi.id}`, return_url: null } };
  return { type };
}

function makeEvent(intent, type, eventId) {
  const ev = {
    id: eventId ?? id("evt"),
    object: "event",
    type,
    created: now(),
    data: {
      id: intent.id, object: "payment_intent", status: intent.status, amount: intent.amount, currency: intent.currency,
      ...(intent.status === "succeeded" ? { charge: intent.latest_charge } : {}),
    },
  };
  events.set(ev.id, ev);
  return ev;
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const raw = req.method === "POST" ? await readRaw(req) : "";

  if (url.pathname.startsWith("/v1/")) {
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      if (/^Bearer sk_test_/.test(req.headers.authorization ?? "")) return err(res, 401, "test_mode_unavailable", "Test keys are not accepted", null, "authentication_error");
      return err(res, 401, req.headers.authorization ? "api_key_invalid" : "api_key_missing", "Invalid API key", null, "authentication_error");
    }
    let body = {};
    if (req.method === "POST") {
      stats.posts++;
      const key = req.headers["idempotency-key"];
      if (!key) {
        stats.missingKey++;
        return err(res, 400, "parameter_missing", "Idempotency-Key header is required", "Idempotency-Key");
      }
      if (String(key).length > 255) return err(res, 400, "parameter_invalid", "Idempotency-Key too long", "Idempotency-Key");
      if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return err(res, 400, "invalid_json", "Send JSON");
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return err(res, 400, "invalid_json", "Body is not JSON");
      }
      const scope = `${url.pathname}|${key}`;
      const hash = createHash("sha256").update(raw).digest("hex");
      const prev = idem.get(scope);
      if (prev) {
        if (prev.hash !== hash) return err(res, 409, "idempotency_key_in_use", "Key reused with a different body");
        stats.replays++;
        return send(res, prev.status, prev.body, { "Idempotent-Replayed": "true" });
      }
      // recorded responses (2xx and 402) are stored by the handler through `remember`
      req.remember = (status, b) => {
        if ((status >= 200 && status < 300) || status === 402) idem.set(scope, { hash, status, body: b });
        send(res, status, b);
      };
    }

    if (req.method === "POST" && url.pathname === "/v1/payment_intents") {
      const f = takeFail("intent");
      if (f) return err(res, f.status ?? 500, f.code ?? "api_error", "mock failure", null, "api_error");
      const { amount, currency, description, metadata, expires_at } = body;
      if (!Number.isInteger(amount) || amount < 1 || amount > 1_000_000_000) return err(res, 400, "amount_invalid", "amount must be whole MNT", "amount");
      if (currency !== "MNT") return err(res, 400, "currency_invalid", "MNT only", "currency");
      const n = now();
      if (expires_at !== undefined && (!Number.isInteger(expires_at) || expires_at < n + 300 - 5 || expires_at > n + 86400 + 5)) {
        return err(res, 400, "expires_at_invalid", "expires_at must be 5 minutes to 24 hours from now", "expires_at");
      }
      const pi = {
        id: id("pi"), object: "payment_intent", amount, currency, description: description ?? null,
        status: "requires_payment_method", client_secret: id("cs"), automatic_operator: true, allowed_operators: [],
        selected_operator: null, next_action: null, metadata: metadata ?? {}, livemode: true, created: n,
        expires_at: expires_at ?? n + 3600, latest_charge: null,
      };
      intents.set(pi.id, pi);
      keys.set(pi.id, String(req.headers["idempotency-key"]));
      stats.intents++;
      return req.remember(200, pi);
    }

    if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") {
      const f = takeFail("session");
      if (f) return err(res, f.status ?? 500, f.code ?? "api_error", "mock failure", null, "api_error");
      const pi = intents.get(body.payment_intent);
      if (!pi) return err(res, 404, "resource_missing", "No such payment_intent", "payment_intent");
      // (requires_action too: our direct mode falls back to a hosted session for next_action types it cannot show)
      if (pi.status !== "requires_payment_method" && pi.status !== "requires_action") return err(res, 400, "payment_intent_unexpected_state", "Intent is not awaiting payment", "payment_intent");
      for (const k of ["success_url", "cancel_url"]) {
        if (body[k] !== undefined && !/^https?:\/\/[^\s/]+/.test(String(body[k]))) return err(res, 400, "checkout_url_invalid", `${k} must be absolute`, k);
      }
      const cs = {
        id: id("cs"), object: "checkout_session", payment_intent: pi.id, status: "open",
        url: "", success_url: body.success_url ?? null, cancel_url: body.cancel_url ?? null, allowed_operators: [], created: now(),
      };
      cs.url = `https://pay.wire.mn/c/${cs.id}`;
      sessions.set(cs.id, cs);
      keys.set(cs.id, String(req.headers["idempotency-key"]));
      stats.sessions++;
      return req.remember(200, cs);
    }

    const mConfirm = /^\/v1\/payment_intents\/([^/]+)\/confirm$/.exec(url.pathname);
    if (req.method === "POST" && mConfirm) {
      // `after: true` = Wire confirms, then the answer is lost (our side sees a 5xx): the retry must read it back
      const f = takeFail("confirm");
      if (f && !f.after) return err(res, f.status ?? 500, f.code ?? "api_error", "mock failure", null, "api_error");
      const pi = intents.get(mConfirm[1]);
      if (!pi) return err(res, 404, "resource_missing", "No such payment_intent");
      if (pi.status !== "requires_payment_method" && pi.status !== "requires_confirmation") {
        return err(res, 400, "payment_intent_unexpected_state", `Intent is ${pi.status}`, "payment_intent");
      }
      stats.confirms++;
      (stats.confirmKeys[pi.id] ??= []).push(String(req.headers["idempotency-key"]));
      const want = nextAction.length ? nextAction.shift() : "qr";
      pi.status = "requires_action";
      pi.next_action = actionFor(pi, want);
      if (f?.after) return err(res, f.status ?? 502, f.code ?? "api_error", "mock failure after confirm", null, "api_error");
      return req.remember(200, structuredClone(pi));
    }

    const mIntent = /^\/v1\/payment_intents\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && mIntent) {
      stats.gets++;
      const f = takeFail("get");
      if (f) return err(res, f.status ?? 500, f.code ?? "api_error", "mock failure", null, "api_error");
      const pi = intents.get(mIntent[1]);
      return pi ? send(res, 200, pi) : err(res, 404, "resource_missing", "No such payment_intent");
    }
    const mEvent = /^\/v1\/events\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && mEvent) {
      const ev = events.get(mEvent[1]);
      return ev ? send(res, 200, ev) : err(res, 404, "resource_missing", "No such event");
    }
    return err(res, 404, "resource_missing", "Unknown endpoint");
  }

  if (url.pathname.startsWith("/_control/")) {
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return send(res, 400, { error: "INVALID_JSON" });
    }
    const what = url.pathname.slice("/_control/".length);
    if (what === "set" && req.method === "POST") {
      const pi = body.intent
        ? intents.get(body.intent)
        : [...intents.values()].reverse().find((i) => i.metadata?.order_id === body.order_id);
      if (!pi) return send(res, 404, { error: "INTENT_NOT_FOUND" });
      if (body.next_action !== undefined && body.status === undefined) {
        pi.next_action = typeof body.next_action === "string" ? actionFor(pi, body.next_action) : body.next_action;
        return send(res, 200, { intent: pi, event: null, delivery: null });
      }
      const status = String(body.status ?? "succeeded");
      // after a failed attempt the hosted page lets the buyer try again: the intent stays payable
      pi.status = status === "payment_failed" ? String(body.intent_status ?? "requires_payment_method") : status;
      if (pi.status !== "requires_action") pi.next_action = null;
      if (pi.status === "succeeded" && !pi.latest_charge) pi.latest_charge = id("ch");
      const type = body.type ?? (status === "succeeded" ? "payment_intent.succeeded" : status === "payment_failed" ? "payment_intent.payment_failed" : "payment_intent.canceled");
      const ev = makeEvent(pi, type, body.event_id);
      let delivery = null;
      if (body.deliver) {
        const rawEv = JSON.stringify(ev);
        const r = await fetch(body.deliver, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(body.sign === false ? {} : { "WirePayment-Signature": sign(body.t ?? now(), rawEv) }) },
          body: rawEv,
        });
        delivery = { status: r.status, body: await r.text() };
      }
      return send(res, 200, { intent: pi, event: ev, delivery });
    }
    if (what === "sign" && req.method === "POST") return send(res, 200, { header: sign(body.t ?? now(), String(body.body ?? "")) });
    if (what === "fail" && req.method === "POST") {
      fail[body.endpoint] = { count: Number(body.count ?? 1), status: body.status, code: body.code, after: body.after === true };
      return send(res, 200, { fail });
    }
    if (what === "intents") {
      const o = url.searchParams.get("order_id");
      const items = [...intents.values()].filter((i) => !o || i.metadata?.order_id === o);
      const ids = new Set(items.map((i) => i.id));
      return send(res, 200, {
        items: items.map((i) => ({ ...i, _key: keys.get(i.id) })),
        sessions: [...sessions.values()].filter((c) => ids.has(c.payment_intent)).map((c) => ({ ...c, _key: keys.get(c.id) })),
      });
    }
    if (what === "next_action" && req.method === "POST") {
      nextAction = Array.from({ length: Number(body.count ?? 1) }, () => String(body.type ?? "qr"));
      return send(res, 200, { nextAction });
    }
    if (what === "stats") return send(res, 200, stats);
    if (what === "reset" && req.method === "POST") {
      reset();
      return send(res, 200, { ok: true });
    }
  }
  send(res, 404, { error: "NOT_FOUND" });
}).listen(PORT, "127.0.0.1", () => console.log(`mock Wire listening on http://127.0.0.1:${PORT}`));
