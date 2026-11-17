// `manual` adapter: no API. A shipment is created as `pending`; staff hand the parcel to a courier and
// PATCH /api/admin/shipments/{id} with status + tracking number by hand.
import type { DeliveryAdapter } from "../types";
import { DeliveryError } from "../types";

export const manualAdapter: DeliveryAdapter = {
  id: "manual",
  automatic: false,
  configured: () => true,
  async create() {
    return { providerRef: null, status: "pending" };
  },
  async cancel() {
    /* nothing to call */
  },
  async track() {
    throw new DeliveryError("unsupported", false);
  },
  parseWebhook() {
    throw new DeliveryError("unsupported", false);
  },
};
