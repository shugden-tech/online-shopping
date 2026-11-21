// Admin-side helpers for outbound webhook endpoints (lead, 0004). Server-only.
import { WEBHOOK_EVENTS } from "./contracts";
import { validEndpointUrl } from "./webhooks";

export interface EndpointRow {
  id: number; url: string; description: string | null; events_json: string; active: number; created_at: string; updated_at: string;
  failed?: number; pending?: number; last_delivered_at?: string | null;
}

export function endpointView(r: EndpointRow) {
  let events: string[] = [];
  try { events = JSON.parse(r.events_json) as string[]; } catch { /* keep [] */ }
  return {
    id: r.id, url: r.url, description: r.description, events, active: r.active === 1, createdAt: r.created_at, updatedAt: r.updated_at,
    failed: r.failed ?? 0, pending: r.pending ?? 0, lastDeliveredAt: r.last_delivered_at ?? null,
  };
}

export interface EndpointInput { url?: string; events?: string[]; description?: string | null; active?: boolean }

/** Validates a create (url + events required) or a patch (any subset). */
export function parseEndpointInput(v: unknown, create: boolean, allowLocal = false): EndpointInput | { errors: Record<string, string> } {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const out: EndpointInput = {};
  for (const k of Object.keys(o)) if (!["url", "events", "description", "active"].includes(k)) errors[k] = "unknown";
  if (o.url !== undefined || create) {
    if (!validEndpointUrl(o.url, allowLocal)) errors.url = "invalid";
    else out.url = o.url;
  }
  if (o.events !== undefined || create) {
    const ev = Array.isArray(o.events) ? [...new Set(o.events)] : null;
    if (!ev || !ev.length || !ev.every((e) => typeof e === "string" && (WEBHOOK_EVENTS as readonly string[]).includes(e))) errors.events = "invalid";
    else out.events = ev as string[];
  }
  if (o.description !== undefined) {
    if (o.description !== null && (typeof o.description !== "string" || o.description.length > 120)) errors.description = "invalid";
    else out.description = typeof o.description === "string" ? o.description.trim() || null : null;
  }
  if (o.active !== undefined) {
    if (typeof o.active !== "boolean") errors.active = "invalid";
    else out.active = o.active;
  }
  if (!create && !Object.keys(out).length && !Object.keys(errors).length) errors.form = "empty";
  return Object.keys(errors).length ? { errors } : out;
}
