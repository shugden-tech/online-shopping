// Audit log (lead-owned). Every admin write adds one row IN THE SAME D1 BATCH as the change, so the log
// never says something happened that did not (or misses something that did).
import type { Actor } from "./contracts";

type D1 = import("@cloudflare/workers-types").D1Database;

export type AuditEntity = "product" | "sku" | "order" | "payment" | "shipment" | "settings" | "media" | "webhook" | "bundle";

/** A prepared INSERT for the caller's batch. `data` must not contain secrets or full customer PII. */
export function auditStatement(db: D1, actor: Actor, action: string, entity: AuditEntity, entityId: string | number | null, data?: unknown) {
  return db
    .prepare("INSERT INTO audit_log (actor, action, entity, entity_id, data_json) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(actor, action, entity, entityId === null ? null : String(entityId), data === undefined ? null : JSON.stringify(data));
}
