// Adapter registry. Add a real company here (see ./README.md, "Adding a delivery company").
import { getSetting } from "../settings";
import { manualAdapter } from "./adapters/manual";
import { mockAdapter } from "./adapters/mock";
import type { DeliveryAdapter } from "./types";

const ADAPTERS: Record<string, DeliveryAdapter> = {
  [manualAdapter.id]: manualAdapter,
  [mockAdapter.id]: mockAdapter,
};

export const PROVIDER_ID_RE = /^[a-z0-9_-]{2,32}$/;

export function getAdapter(id: string): DeliveryAdapter | null {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, id) ? ADAPTERS[id]! : null;
}

export const providerIds = () => Object.keys(ADAPTERS);

/**
 * The provider for a new shipment: the one the request names, else the `delivery.provider` setting.
 * Returns an error code when it is unknown or not configured in this environment.
 */
export async function resolveProvider(env: Env, requested: string | undefined): Promise<{ adapter: DeliveryAdapter } | { error: "unknown" | "not-configured" }> {
  const id = requested ?? (await getSetting(env.DB, "delivery.provider"));
  const adapter = getAdapter(id);
  if (!adapter) return { error: "unknown" };
  if (!adapter.configured(env)) return { error: "not-configured" };
  return { adapter };
}
