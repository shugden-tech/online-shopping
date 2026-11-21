// /api/account/avatar  (signed in)
//   GET    -> the customer's own avatar image (404 when none). Same-origin only; private cache (the URL carries ?v=).
//   POST   multipart `file`: jpeg / png / webp by magic bytes, <= 2 MB -> { ok, customer }
//          stored in R2 MEDIA at customers/<id>.<ext> (the profile page crops it to a square before upload)
//   DELETE -> { ok, customer }
import { sniffImage } from "../../../lib/catalog/media";
import { fail, json } from "../../../lib/server";
import { accountRoute } from "../../../lib/customers/session";
import { customerView, loadCustomer } from "../../../lib/customers/store";

export const prerender = false;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const KEY_RE = /^customers\/\d+\.(jpg|png|webp)$/;

export const GET = accountRoute("avatar", async (_ctx, env, s) => {
  const key = s.customer.avatar_key;
  if (!env.MEDIA || !key || !KEY_RE.test(key)) return fail(404, { form: "not_found" });
  const obj = await env.MEDIA.get(key);
  if (!obj) return fail(404, { form: "not_found" });
  const type = obj.httpMetadata?.contentType ?? "";
  if (!/^image\/(jpeg|png|webp)$/.test(type)) return fail(404, { form: "not_found" });
  return new Response(obj.body as unknown as BodyInit, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(obj.size),
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
      "Cross-Origin-Resource-Policy": "same-origin",
      Vary: "Cookie",
    },
  });
});

export const POST = accountRoute("avatar", async ({ request }, env, s) => {
  if (!env.MEDIA) return fail(503, { form: "media-disabled" });
  if (!/^multipart\/form-data\b/i.test(request.headers.get("Content-Type") ?? "")) return fail(415, { form: "server" });
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_AVATAR_BYTES + 16 * 1024) return fail(413, { file: "too_large" });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, { form: "invalid" });
  }
  const file = form.get("file");
  if (!file || typeof file === "string") return fail(400, { file: "required" });
  if ((file as File).size > MAX_AVATAR_BYTES) return fail(413, { file: "too_large" });
  const bytes = new Uint8Array(await (file as File).arrayBuffer());
  const type = sniffImage(bytes);
  if (!type) return fail(400, { file: "type" });
  const id = s.customer.id;
  const key = `customers/${id}.${type.ext}`;
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: type.contentType } });
  const old = s.customer.avatar_key;
  if (old && old !== key && KEY_RE.test(old)) await env.MEDIA.delete(old);
  await env.DB.prepare("UPDATE customers SET avatar_key = ?1, updated_at = datetime('now') WHERE id = ?2").bind(key, id).run();
  return json(200, { ok: true, customer: customerView((await loadCustomer(env.DB, id))!) });
});

export const DELETE = accountRoute("avatar", async (_ctx, env, s) => {
  const old = s.customer.avatar_key;
  if (old && env.MEDIA && KEY_RE.test(old)) await env.MEDIA.delete(old);
  await env.DB.prepare("UPDATE customers SET avatar_key = NULL, updated_at = datetime('now') WHERE id = ?1").bind(s.customer.id).run();
  return json(200, { ok: true, customer: customerView((await loadCustomer(env.DB, s.customer.id))!) });
});
