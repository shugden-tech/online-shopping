// `mock` adapter: speaks the small HTTP JSON protocol documented in ../README.md ("Mock protocol").
// Used by scripts/test-delivery.mjs against scripts/mock-delivery.mjs (DELIVERY_BASE_URL / DELIVERY_API_KEY).
// It is also the template for a real company adapter.
import { SHIPMENT_STATUSES, type ShipmentStatus } from "../../contracts";
import type { DeliveryAdapter, DeliveryOrder, ProviderEvent, TrackResult } from "../types";
import { DeliveryError } from "../types";

const TIMEOUT_MS = 10_000;
const REF_RE = /^[A-Za-z0-9_-]{1,80}$/;

function base(env: Env): string {
  return (env.DELIVERY_BASE_URL ?? "").replace(/\/+$/, "");
}

/** Calls the provider. Errors become PII-free DeliveryError codes (never the response body). */
async function call(env: Env, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(base(env) + path, {
      method,
      headers: {
        Authorization: `Bearer ${env.DELIVERY_API_KEY ?? ""}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    throw new DeliveryError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", true);
  }
  if (!res.ok) {
    await res.body?.cancel();
    const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
    throw new DeliveryError(`http_${res.status}`, retryable);
  }
  try {
    const data = (await res.json()) as unknown;
    if (!data || typeof data !== "object") throw new Error("not an object");
    return data as Record<string, unknown>;
  } catch {
    throw new DeliveryError("bad_response", true);
  }
}

const str = (v: unknown, max = 500) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const httpsUrl = (v: unknown) => {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
};
const status = (v: unknown): ShipmentStatus | null =>
  typeof v === "string" && (SHIPMENT_STATUSES as readonly string[]).includes(v) && v !== "pending" ? (v as ShipmentStatus) : null;

export const mockAdapter: DeliveryAdapter = {
  id: "mock",
  automatic: true,
  configured: (env) => /^https?:\/\//.test(env.DELIVERY_BASE_URL ?? "") && (env.DELIVERY_API_KEY ?? "").length > 0,

  async create(env, order: DeliveryOrder) {
    const data = await call(env, "POST", "/v1/shipments", {
      reference: order.orderNo,
      idempotencyKey: order.idempotencyKey,
      recipient: order.recipient,
      address: order.address,
      itemsCount: order.itemsCount,
    });
    const id = str(data.id, 80);
    if (!id || !REF_RE.test(id)) throw new DeliveryError("bad_response", true);
    return { providerRef: id, trackingNo: str(data.trackingNo, 64), trackingUrl: httpsUrl(data.trackingUrl), status: status(data.status) ?? "created" };
  },

  async cancel(env, providerRef) {
    await call(env, "POST", `/v1/shipments/${encodeURIComponent(providerRef)}/cancel`, {});
  },

  async track(env, providerRef): Promise<TrackResult> {
    const data = await call(env, "GET", `/v1/shipments/${encodeURIComponent(providerRef)}`);
    const s = status(data.status);
    if (!s) throw new DeliveryError("bad_response", true);
    return { status: s, trackingNo: str(data.trackingNo, 64), trackingUrl: httpsUrl(data.trackingUrl) };
  },

  parseWebhook(rawBody) {
    let data: unknown;
    try {
      data = JSON.parse(rawBody);
    } catch {
      throw new DeliveryError("bad_payload", false);
    }
    const events = (data as { events?: unknown })?.events;
    if (!Array.isArray(events) || events.length === 0 || events.length > 50) throw new DeliveryError("bad_payload", false);
    return events.map((e): ProviderEvent => {
      const o = (e ?? {}) as Record<string, unknown>;
      const eventId = str(o.id, 120);
      const providerRef = str(o.shipmentId, 80);
      const s = status(o.status);
      if (!eventId || !providerRef || !REF_RE.test(providerRef) || !s) throw new DeliveryError("bad_payload", false);
      return {
        eventId,
        providerRef,
        status: s,
        ...(o.trackingNo !== undefined ? { trackingNo: str(o.trackingNo, 64) } : {}),
        ...(o.trackingUrl !== undefined ? { trackingUrl: httpsUrl(o.trackingUrl) } : {}),
      };
    });
  },
};
