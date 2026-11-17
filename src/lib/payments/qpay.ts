// A2 QPay merchant API v2 client (CONTRACTS §5). Server-only.
//   POST {QPAY_BASE_URL}/v2/auth/token      Basic QPAY_USERNAME:QPAY_PASSWORD -> access_token (cached until expiry)
//   POST {QPAY_BASE_URL}/v2/invoice         -> invoice_id, qr_text, qr_image, qPay_shortUrl, urls[]
//   POST {QPAY_BASE_URL}/v2/payment/check   -> count, paid_amount, rows[]
// Field names follow https://developer.qpay.mn/mn/docs/merchant?version=2.0.0 as recorded in the contract;
// verify them against the official doc before go-live. Tests point QPAY_BASE_URL at scripts/mock-qpay.mjs.
// Nothing about the customer (name, phone, address) is sent to QPay: only the order number and amount.
import type { Settings } from "../contracts";

const TIMEOUT_MS = 10_000;

export class QpayError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "QpayError";
  }
}

/** QPay can be offered only when the store switch is on AND every secret is configured. */
export function qpayConfigured(env: Env): boolean {
  return Boolean(env.QPAY_BASE_URL && env.QPAY_USERNAME && env.QPAY_PASSWORD && env.QPAY_INVOICE_CODE && env.QPAY_CALLBACK_SECRET);
}
export function qpayEnabled(env: Env, settings: Settings): boolean {
  return settings["payments.qpay.enabled"] === true && qpayConfigured(env);
}

const base = (env: Env) => (env.QPAY_BASE_URL ?? "").replace(/\/+$/, "");

/* ---------------- callback signature ---------------- */

const enc = new TextEncoder();

export async function signOrder(secret: string, orderNo: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(orderNo)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time check of `sig` against HMAC(secret, orderNo). */
export async function verifyOrderSig(secret: string, orderNo: string, sig: string): Promise<boolean> {
  if (!secret || !/^[0-9a-f]{64}$/i.test(sig)) return false;
  const want = await signOrder(secret, orderNo);
  const a = enc.encode(want);
  const b = enc.encode(sig.toLowerCase());
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ (b[i] ?? 0);
  return diff === 0;
}

export async function callbackUrl(env: Env, orderNo: string): Promise<string> {
  const site = (env.PUBLIC_SITE_URL ?? "").replace(/\/+$/, "");
  const sig = await signOrder(env.QPAY_CALLBACK_SECRET ?? "", orderNo);
  return `${site}/api/payments/qpay/callback?order=${encodeURIComponent(orderNo)}&sig=${sig}`;
}

/* ---------------- token (module-scope cache) ---------------- */

let cached: { key: string; token: string; until: number } | null = null;

async function call(url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new QpayError(`network: ${String(err)}`);
  }
  const text = await res.text();
  if (!res.ok) throw new QpayError(`HTTP ${res.status}`, res.status);
  try {
    return JSON.parse(text);
  } catch {
    throw new QpayError("invalid JSON");
  }
}

async function token(env: Env, force = false): Promise<string> {
  const key = `${base(env)}|${env.QPAY_USERNAME}`;
  const now = Date.now();
  if (!force && cached && cached.key === key && cached.until > now) return cached.token;
  const basic = btoa(`${env.QPAY_USERNAME}:${env.QPAY_PASSWORD}`);
  const data = (await call(`${base(env)}/v2/auth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}` },
  })) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new QpayError("no access_token");
  // QPay returns expires_in as a unix timestamp (seconds); accept a relative number of seconds too.
  const exp = Number(data.expires_in) || 0;
  const expiresAt = exp > 1e9 ? exp * 1000 : now + (exp > 0 ? exp * 1000 : 300_000);
  cached = { key, token: data.access_token, until: expiresAt - 60_000 };
  return data.access_token;
}

/** Authenticated POST; on 401 the cached token is dropped and the call is retried once. */
async function authed(env: Env, path: string, body: unknown): Promise<unknown> {
  const send = async (t: string) =>
    call(`${base(env)}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    return await send(await token(env));
  } catch (err) {
    if (err instanceof QpayError && err.status === 401) {
      cached = null;
      return send(await token(env, true));
    }
    throw err;
  }
}

/* ---------------- invoice + payment check ---------------- */

export interface QpayInvoice {
  invoiceId: string;
  qrText: string | null;
  qrImage: string | null;
  shortUrl: string | null;
  urls: { name: string; link: string; logo?: string }[];
}

export async function createInvoice(env: Env, orderNo: string, amount: number): Promise<QpayInvoice> {
  const data = (await authed(env, "/v2/invoice", {
    invoice_code: env.QPAY_INVOICE_CODE,
    sender_invoice_no: orderNo,
    invoice_receiver_code: "terminal",
    invoice_description: `GenZst ${orderNo}`,
    amount,
    callback_url: await callbackUrl(env, orderNo),
  })) as {
    invoice_id?: string;
    qr_text?: string;
    qr_image?: string;
    qPay_shortUrl?: string;
    urls?: { name?: string; description?: string; link?: string; logo?: string }[];
  };
  if (!data.invoice_id) throw new QpayError("no invoice_id");
  return {
    invoiceId: String(data.invoice_id),
    qrText: data.qr_text ?? null,
    qrImage: data.qr_image ?? null,
    shortUrl: data.qPay_shortUrl ?? null,
    urls: (data.urls ?? [])
      .filter((u) => typeof u.link === "string")
      .map((u) => ({ name: String(u.name ?? u.description ?? ""), link: u.link!, ...(u.logo ? { logo: u.logo } : {}) })),
  };
}

export interface QpayCheck {
  count: number;
  paidAmount: number;
  /** payment_id of the PAID rows (QPay's own ids). */
  paymentIds: string[];
}

export async function checkInvoice(env: Env, invoiceId: string): Promise<QpayCheck> {
  const data = (await authed(env, "/v2/payment/check", {
    object_type: "INVOICE",
    object_id: invoiceId,
    offset: { page_number: 1, page_limit: 100 },
  })) as { count?: number; paid_amount?: number; rows?: { payment_id?: string | number; payment_status?: string }[] };
  const rows = Array.isArray(data.rows) ? data.rows : [];
  return {
    count: Number(data.count) || 0,
    paidAmount: Number(data.paid_amount) || 0,
    paymentIds: rows.filter((r) => (r.payment_status ?? "PAID") === "PAID" && r.payment_id !== undefined).map((r) => String(r.payment_id)),
  };
}
