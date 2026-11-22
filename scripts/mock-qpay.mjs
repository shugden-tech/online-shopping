// Local mock of the QPay merchant API v2 (only what src/lib/payments/qpay.ts uses). No dependencies.
//   node scripts/mock-qpay.mjs            (PORT=8892 by default; Basic auth user/pass = MOCK_QPAY_USER/PASS, default test/test)
//
// QPay endpoints:
//   POST /v2/auth/token      Basic auth -> { token_type, access_token, expires_in (unix s), refresh_token, ... }
//   POST /v2/invoice         Bearer -> { invoice_id, qr_text, qr_image, qPay_shortUrl, urls[] }
//   POST /v2/payment/check   Bearer { object_type:"INVOICE", object_id, offset } -> { count, paid_amount, rows[] }
// Control endpoints (tests only):
//   POST /_control/pay          { invoice_id | sender_invoice_no, amount? }  adds a PAID payment row (default: the
//                               amount still due) -> { invoice_id, paid_amount, callback_url }
//   POST /_control/fail-invoice { count }   the next `count` invoice creations answer HTTP 500
//   POST /_control/fail-check   { count }   the next `count` payment checks answer HTTP 500
//   GET  /_control/invoices?sender_invoice_no=   -> { items: [...] }
//   GET  /_control/stats                    -> { tokens, invoices, checks }
//   POST /_control/reset
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8892);
const USER = process.env.MOCK_QPAY_USER ?? "test";
const PASS = process.env.MOCK_QPAY_PASS ?? "test";
// 1x1 transparent PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

let invoices = new Map(); // invoice_id -> { invoice_id, sender_invoice_no, amount, callback_url, payments: [] }
let tokens = new Set();
let failInvoice = 0;
let failCheck = 0;
let stats = { tokens: 0, invoices: 0, checks: 0 };

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        resolve(null);
      }
    });
  });
const bearer = (req) => tokens.has(/^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "");
const paid = (inv) => inv.payments.reduce((n, p) => n + p.payment_amount, 0);

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const body = req.method === "POST" ? await readBody(req) : {};
  if (body === null) return send(res, 400, { error: "INVALID_JSON" });

  if (req.method === "POST" && url.pathname === "/v2/auth/token") {
    const m = /^Basic (\S+)$/.exec(req.headers.authorization ?? "");
    const [u, p] = m ? Buffer.from(m[1], "base64").toString().split(":") : [];
    if (u !== USER || p !== PASS) return send(res, 401, { error: "AUTHENTICATION_FAILED" });
    const token = randomUUID();
    tokens.add(token);
    stats.tokens++;
    const now = Math.floor(Date.now() / 1000);
    return send(res, 200, { token_type: "bearer", access_token: token, expires_in: now + 3600, refresh_token: randomUUID(), refresh_expires_in: now + 7200, scope: "profile email" });
  }

  if (req.method === "POST" && url.pathname === "/v2/invoice") {
    if (!bearer(req)) return send(res, 401, { error: "NO_CREDENTIALS" });
    if (failInvoice > 0) {
      failInvoice--;
      return send(res, 500, { error: "MOCK_FAILURE" });
    }
    const { invoice_code, sender_invoice_no, invoice_receiver_code, invoice_description, amount, callback_url } = body;
    if (!invoice_code || !sender_invoice_no || !invoice_receiver_code || !invoice_description || !(amount > 0) || !callback_url) {
      return send(res, 400, { error: "INVALID_REQUEST", got: Object.keys(body) });
    }
    const invoice_id = randomUUID();
    invoices.set(invoice_id, { invoice_id, invoice_code, sender_invoice_no, amount, callback_url, payments: [] });
    stats.invoices++;
    return send(res, 200, {
      invoice_id,
      qr_text: `mock-qr:${invoice_id}`,
      qr_image: PNG,
      qPay_shortUrl: `https://s.qpay.mn/mock/${invoice_id.slice(0, 8)}`,
      urls: [{ name: "Khan bank", description: "Хаан банк", logo: "https://qpay.mn/q/logo/khanbank.png", link: `khanbank://q?qPay_QRcode=mock-${invoice_id}` }],
    });
  }

  if (req.method === "POST" && url.pathname === "/v2/payment/check") {
    if (!bearer(req)) return send(res, 401, { error: "NO_CREDENTIALS" });
    stats.checks++;
    if (failCheck > 0) {
      failCheck--;
      return send(res, 500, { error: "MOCK_FAILURE" });
    }
    if (body.object_type !== "INVOICE") return send(res, 400, { error: "INVALID_OBJECT_TYPE" });
    const inv = invoices.get(body.object_id);
    if (!inv) return send(res, 200, { count: 0, paid_amount: 0, rows: [] });
    return send(res, 200, { count: inv.payments.length, paid_amount: paid(inv), rows: inv.payments });
  }

  if (url.pathname.startsWith("/_control/")) {
    const what = url.pathname.slice("/_control/".length);
    if (what === "pay" && req.method === "POST") {
      const inv = body.invoice_id
        ? invoices.get(body.invoice_id)
        : [...invoices.values()].reverse().find((i) => i.sender_invoice_no === body.sender_invoice_no);
      if (!inv) return send(res, 404, { error: "INVOICE_NOT_FOUND" });
      const amount = Number(body.amount ?? inv.amount - paid(inv));
      inv.payments.push({
        payment_id: String(Math.floor(Math.random() * 1e12)),
        payment_status: "PAID",
        payment_date: new Date().toISOString(),
        payment_fee: "1.00",
        payment_amount: amount,
        payment_currency: "MNT",
        payment_wallet: "mock",
        transaction_type: "P2P",
      });
      return send(res, 200, { invoice_id: inv.invoice_id, paid_amount: paid(inv), amount: inv.amount, callback_url: inv.callback_url });
    }
    if (what === "fail-invoice" && req.method === "POST") {
      failInvoice = Number(body.count ?? 1);
      return send(res, 200, { failInvoice });
    }
    if (what === "fail-check" && req.method === "POST") {
      failCheck = Number(body.count ?? 1);
      return send(res, 200, { failCheck });
    }
    if (what === "invoices") {
      const s = url.searchParams.get("sender_invoice_no");
      return send(res, 200, { items: [...invoices.values()].filter((i) => !s || i.sender_invoice_no === s) });
    }
    if (what === "stats") return send(res, 200, stats);
    if (what === "reset" && req.method === "POST") {
      invoices = new Map();
      tokens = new Set();
      failInvoice = failCheck = 0;
      stats = { tokens: 0, invoices: 0, checks: 0 };
      return send(res, 200, { ok: true });
    }
  }
  send(res, 404, { error: "NOT_FOUND" });
}).listen(PORT, "127.0.0.1", () => console.log(`mock QPay listening on http://127.0.0.1:${PORT}`));
