// Mock delivery company for local tests (A3). Implements the "Mock protocol" in src/lib/delivery/README.md.
// Plain node, no dependencies, in-memory state.
//
//   node scripts/mock-delivery.mjs                 # http://127.0.0.1:8893, API key "test-key"
//   PORT=8893 MOCK_API_KEY=test-key node scripts/mock-delivery.mjs
//
// The shop points at it with DELIVERY_BASE_URL=http://127.0.0.1:8893 and DELIVERY_API_KEY=test-key.
// It logs method, path and status only (never the recipient's name, phone or address).
//
// Test controls (no auth; local only):
//   POST /__control/fail-create { count, status? }  next `count` creates answer `status` (default 500)
//   POST /__control/set-status  { id, status }       change a shipment's status (for track)
//   GET  /__control/last-create                      the last create request body as received
//   GET  /__control/stats                            { creates, failedCreates, shipments }
//   POST /__control/reset                            forget everything
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8893);
const KEY = process.env.MOCK_API_KEY ?? "test-key";
const STATUSES = new Set(["created", "picked_up", "in_transit", "delivered", "failed", "cancelled"]);

// ids stay unique across restarts and resets (the shop keeps old provider refs in its database)
const BOOT = Date.now().toString(36).toUpperCase();
let seq = 0;
let state;
function reset() {
  state = { shipments: new Map(), byKey: new Map(), failNext: 0, failStatus: 500, lastCreate: null, creates: 0, failedCreates: 0 };
}
reset();

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new Error("too large");
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

const view = (s) => ({ id: s.id, reference: s.reference, status: s.status, trackingNo: s.trackingNo, trackingUrl: s.trackingUrl });

function validCreate(b) {
  const str = (v, max = 300) => typeof v === "string" && v.length > 0 && v.length <= max;
  return (
    b && str(b.reference, 40) && str(b.idempotencyKey, 120) &&
    b.recipient && str(b.recipient.name) && str(b.recipient.phone, 20) &&
    b.address && str(b.address.city, 60) && str(b.address.line) &&
    Number.isInteger(b.itemsCount) && b.itemsCount >= 0
  );
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // ---- controls ----
  if (path.startsWith("/__control/")) {
    const body = req.method === "POST" ? await readBody(req) : {};
    if (path === "/__control/reset") { reset(); return send(res, 200, { ok: true }); }
    if (path === "/__control/fail-create") {
      state.failNext = Math.max(0, Number(body.count) || 0);
      state.failStatus = Number(body.status) || 500;
      return send(res, 200, { ok: true, failNext: state.failNext, failStatus: state.failStatus });
    }
    if (path === "/__control/set-status") {
      const s = state.shipments.get(body.id);
      if (!s || !STATUSES.has(body.status)) return send(res, 404, { error: "not_found" });
      s.status = body.status;
      return send(res, 200, view(s));
    }
    if (path === "/__control/last-create") return send(res, 200, { body: state.lastCreate });
    if (path === "/__control/stats") return send(res, 200, { creates: state.creates, failedCreates: state.failedCreates, shipments: state.shipments.size });
    return send(res, 404, { error: "not_found" });
  }

  // ---- protocol ----
  if (req.headers.authorization !== `Bearer ${KEY}`) return send(res, 401, { error: "unauthorized" });

  if (req.method === "POST" && path === "/v1/shipments") {
    const b = await readBody(req);
    state.creates++;
    state.lastCreate = b;
    if (state.failNext > 0) {
      state.failNext--;
      state.failedCreates++;
      return send(res, state.failStatus, { error: "simulated_failure" });
    }
    if (!validCreate(b)) return send(res, 422, { error: "invalid" });
    const existing = state.byKey.get(b.idempotencyKey);
    if (existing) return send(res, 200, view(state.shipments.get(existing)));
    const n = String(++seq).padStart(6, "0");
    const id = `MOCK-${BOOT}-${n}`;
    const s = { id, reference: b.reference, status: "created", trackingNo: `TRK${BOOT}${n}`, trackingUrl: `https://track.example.test/${id}` };
    state.shipments.set(id, s);
    state.byKey.set(b.idempotencyKey, id);
    return send(res, 201, view(s));
  }

  let m = /^\/v1\/shipments\/([A-Za-z0-9_-]+)$/.exec(path);
  if (req.method === "GET" && m) {
    const s = state.shipments.get(m[1]);
    return s ? send(res, 200, view(s)) : send(res, 404, { error: "not_found" });
  }
  m = /^\/v1\/shipments\/([A-Za-z0-9_-]+)\/cancel$/.exec(path);
  if (req.method === "POST" && m) {
    const s = state.shipments.get(m[1]);
    if (!s) return send(res, 404, { error: "not_found" });
    if (s.status === "delivered") return send(res, 409, { error: "already_delivered" });
    s.status = "cancelled";
    return send(res, 200, view(s));
  }
  return send(res, 404, { error: "not_found" });
}

createServer((req, res) => {
  handle(req, res)
    .catch(() => send(res, 400, { error: "bad_request" }))
    .finally(() => console.log(`[mock-delivery] ${req.method} ${req.url.split("?")[0]} -> ${res.statusCode}`));
}).listen(PORT, "127.0.0.1", () => console.log(`[mock-delivery] listening on http://127.0.0.1:${PORT}`));
