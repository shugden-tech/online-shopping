// POST /api/admin/media  [media.write]  multipart: file (jpeg/png/webp by magic bytes, <= 5 MB), productId, side (front|back)
//   -> { ok, url, key }   url = PUBLIC_MEDIA_BASE + "/" + key, key = products/{id}/{side}-{sha256-12}.{ext}
//   Does not change the product (the admin UI then PATCHes imageFront / imageBack).
//   Bundles (0005): `bundleId` instead of `productId` (side front) -> key bundles/{id}/front-{sha256-12}.{ext}.
//   503 { form: "media-disabled" } when the MEDIA bucket or PUBLIC_MEDIA_BASE is not configured.
// A1-owned.
import { auditStatement } from "../../../lib/audit";
import { MAX_MEDIA_BYTES, MEDIA_SIDES, mediaKey, sha256Hex, sniffImage, type MediaSide } from "../../../lib/catalog/media";
import { adminRoute } from "../../../lib/catalog/route";
import { PRODUCT_ID_RE } from "../../../lib/contracts";
import { BUNDLE_ID_RE } from "../../../lib/bundles/types";
import { fail, json } from "../../../lib/server";

export const prerender = false;

export const POST = adminRoute("admin/media", "media.write", async ({ request }, env, s) => {
  if (!env.MEDIA || !env.PUBLIC_MEDIA_BASE) return fail(503, { form: "media-disabled" });
  if (!/^multipart\/form-data\b/i.test(request.headers.get("Content-Type") ?? "")) return fail(415, { form: "server" });
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_MEDIA_BYTES + 64 * 1024) return fail(413, { file: "too_large" });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, { form: "invalid" });
  }
  const file = form.get("file");
  const bundleId = form.get("bundleId");
  const productId = bundleId === null ? form.get("productId") : null;
  const side = form.get("side");
  const errors: Record<string, string> = {};
  if (bundleId !== null) {
    if (typeof bundleId !== "string" || !BUNDLE_ID_RE.test(bundleId)) errors.bundleId = "invalid";
  } else if (typeof productId !== "string" || !PRODUCT_ID_RE.test(productId)) errors.productId = "invalid";
  if (typeof side !== "string" || !(MEDIA_SIDES as readonly string[]).includes(side)) errors.side = "invalid";
  if (!file || typeof file === "string") errors.file = "required";
  if (Object.keys(errors).length) return fail(400, errors);
  const blob = file as File;
  if (blob.size > MAX_MEDIA_BYTES) return fail(413, { file: "too_large" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const type = sniffImage(bytes);
  if (!type) return fail(400, { file: "type" });
  const hash = await sha256Hex(bytes);
  let key: string;
  let ref: Record<string, string>;
  if (bundleId !== null) {
    const id = bundleId as string;
    if (!(await env.DB.prepare("SELECT id FROM bundles WHERE id = ?1").bind(id).first())) return fail(404, { bundleId: "not_found" });
    key = `bundles/${id}/${side}-${hash.slice(0, 12)}.${type.ext}`;
    ref = { bundleId: id };
  } else {
    const id = productId as string;
    const product = await env.DB.prepare("SELECT id FROM products WHERE id = ?1").bind(id).first();
    if (!product) return fail(404, { productId: "not_found" });
    key = mediaKey(id, side as MediaSide, hash, type.ext);
    ref = { productId: id };
  }
  await env.MEDIA.put(key, bytes, {
    httpMetadata: { contentType: type.contentType, cacheControl: "public, max-age=31536000, immutable" },
  });
  await env.DB.batch([
    auditStatement(env.DB, s.actor, "media.upload", "media", key, { ...ref, side, bytes: bytes.length, contentType: type.contentType }),
  ]);
  return json(200, { ok: true, url: `${env.PUBLIC_MEDIA_BASE.replace(/\/+$/, "")}/${key}`, key });
});
