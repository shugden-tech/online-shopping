// Wire (https://docs.wire.mn/en/docs) client: hosted checkout + signed webhooks (CONTRACTS §11). Server-only.
//   POST {WIRE_BASE_URL}/v1/payment_intents        { amount, currency:"MNT", description, metadata:{order_id}, expires_at } -> pi_…
//   POST {WIRE_BASE_URL}/v1/checkout/sessions      { payment_intent, success_url, cancel_url } -> cs_…, url (pay.wire.mn/c/…)
//   GET  {WIRE_BASE_URL}/v1/payment_intents/{id}   the source of truth before an order is marked paid
// Auth: `Authorization: Bearer WIRE_API_KEY` (sk_live_ only; Wire has no sandbox). Every POST carries an
// Idempotency-Key (≤ 255 chars) and a JSON body. Amounts are whole tögrög. Hosted mode never calls /confirm.
// Webhooks: `WirePayment-Signature: t=<unix>,v1=<hex HMAC-SHA256(WIRE_WEBHOOK_SECRET, t + "." + rawBody)>`.
// Nothing about the customer is sent to Wire: only the order number and the amount.
// The API key is never logged or returned; error messages carry Wire's code and request_id only.
import type { Settings } from "../contracts";

const TIMEOUT_MS = 10_000;
export const WIRE_DEFAULT_BASE = "https://api.wire.mn";
export const WIRE_SIGNATURE_HEADER = "WirePayment-Signature";
export const WIRE_TOLERANCE_S = 300;
/** Wire: a PaymentIntent's expires_at is 5 minutes to 24 hours from now. */
export const WIRE_MIN_EXPIRY_S = 5 * 60;
export const WIRE_MAX_EXPIRY_S = 24 * 60 * 60;

// (plain fields, no constructor parameter properties: scripts/test-wire.mjs imports this file with Node's type stripping)
export class WireError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  constructor(message: string, status?: number, code?: string, requestId?: string) {
    super(message);
    this.name = "WireError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
  /** Worth retrying with the same Idempotency-Key: network, 408, 409 in-flight, 424 operator, 429, 5xx. */
  get transient(): boolean {
    const s = this.status;
    return s === undefined || s === 408 || s === 424 || s === 429 || s >= 500 || this.code === "idempotency_in_flight";
  }
}

/** The base URL: https only, except a local mock on localhost / 127.0.0.1 (tests). */
export function wireBase(env: Pick<Env, "WIRE_BASE_URL">): string | null {
  const raw = (env.WIRE_BASE_URL || WIRE_DEFAULT_BASE).trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  try {
    const u = new URL(raw);
    if (u.protocol === "https:") return raw;
    if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) return raw;
  } catch {
    /* invalid */
  }
  return null;
}

/** Wire can be offered only when the store switch is on AND both secrets are configured. */
export function wireConfigured(env: Env): boolean {
  return Boolean(env.WIRE_API_KEY && env.WIRE_WEBHOOK_SECRET && wireBase(env));
}
export function wireEnabled(env: Env, settings: Settings): boolean {
  return settings["payments.wire.enabled"] === true && wireConfigured(env);
}

/* ---------------- HTTP ---------------- */

const KEY_RE = /^[\x21-\x7e]{1,255}$/;

interface CallOpts {
  method: "GET" | "POST";
  body?: unknown;
  idempotencyKey?: string;
}

/** One Wire API call. POST without a valid Idempotency-Key is refused here, before anything is sent. */
export async function wireCall(env: Env, path: string, opts: CallOpts): Promise<Record<string, unknown>> {
  const base = wireBase(env);
  if (!base || !env.WIRE_API_KEY) throw new WireError("not configured", undefined, "not_configured");
  const headers: Record<string, string> = { Authorization: `Bearer ${env.WIRE_API_KEY}`, Accept: "application/json" };
  if (opts.method === "POST") {
    if (!opts.idempotencyKey || !KEY_RE.test(opts.idempotencyKey)) throw new WireError("Idempotency-Key required", 400, "idempotency_key_required");
    headers["Idempotency-Key"] = opts.idempotencyKey;
    headers["Content-Type"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: opts.method,
      headers,
      body: opts.method === "POST" ? JSON.stringify(opts.body ?? {}) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new WireError(`network: ${String((err as Error)?.name ?? err)}`);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const e = (data as { error?: { code?: unknown; request_id?: unknown } } | null)?.error;
    const code = typeof e?.code === "string" ? e.code.slice(0, 80) : undefined;
    const rid = typeof e?.request_id === "string" ? e.request_id.slice(0, 80) : undefined;
    throw new WireError(`HTTP ${res.status}${code ? ` ${code}` : ""}${rid ? ` (${rid})` : ""}`, res.status, code, rid);
  }
  if (!data || typeof data !== "object") throw new WireError("invalid JSON", res.status, "invalid_json");
  return data as Record<string, unknown>;
}

/* ---------------- objects ---------------- */

export const WIRE_INTENT_RE = /^pi_[A-Za-z0-9]{6,64}$/;
export const WIRE_SESSION_RE = /^cs_[A-Za-z0-9]{6,64}$/;
export const WIRE_EVENT_RE = /^evt_[A-Za-z0-9]{6,64}$/;

export interface WireIntent {
  id: string;
  status: string;
  amount: number;
  currency: string;
  /** ch_… once paid (event payload `charge`, or `latest_charge` on the object), else null. */
  charge: string | null;
  orderId: string | null;
  expiresAt: number | null;
}
export interface WireCheckout {
  id: string;
  url: string;
  status: string;
  intentId: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

function toIntent(d: Record<string, unknown>): WireIntent {
  const id = str(d.id);
  if (!id || !WIRE_INTENT_RE.test(id)) throw new WireError("no payment_intent id", undefined, "invalid_response");
  const meta = d.metadata && typeof d.metadata === "object" ? (d.metadata as Record<string, unknown>) : {};
  const ch = str(d.charge) ?? str(d.latest_charge);
  return {
    id,
    status: str(d.status) ?? "unknown",
    amount: Number.isInteger(d.amount) ? (d.amount as number) : 0,
    currency: str(d.currency) ?? "",
    charge: ch && /^ch_[A-Za-z0-9]{1,64}$/.test(ch) ? ch : null,
    orderId: str(meta.order_id),
    expiresAt: Number.isInteger(d.expires_at) ? (d.expires_at as number) : null,
  };
}

/** Clamps a wanted expiry (unix s) into Wire's window, measured from `nowS`. */
export function wireExpiry(wantS: number, nowS = Math.floor(Date.now() / 1000)): number {
  // a little slack so clock skew never makes Wire answer "too soon" / "too late"
  return Math.min(nowS + WIRE_MAX_EXPIRY_S - 60, Math.max(nowS + WIRE_MIN_EXPIRY_S + 30, Math.floor(wantS)));
}

export async function createWireIntent(
  env: Env,
  p: { amount: number; orderNo: string; expiresAt: number; idempotencyKey: string },
): Promise<WireIntent> {
  if (!Number.isInteger(p.amount) || p.amount < 1 || p.amount > 1_000_000_000) throw new WireError("amount must be whole tögrög", 400, "amount_invalid");
  const d = await wireCall(env, "/v1/payment_intents", {
    method: "POST",
    idempotencyKey: p.idempotencyKey,
    body: {
      amount: p.amount,
      currency: "MNT",
      description: `GenZst ${p.orderNo}`,
      metadata: { order_id: p.orderNo },
      expires_at: wireExpiry(p.expiresAt),
    },
  });
  return toIntent(d);
}

export async function createWireCheckout(
  env: Env,
  p: { intentId: string; successUrl: string; cancelUrl: string; idempotencyKey: string },
): Promise<WireCheckout> {
  const d = await wireCall(env, "/v1/checkout/sessions", {
    method: "POST",
    idempotencyKey: p.idempotencyKey,
    body: { payment_intent: p.intentId, success_url: p.successUrl, cancel_url: p.cancelUrl },
  });
  const id = str(d.id);
  const url = str(d.url);
  if (!id || !WIRE_SESSION_RE.test(id) || !url || !/^https:\/\//.test(url)) throw new WireError("no checkout url", undefined, "invalid_response");
  return { id, url, status: str(d.status) ?? "open", intentId: str(d.payment_intent) ?? p.intentId };
}

export async function fetchWireIntent(env: Env, id: string): Promise<WireIntent> {
  if (!WIRE_INTENT_RE.test(id)) throw new WireError("bad intent id", 400, "invalid_id");
  return toIntent(await wireCall(env, `/v1/payment_intents/${encodeURIComponent(id)}`, { method: "GET" }));
}

/* ---------------- webhook signature ---------------- */

const enc = new TextEncoder();

export async function wireSign(secret: string, t: number | string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${rawBody}`)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

function sameHex(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ (y[i] ?? 0);
  return diff === 0;
}

export type WireSigResult = { ok: true; t: number } | { ok: false; reason: "no_secret" | "missing" | "malformed" | "stale" | "mismatch" };

/**
 * Verifies `WirePayment-Signature` over the RAW body: v1 = hex HMAC-SHA256(secret, t + "." + rawBody), |now − t| ≤ 300 s,
 * constant-time compare. Several v1 entries (secret rotation) are accepted if any one matches.
 */
export async function verifyWireSignature(
  secret: string | undefined,
  header: string | null,
  rawBody: string,
  nowS = Math.floor(Date.now() / 1000),
  toleranceS = WIRE_TOLERANCE_S,
): Promise<WireSigResult> {
  if (!secret) return { ok: false, reason: "no_secret" };
  if (!header) return { ok: false, reason: "missing" };
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) sigs.push(v.toLowerCase());
  }
  if (t === null || !sigs.length) return { ok: false, reason: "malformed" };
  if (Math.abs(nowS - t) > toleranceS) return { ok: false, reason: "stale" };
  const want = await wireSign(secret, t, rawBody);
  let match = false;
  for (const s of sigs) match = sameHex(want, s) || match; // no early exit
  return match ? { ok: true, t } : { ok: false, reason: "mismatch" };
}

/* ---------------- events ---------------- */

export const WIRE_EVENTS = ["payment_intent.succeeded", "payment_intent.payment_failed", "payment_intent.canceled", "charge.refunded"] as const;

export interface WireEvent {
  id: string;
  type: string;
  created: number | null;
  /** data.id: pi_… for payment_intent.*, re_… for charge.refunded. */
  objectId: string | null;
  /** The intent the event is about (data.id for payment_intent.*, data.payment_intent for a refund when present). */
  intentId: string | null;
  charge: string | null;
  amount: number | null;
}

/** Parses an already-verified body. Null when it is not a Wire event envelope. */
export function parseWireEvent(rawBody: string): WireEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  const id = str(e.id);
  const type = str(e.type);
  if (!id || !WIRE_EVENT_RE.test(id) || !type || type.length > 80) return null;
  const data = e.data && typeof e.data === "object" ? (e.data as Record<string, unknown>) : {};
  const objectId = str(data.id);
  const pi = type.startsWith("payment_intent.") ? objectId : str(data.payment_intent);
  return {
    id,
    type,
    created: Number.isInteger(e.created) ? (e.created as number) : null,
    objectId,
    intentId: pi && WIRE_INTENT_RE.test(pi) ? pi : null,
    charge: str(data.charge),
    amount: Number.isInteger(data.amount) ? (data.amount as number) : null,
  };
}
