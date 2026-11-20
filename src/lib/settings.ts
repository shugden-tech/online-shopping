// Store settings (lead-owned): typed read/write over the store_settings table. Missing rows = defaults
// from SETTINGS in ./contracts. Used by every module that needs a switch (checkout open, payment
// methods, hold times, delivery fees).
import { SETTINGS, type Actor, type SettingKey, type Settings } from "./contracts";

type D1 = import("@cloudflare/workers-types").D1Database;

export async function getSettings(db: D1): Promise<Settings> {
  const out = { ...SETTINGS } as Settings;
  let res: { results?: { key: string; value_json: string }[] };
  try {
    res = await db.prepare("SELECT key, value_json FROM store_settings").all<{ key: string; value_json: string }>();
  } catch (e) {
    // Never fail a page over settings: fall back to the defaults and log the problem.
    console.error("getSettings: using defaults", e);
    return out;
  }
  for (const r of res.results ?? []) {
    if (!(r.key in SETTINGS)) continue;
    try {
      (out as Record<string, unknown>)[r.key] = JSON.parse(r.value_json);
    } catch {
      /* keep default */
    }
  }
  return out;
}

export async function getSetting<K extends SettingKey>(db: D1, key: K): Promise<Settings[K]> {
  let r: { value_json: string } | null;
  try {
    r = await db.prepare("SELECT value_json FROM store_settings WHERE key = ?1").bind(key).first<{ value_json: string }>();
  } catch (e) {
    console.error("getSetting: using default", key, e);
    return SETTINGS[key] as Settings[K];
  }
  if (!r) return SETTINGS[key] as Settings[K];
  try {
    return JSON.parse(r.value_json) as Settings[K];
  } catch {
    return SETTINGS[key] as Settings[K];
  }
}

/** Validates one value against the type of its default. Returns an error code or null. */
export function checkSetting(key: string, value: unknown): string | null {
  if (!(key in SETTINGS)) return "unknown";
  const def = (SETTINGS as Record<string, unknown>)[key];
  if (key.startsWith("delivery.fee") || key === "delivery.free_over") {
    return value === null || (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 10_000_000) ? null : "invalid";
  }
  if (key.startsWith("holds.")) return Number.isInteger(value) && (value as number) >= 5 && (value as number) <= 10_080 ? null : "invalid";
  if (key === "delivery.provider") return typeof value === "string" && /^[a-z0-9_-]{2,32}$/.test(value) ? null : "invalid";
  if (typeof def === "string") return typeof value === "string" && value.length <= 300 ? null : "invalid";
  if (typeof def === "boolean") return typeof value === "boolean" ? null : "invalid";
  return "invalid";
}

/** Statements that upsert the given settings (run them in the caller's batch together with the audit row). */
export function settingStatements(db: D1, patch: Partial<Settings>, actor: Actor) {
  return Object.entries(patch).map(([k, v]) =>
    db
      .prepare(
        `INSERT INTO store_settings (key, value_json, updated_at, updated_by) VALUES (?1, ?2, datetime('now'), ?3)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .bind(k, JSON.stringify(v), actor),
  );
}
