// Delivery adapter interface (A3). One adapter per delivery company; `manual` and `mock` ship today.
// Server-only. The protocol of the `mock` adapter and how to add a real company: ./README.md.
import type { ShipmentStatus } from "../contracts";

/**
 * Everything a provider receives about an order. Deliberately minimal: who receives it, where, how many
 * items. No email, prices, payment data, IP or free-text order note.
 */
export interface DeliveryOrder {
  /** Shop reference shown on the label, e.g. GZ-251117-AB3D. */
  orderNo: string;
  /** Stable per shipment attempt; providers must treat a repeated key as the same request. */
  idempotencyKey: string;
  recipient: { name: string; phone: string; phone2: string | null };
  address: { city: string; district: string | null; khoroo: string | null; line: string };
  itemsCount: number;
}

export interface CreateResult {
  /** The company's shipment id (null only for the manual adapter). */
  providerRef: string | null;
  trackingNo?: string | null;
  trackingUrl?: string | null;
  /** 'pending' = waiting for a person (manual); 'created' = the company accepted it. */
  status: ShipmentStatus;
}

export interface TrackResult {
  status: ShipmentStatus;
  trackingNo?: string | null;
  trackingUrl?: string | null;
}

/** One status update parsed from a provider webhook. */
export interface ProviderEvent {
  /** The provider's unique event id (used to de-duplicate replays). */
  eventId: string;
  /** The provider's shipment id (shipments.provider_ref). */
  providerRef: string;
  status: ShipmentStatus;
  trackingNo?: string | null;
  trackingUrl?: string | null;
}

export interface DeliveryAdapter {
  readonly id: string;
  /** false = no API: shipments stay with a person (admin PATCHes status/tracking). */
  readonly automatic: boolean;
  /** true when the env has what this adapter needs (base URL, key). */
  configured(env: Env): boolean;
  create(env: Env, order: DeliveryOrder): Promise<CreateResult>;
  cancel(env: Env, providerRef: string): Promise<void>;
  track(env: Env, providerRef: string): Promise<TrackResult>;
  /** Parses an already signature-checked body. Throws DeliveryError('bad_payload') on garbage. */
  parseWebhook(rawBody: string, headers: Headers): ProviderEvent[];
}

/**
 * Provider failure. `code` is a short, PII-free string that is stored in shipments.last_error.
 * `retryable` = worth trying again later (network, timeout, 5xx, 429).
 */
export class DeliveryError extends Error {
  constructor(public readonly code: string, public readonly retryable: boolean) {
    super(code);
    this.name = "DeliveryError";
  }
}
