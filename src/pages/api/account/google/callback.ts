// GET /api/account/google/callback?code=&state= -> 302 back to the saved return path with ?google=<result>
//   result: ok (signed in) | new (new account: the profile asks for the phone) | linked | taken (that Google
//   account belongs to another customer) | error | cancelled.
// The state must match the signed cookie; the code is exchanged with the PKCE verifier; the ID token is verified
// (signature via JWKS, iss, aud, exp, nonce). Accounts are found by Google `sub` only, never merged by e-mail.
import { safeEqual } from "../../../../lib/auth";
import { cleanName } from "../../../../lib/phone";
import { fail, hitRateLimit } from "../../../../lib/server";
import { clearStateCookie, exchangeCode, googleEnabled, readState, verifyIdToken } from "../../../../lib/customers/google";
import { createSession, publicAccountRoute } from "../../../../lib/customers/session";

export const prerender = false;

export const GET = publicAccountRoute("google/callback", async ({ request, url }, env, s, ip) => {
  if (!googleEnabled(env)) return fail(404, { form: "not_found" });
  const st = await readState(env, request);
  const back = (result: string, cookies: string[] = []) => {
    const h = new Headers({ Location: `${st?.r ?? "/profile/"}?google=${result}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    h.append("Set-Cookie", clearStateCookie());
    for (const c of cookies) h.append("Set-Cookie", c);
    return new Response(null, { status: 302, headers: h });
  };
  if (!(await hitRateLimit(env.DB, `acct-google:${ip}`, 30, 600))) return fail(429, { form: "rate" });
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!st || !state || !(await safeEqual(state, st.s))) return back("error");
  if (url.searchParams.get("error")) return back("cancelled");
  if (!code || code.length > 2048) return back("error");

  let claims;
  try {
    const idToken = await exchangeCode(env, request, code, st.v);
    claims = idToken ? await verifyIdToken(env, request, idToken, st.n) : null;
  } catch (err) {
    console.error("[account/google] exchange failed", err instanceof Error ? err.message : "error");
    claims = null;
  }
  if (!claims) return back("error");
  const email = claims.email_verified ? claims.email ?? null : null;
  const db = env.DB;
  const owner = await db.prepare("SELECT id FROM customers WHERE google_sub = ?1 AND deleted_at IS NULL").bind(claims.sub).first<{ id: number }>();

  if (st.m === "link") {
    if (!s || s.customer.id !== st.c) return back("error");
    if (owner && owner.id !== s.customer.id) return back("taken");
    await db.prepare("UPDATE customers SET google_sub = ?1, email = ?2, updated_at = datetime('now') WHERE id = ?3").bind(claims.sub, email, s.customer.id).run();
    return back("linked");
  }

  if (owner) {
    const session = await createSession(db, owner.id, request);
    return back("ok", session.cookies);
  }
  const name = cleanName(claims.name ?? "") ?? "";
  let id: number;
  try {
    const row = await db
      .prepare("INSERT INTO customers (phone, name, display_name, google_sub, email) VALUES (NULL, ?1, ?1, ?2, ?3) RETURNING id")
      .bind(name, claims.sub, email)
      .first<{ id: number }>();
    id = row!.id;
  } catch (err) {
    if (!/UNIQUE/i.test(String(err))) throw err;
    // a parallel callback created it first
    const again = await db.prepare("SELECT id FROM customers WHERE google_sub = ?1 AND deleted_at IS NULL").bind(claims.sub).first<{ id: number }>();
    if (!again) return back("error");
    id = again.id;
  }
  const session = await createSession(db, id, request);
  return back("new", session.cookies);
});
