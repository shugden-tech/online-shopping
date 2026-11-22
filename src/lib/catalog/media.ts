// A1 catalog: product photo upload checks (type by magic bytes, size) and the R2 object key.
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
export const MEDIA_SIDES = ["front", "back"] as const;
export type MediaSide = (typeof MEDIA_SIDES)[number];

export interface ImageType { ext: "jpg" | "png" | "webp"; contentType: string }

/** Detects jpeg / png / webp from the file's first bytes (the declared type and file name are ignored). */
export function sniffImage(b: Uint8Array): ImageType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", contentType: "image/jpeg" };
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length >= 8 && png.every((v, i) => b[i] === v)) return { ext: "png", contentType: "image/png" };
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { ext: "webp", contentType: "image/webp" };
  return null;
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** `products/{id}/{side}-{sha256 first 12 hex}.{ext}` — content-addressed, so re-uploading the same file is a no-op. */
export const mediaKey = (productId: string, side: MediaSide, hash: string, ext: string) => `products/${productId}/${side}-${hash.slice(0, 12)}.${ext}`;
