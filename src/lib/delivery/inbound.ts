// Inbound delivery webhook handling shared by the public route and the admin "replay" action (0004).
import { getAdapter } from "./registry";
import { applyProviderEvents } from "./service";
import { DeliveryError } from "./types";
import { fail, json } from "../server";

/** Parses and applies a signature-checked body. Shared with the admin "replay" action. */
export async function handleSigned(
  env: Env,
  provider: string,
  raw: string,
  headers: Headers,
  onIds: (ids: string[]) => void = () => {},
): Promise<[Response, unknown]> {
  const adapter = getAdapter(provider);
  if (!adapter?.automatic) return [fail(404, { provider: "unknown" }), { error: "unknown-provider" }];
  let events;
  try {
    events = adapter.parseWebhook(raw, headers);
  } catch (err) {
    if (err instanceof DeliveryError) return [fail(400, { form: err.code }), { error: err.code }];
    throw err;
  }
  onIds(events.map((e) => e.eventId));
  const results = await applyProviderEvents(env, adapter, events);
  const unknown = results.filter((r) => r.result === "unknown-shipment");
  if (unknown.length) {
    console.warn(`[delivery/webhook] ${adapter.id}: ${unknown.length} event(s) for unknown shipments`);
    return [json(404, { ok: false, errors: { shipment: "unknown" }, results }), results];
  }
  return [json(200, { ok: true, results }), results];
}
