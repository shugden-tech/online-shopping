// GET /api/account/google/start?mode=login|link&return=/profile/ -> 302 to Google (404 when Google is not configured)
// Sets the signed state cookie (state, PKCE verifier, nonce, mode, return path; 10 minutes). `link` needs a session.
import { fail, hitRateLimit } from "../../../../lib/server";
import { authorizeUrl, googleEnabled, newState, safeReturn, stateCookie } from "../../../../lib/customers/google";
import { publicAccountRoute } from "../../../../lib/customers/session";

export const prerender = false;

export const GET = publicAccountRoute("google/start", async ({ request, url }, env, s, ip) => {
  if (!googleEnabled(env)) return fail(404, { form: "not_found" });
  if (!(await hitRateLimit(env.DB, `acct-google:${ip}`, 30, 600))) return fail(429, { form: "rate" });
  const mode = url.searchParams.get("mode") === "link" ? "link" : "login";
  const ret = safeReturn(url.searchParams.get("return"));
  if (mode === "link" && !s) return fail(401, { form: "unauthorized" });
  const { st, challenge } = await newState(mode, mode === "link" ? s!.customer.id : 0, ret);
  return new Response(null, {
    status: 302,
    headers: { Location: authorizeUrl(env, request, st, challenge), "Set-Cookie": await stateCookie(env, st), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
});
