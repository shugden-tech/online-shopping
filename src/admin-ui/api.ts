// Admin API client: bearer token in this tab's sessionStorage, JSON envelope `{ ok, ... }` /
// `{ ok:false, errors }` (docs/CONTRACTS.md §1), 401 -> back to the login screen.
import type { Permission, Role } from "../lib/contracts";
import { errorText } from "./labels";

const SLOT = "gz-admin-token";

export function getToken(): string {
  try { return sessionStorage.getItem(SLOT) ?? ""; } catch { return ""; }
}
export function setToken(t: string) {
  try { if (t) sessionStorage.setItem(SLOT, t); else sessionStorage.removeItem(SLOT); } catch { /* storage blocked */ }
}

export interface Session { role: Role; permissions: Permission[] }

/** Set by the shell: called on any 401 so every view falls back to the login screen. */
let onUnauthorized: (msg: string) => void = () => {};
export const setUnauthorizedHandler = (fn: (msg: string) => void) => { onUnauthorized = fn; };

export interface Res<T = any> {
  ok: boolean;
  status: number;
  data: T & { ok?: boolean; errors?: Record<string, string> };
  /** Readable Mongolian message for a failure ("" on success). */
  error: string;
}

export interface ApiOpts {
  method?: string;
  body?: unknown;
  form?: FormData;
  /** Context-specific explanation for a 409 conflict. */
  conflict?: string;
  token?: string;
}

export async function api<T = any>(path: string, opts: ApiOpts = {}): Promise<Res<T>> {
  const headers: Record<string, string> = { Authorization: `Bearer ${opts.token ?? getToken()}` };
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) { body = JSON.stringify(opts.body); headers["Content-Type"] = "application/json"; }
  let status = 0;
  let data: any = {};
  try {
    const res = await fetch(path, { method: opts.method ?? "GET", headers, body, cache: "no-store" });
    status = res.status;
    try { data = await res.json(); } catch { data = {}; }
  } catch {
    return { ok: false, status: 0, data: {} as any, error: "Сүлжээний алдаа: сервертэй холбогдож чадсангүй." };
  }
  const ok = status >= 200 && status < 300 && data?.ok !== false;
  if (status === 401 && !opts.token) onUnauthorized("Нэвтрэх хугацаа дууссан эсвэл токен буруу. Дахин нэвтэрнэ үү.");
  return { ok, status, data, error: ok ? "" : errorText(status, data?.errors, opts.conflict) };
}

export const qs = (o: Record<string, string | number | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== "" && v !== null && v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};
export const enc = encodeURIComponent;

/* ---------- tolerant readers (snake_case or camelCase rows) ---------- */

export const pick = (o: any, ...keys: string[]): any => {
  if (!o) return undefined;
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
};

export interface OrderLine {
  sku?: string; slug?: string; brand?: string; name?: string; ml?: number; qty: number; price?: number;
  /** Bundle line (0005): parts are per ONE bundle. */
  bundle?: { id: string; nameMn: string; nameEn: string | null; parts: { sku: string; brand: string; name: string; ml: number; qty: number }[] };
}
export interface OrderView {
  id: number | null; no: string; createdAt: string; status: string; paymentStatus: string; holdExpiresAt: string | null;
  name: string; phone: string; phone2: string; city: string; district: string; khoroo: string; address: string; note: string;
  payment: string; items: OrderLine[]; subtotal: number; delivery: number; total: number; locale: string; cancelReason: string;
}
export function orderView(o: any): OrderView {
  let items = pick(o, "items") ?? [];
  if (!Array.isArray(items) && typeof o?.items_json === "string") { try { items = JSON.parse(o.items_json); } catch { items = []; } }
  return {
    id: pick(o, "id") ?? null,
    no: pick(o, "orderNo", "order_no", "no") ?? "",
    createdAt: pick(o, "createdAt", "created_at") ?? "",
    status: pick(o, "status") ?? "",
    paymentStatus: pick(o, "paymentStatus", "payment_status") ?? "",
    holdExpiresAt: pick(o, "holdExpiresAt", "hold_expires_at") ?? null,
    name: pick(o, "name") ?? "", phone: pick(o, "phone") ?? "", phone2: pick(o, "phone2") ?? "",
    city: pick(o, "city") ?? "", district: pick(o, "district") ?? "", khoroo: pick(o, "khoroo") ?? "",
    address: pick(o, "address") ?? "", note: pick(o, "note") ?? "",
    payment: pick(o, "payment", "paymentMethod", "payment_method") ?? "",
    items: Array.isArray(items) ? items : [],
    subtotal: pick(o, "subtotal") ?? 0, delivery: pick(o, "delivery") ?? 0, total: pick(o, "total") ?? 0,
    locale: pick(o, "locale") ?? "", cancelReason: pick(o, "cancelReason", "cancel_reason") ?? "",
  };
}

export interface PaymentView {
  id: number; orderNo: string; provider: string; providerRef: string; amount: number; paidAmount: number | null;
  status: string; createdAt: string; paidAt: string;
}
export const paymentView = (p: any): PaymentView => ({
  id: pick(p, "id"),
  orderNo: pick(p, "orderNo", "order_no") ?? "",
  provider: pick(p, "provider") ?? "",
  providerRef: pick(p, "providerRef", "provider_ref") ?? "",
  amount: pick(p, "amount") ?? 0,
  paidAmount: pick(p, "paidAmount", "paid_amount") ?? null,
  status: pick(p, "status") ?? "",
  createdAt: pick(p, "createdAt", "created_at") ?? "",
  paidAt: pick(p, "paidAt", "paid_at") ?? "",
});

export interface ShipmentView {
  id: number; orderNo: string; provider: string; providerRef: string; trackingNo: string; trackingUrl: string; status: string;
  attempts: number; lastError: string; nextRetryAt: string; createdAt: string; updatedAt: string;
  courier: string; fee: number | null; notes: string;
}
export const shipmentView = (s: any): ShipmentView => ({
  courier: pick(s, "courier") ?? "",
  fee: pick(s, "fee") ?? null,
  notes: pick(s, "notes") ?? "",
  id: pick(s, "id"),
  orderNo: pick(s, "orderNo", "order_no") ?? "",
  provider: pick(s, "provider") ?? "",
  providerRef: pick(s, "providerRef", "provider_ref") ?? "",
  trackingNo: pick(s, "trackingNo", "tracking_no") ?? "",
  trackingUrl: pick(s, "trackingUrl", "tracking_url") ?? "",
  status: pick(s, "status") ?? "",
  attempts: pick(s, "attempts") ?? 0,
  lastError: pick(s, "lastError", "last_error") ?? "",
  nextRetryAt: pick(s, "nextRetryAt", "next_retry_at") ?? "",
  createdAt: pick(s, "createdAt", "created_at") ?? "",
  updatedAt: pick(s, "updatedAt", "updated_at") ?? "",
});

/** Keyset list rows: contract says `items`; older routes used a named array. */
export const rows = (d: any, legacy?: string): any[] => (Array.isArray(d?.items) ? d.items : legacy && Array.isArray(d?.[legacy]) ? d[legacy] : []);
