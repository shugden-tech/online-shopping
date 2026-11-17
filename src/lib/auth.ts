// Admin authentication + permissions (lead-owned). Every /api/admin/* route calls authorize() first.
//
//   Authorization: Bearer <token>
//   ADMIN_TOKEN (Worker secret, >= 24 chars) -> role "owner"  (every permission)
//   STAFF_TOKEN (Worker secret, optional)    -> role "staff"  (ROLE_PERMISSIONS.staff)
//
// Failed attempts are rate limited per IP (20 / 10 min). A token that is set but too short disables
// that role rather than accepting a weak secret.
import { ROLE_PERMISSIONS, type Actor, type Permission, type Role } from "./contracts";
import { fail, hitRateLimit } from "./server";

export const ADMIN_MIN_TOKEN = 24;

const enc = new TextEncoder();

/** Constant-time comparison: both sides are hashed first, so length and content leak nothing. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

export interface AdminSession {
  role: Role;
  actor: Actor;
  can: (p: Permission) => boolean;
}

function session(role: Role): AdminSession {
  const perms = new Set<Permission>(ROLE_PERMISSIONS[role]);
  return { role, actor: `admin:${role}`, can: (p) => perms.has(p) };
}

/**
 * Returns the session when the bearer token is valid AND its role has `permission`;
 * otherwise a ready 401 / 403 / 429 / 503 Response. Pass no permission to accept any valid admin.
 */
export async function authorize(request: Request, env: Env, ip: string, permission?: Permission): Promise<AdminSession | Response> {
  const owner = env.ADMIN_TOKEN ?? "";
  const staff = env.STAFF_TOKEN ?? "";
  if (owner.length < ADMIN_MIN_TOKEN) {
    console.error(`[admin] ADMIN_TOKEN is not set or shorter than ${ADMIN_MIN_TOKEN} characters`);
    return fail(503, { form: "admin-disabled" });
  }
  const m = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("Authorization") ?? "");
  let role: Role | null = null;
  if (m) {
    const token = m[1]!;
    // compare against both so timing does not reveal which role a guess is closest to
    const [isOwner, isStaff] = await Promise.all([safeEqual(token, owner), safeEqual(token, staff.length >= ADMIN_MIN_TOKEN ? staff : "\u0000disabled")]);
    role = isOwner ? "owner" : isStaff ? "staff" : null;
  }
  if (!role) {
    const allowed = await hitRateLimit(env.DB, `admin-fail:${ip}`, 20, 600);
    if (!allowed) return fail(429, { form: "rate" });
    return fail(401, { form: "unauthorized" }, { "WWW-Authenticate": 'Bearer realm="genzst-admin"' });
  }
  const s = session(role);
  if (permission && !s.can(permission)) return fail(403, { form: "forbidden" });
  return s;
}
