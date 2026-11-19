// In-memory admin sample data shared by UI tests and the local preview.
/* ---------------- contract constants (mirrors src/lib/contracts.ts) ---------------- */
const ORDER_TRANSITIONS = { new: ["confirmed", "paid", "cancelled"], confirmed: ["paid", "cancelled"], paid: ["shipped", "cancelled"], shipped: ["done"], done: [], cancelled: [] };
const ALL = ["catalog.read", "catalog.write", "inventory.write", "media.write", "orders.read", "orders.write", "payments.read", "payments.write", "delivery.read", "delivery.write", "settings.read", "settings.write", "audit.read"];
const STAFF = ["catalog.read", "inventory.write", "orders.read", "orders.write", "payments.read", "delivery.read", "delivery.write", "settings.read"];
const OWNER_TOKEN = "owner-token-0123456789abcdef";
const STAFF_TOKEN = "staff-token-0123456789abcdef";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const MEDIA = "https://pub-test.r2.dev";

/* ---------------- fixtures ---------------- */
const sku = (productId, ml, o = {}) => ({
  id: `${productId}:${ml}`, productId, ml, kind: ml >= 50 ? "full" : "decant", price: 45000, compareAt: null,
  stock: 10, reserved: 2, available: 8, active: true, updatedAt: "2026-11-01 10:00:00", ...o,
});
function makeProduct(id, o = {}) {
  return {
    id, brand: "Mugler", name: "Alien", concentration: "EDP", gender: "women", family: "amber", releaseYear: 2005,
    notes: { top: ["Jasmine"], heart: ["Cashmeran"], base: ["Amber"] }, descriptionMn: "Тайлбар", descriptionEn: "Description",
    imageFront: `${MEDIA}/products/${id}/front-aaaaaaaaaaaa.webp`, imageBack: null, status: "active", saleLocked: false, sort: 0,
    source: "r2-catalog", createdAt: "2026-10-01 10:00:00", updatedAt: "2026-11-01 10:00:00",
    skus: [sku(id, 5, { reserved: 1, stock: 4, available: 3 }), sku(id, 10, { price: 80000 }), sku(id, 100, { stock: null, reserved: 0, available: null, price: null })],
    ...o,
  };
}
function makeOrder(no, status, o = {}) {
  return {
    id: 1, orderNo: no, createdAt: "2026-11-10 08:00:00", updatedAt: "2026-11-10 08:00:00", status,
    paymentStatus: status === "paid" || status === "shipped" || status === "done" ? "paid" : "unpaid",
    holdExpiresAt: status === "new" ? "2026-11-10 08:30:00" : null,
    name: "Бат", phone: "99112233", phone2: null, city: "ub", district: "СБД", khoroo: "1", address: "Байр 1", note: null,
    payment: "bank", items: [{ sku: "mugler-alien-edp:10", slug: "mugler-alien-edp", brand: "Mugler", name: "Alien", ml: 10, qty: 2, price: 80000 }],
    subtotal: 160000, delivery: 5000, total: 165000, locale: "mn", ...o,
  };
}

function makeMock() {
  const state = {
    expired: false,
    products: { "mugler-alien-edp": makeProduct("mugler-alien-edp"), "draft-one": makeProduct("draft-one", { status: "draft", brand: "Test", name: "Draft", skus: [] }) },
    orders: {
      "GZ-261110-AAAA": makeOrder("GZ-261110-AAAA", "new"),
      "GZ-261110-BBBB": makeOrder("GZ-261110-BBBB", "paid"),
    },
    settings: {
      "checkout.open": true, "payments.qpay.enabled": true, "payments.bank.enabled": true, "holds.qpay_minutes": 30, "holds.bank_minutes": 1440,
      "delivery.fee_ub": null, "delivery.fee_countryside": null, "delivery.free_over": null, "delivery.provider": "manual", "store.notice_mn": "", "store.notice_en": "",
    },
    shipments: { 7: { id: 7, orderNo: "GZ-261110-BBBB", provider: "manual", providerRef: null, trackingNo: null, trackingUrl: null, status: "failed", attempts: 3, lastError: "timeout", nextRetryAt: null, createdAt: "2026-11-11 10:00:00", updatedAt: "2026-11-11 11:00:00" } },
    forbidPatchOrder: false,
  };
  const log = [];
  const J = (route, status, body) => route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) });
  const fail = (route, status, errors) => J(route, status, { ok: false, errors });

  async function handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const auth = req.headers()["authorization"] ?? "";
    const ct = req.headers()["content-type"] ?? "";
    const raw = req.postDataBuffer();
    let body = null;
    if (raw && ct.includes("application/json")) { try { body = JSON.parse(raw.toString("utf8")); } catch { body = "BAD JSON"; } }
    log.push({ method, path, search: url.search, body, ct, raw: raw ? raw.toString("latin1") : null, auth });

    const role = auth === `Bearer ${OWNER_TOKEN}` ? "owner" : auth === `Bearer ${STAFF_TOKEN}` ? "staff" : null;
    if (!role || state.expired) return fail(route, 401, { form: "unauthorized" });
    const perms = role === "owner" ? ALL : STAFF;
    const need = (p) => perms.includes(p);
    const deny = (p) => (need(p) ? false : (fail(route, 403, { form: "forbidden" }), true));
    let m;

    if (path === "/api/admin/me") return J(route, 200, { ok: true, role, permissions: perms });

    if (path === "/api/admin/settings") {
      if (method === "GET") { if (deny("settings.read")) return; return J(route, 200, { ok: true, settings: state.settings }); }
      if (deny("settings.write")) return;
      Object.assign(state.settings, body);
      return J(route, 200, { ok: true, settings: state.settings });
    }
    if (path === "/api/admin/audit") {
      if (deny("audit.read")) return;
      return J(route, 200, { ok: true, items: [{ id: 3, at: "2026-11-12 09:00:00", actor: "admin:owner", action: "product.update", entity: "product", entityId: "mugler-alien-edp", data: { name: "Alien" } }], nextCursor: null });
    }
    if (path === "/api/admin/products" && method === "GET") {
      if (deny("catalog.read")) return;
      const st = url.searchParams.get("status");
      const items = Object.values(state.products).filter((p) => !st || p.status === st);
      return J(route, 200, { ok: true, items, page: Number(url.searchParams.get("page") ?? 1), limit: Number(url.searchParams.get("limit") ?? 50), total: items.length });
    }
    if (path === "/api/admin/products" && method === "POST") {
      if (deny("catalog.write")) return;
      if (state.products[body.id]) return fail(route, 409, { id: "exists" });
      state.products[body.id] = makeProduct(body.id, { ...body, skus: [] });
      return J(route, 201, { ok: true, product: state.products[body.id] });
    }
    if ((m = /^\/api\/admin\/products\/([^/]+)\/skus\/(\d+)$/.exec(path))) {
      if (deny("catalog.write")) return;
      const p = state.products[decodeURIComponent(m[1])];
      const ml = Number(m[2]);
      if (!p) return fail(route, 404, { form: "notFound" });
      if (method === "DELETE") {
        const s = p.skus.find((x) => x.ml === ml);
        if (s?.reserved) return fail(route, 409, { sku: "reserved" });
        p.skus = p.skus.filter((x) => x.ml !== ml);
        return J(route, 200, { ok: true });
      }
      let s = p.skus.find((x) => x.ml === ml);
      const created = !s;
      if (created && !body.kind) return fail(route, 400, { kind: "required" });
      if (body.compareAt != null && (body.price == null || body.compareAt <= body.price)) return fail(route, 400, { compareAt: "invalid" });
      if (!s) { s = sku(p.id, ml, { stock: null, reserved: 0, available: null }); p.skus.push(s); }
      Object.assign(s, body, { updatedAt: new Date().toISOString() });
      return J(route, 200, { ok: true, sku: s, created });
    }
    if ((m = /^\/api\/admin\/products\/([^/]+)$/.exec(path))) {
      const p = state.products[decodeURIComponent(m[1])];
      if (!p) return fail(route, 404, { form: "notFound" });
      if (method === "GET") { if (deny("catalog.read")) return; return J(route, 200, { ok: true, product: p }); }
      if (deny("catalog.write")) return;
      Object.assign(p, body, { updatedAt: new Date().toISOString() });
      return J(route, 200, { ok: true, product: p });
    }
    if (path === "/api/admin/media") {
      if (deny("media.write")) return;
      return J(route, 200, { ok: true, url: `${MEDIA}/products/mugler-alien-edp/front-0123456789ab.png`, key: "products/mugler-alien-edp/front-0123456789ab.png" });
    }
    if (path === "/api/admin/inventory") {
      if (deny("catalog.read")) return;
      const items = Object.values(state.products).flatMap((p) => p.skus.map((s) => ({ ...s, brand: p.brand, name: p.name }))).filter((s) => s.available !== null && s.available <= 3);
      return J(route, 200, { ok: true, items, nextCursor: null });
    }
    if (path === "/api/admin/inventory/adjust") {
      if (deny("inventory.write")) return;
      const [pid, ml] = [body.sku.slice(0, body.sku.lastIndexOf(":")), Number(body.sku.split(":").pop())];
      const s = state.products[pid]?.skus.find((x) => x.ml === ml);
      if (!s) return fail(route, 404, { sku: "notFound" });
      if (body.delta !== undefined && s.stock === null) return fail(route, 409, { stock: "untracked" });
      const next = body.set !== undefined ? body.set : (s.stock ?? 0) + body.delta;
      if (next < s.reserved) return fail(route, 409, { set: "below_reserved" });
      s.stock = next; s.available = next - s.reserved;
      return J(route, 200, { ok: true, sku: s });
    }
    if ((m = /^\/api\/admin\/inventory\/([^/]+)\/movements$/.exec(path))) {
      return J(route, 200, { ok: true, items: [{ id: 1, skuId: decodeURIComponent(m[1]), at: "2026-11-01 10:00:00", delta: 10, reason: "restock", orderId: null, actor: "admin:owner", note: "эхний" }] });
    }
    if (path === "/api/admin/orders") {
      if (deny("orders.read")) return;
      const st = url.searchParams.get("status");
      return J(route, 200, { ok: true, items: Object.values(state.orders).filter((o) => !st || o.status === st), nextCursor: null });
    }
    if ((m = /^\/api\/admin\/orders\/([^/]+)\/mark-paid$/.exec(path))) {
      if (deny("payments.write")) return;
      const o = state.orders[m[1]];
      o.status = "paid"; o.paymentStatus = "paid";
      return J(route, 200, { ok: true, order: o });
    }
    if ((m = /^\/api\/admin\/orders\/([^/]+)$/.exec(path))) {
      const o = state.orders[decodeURIComponent(m[1])];
      if (!o) return fail(route, 404, { form: "notFound" });
      if (method === "GET") {
        if (deny("orders.read")) return;
        return J(route, 200, {
          ok: true, order: o,
          events: [{ at: o.createdAt, fromStatus: null, toStatus: "new", actor: "customer", note: null }],
          payments: [{ id: 11, orderNo: o.orderNo, provider: "bank", providerRef: "GZ-REF", amount: o.total, status: "pending", paidAmount: null, createdAt: o.createdAt, paidAt: null }],
          reservations: [{ id: 1, sku: "mugler-alien-edp:10", qty: 2, tracked: 1, status: "held" }],
          shipments: [],
        });
      }
      if (deny("orders.write")) return;
      if (state.forbidPatchOrder) return fail(route, 403, { form: "forbidden" });
      if (!ORDER_TRANSITIONS[o.status].includes(body.status)) return fail(route, 409, { status: "transition" });
      o.status = body.status;
      return J(route, 200, { ok: true, order: o });
    }
    if (path === "/api/admin/payments") {
      if (deny("payments.read")) return;
      return J(route, 200, { ok: true, items: [{ id: 11, orderNo: "GZ-261110-AAAA", provider: "bank", providerRef: "GZ-REF", amount: 165000, status: "pending", paidAmount: null, createdAt: "2026-11-10 08:00:00", paidAt: null }], nextCursor: null });
    }
    if (path === "/api/admin/shipments" && method === "POST") {
      if (deny("delivery.write")) return;
      const s = { id: 8, orderNo: body.orderNo, provider: "manual", status: "pending", attempts: 0, createdAt: "2026-11-12 10:00:00", updatedAt: "2026-11-12 10:00:00" };
      state.shipments[8] = s;
      return J(route, 201, { ok: true, shipment: s });
    }
    if (path === "/api/admin/shipments") {
      if (deny("delivery.read")) return;
      const st = url.searchParams.get("status");
      return J(route, 200, { ok: true, items: Object.values(state.shipments).filter((s) => !st || s.status === st), nextCursor: null });
    }
    if ((m = /^\/api\/admin\/shipments\/(\d+)\/retry$/.exec(path))) {
      if (deny("delivery.write")) return;
      state.shipments[m[1]].status = "pending";
      return J(route, 200, { ok: true, shipment: state.shipments[m[1]] });
    }
    if ((m = /^\/api\/admin\/shipments\/(\d+)$/.exec(path))) {
      const s = state.shipments[m[1]];
      if (!s) return fail(route, 404, { form: "notFound" });
      if (method === "GET") return J(route, 200, { ok: true, shipment: s, events: [{ at: s.createdAt, fromStatus: null, toStatus: "pending", source: "admin", note: null }] });
      if (deny("delivery.write")) return;
      Object.assign(s, body);
      return J(route, 200, { ok: true, shipment: s });
    }
    return fail(route, 404, { form: "notFound" });
  }
  return { state, log, handle };
}


export { ORDER_TRANSITIONS, OWNER_TOKEN, STAFF_TOKEN, PNG, MEDIA, makeOrder, makeMock };
