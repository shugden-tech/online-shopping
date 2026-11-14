// Generates favicon / apple-touch-icon / OG card from the logo PNG (used as-is), plus a
// keyed copy for the site header/hero: the same pixels with the near-black backdrop turned
// transparent, so the mark sits cleanly on gradients. Run: npm run icons
import sharp from "sharp";

const src = "assets/brand/genzst-logo-source.png";
const ink = "#070707";

await sharp(src).resize(64, 64, { fit: "contain", background: ink }).png().toFile("public/favicon.png");
await sharp(src).resize(180, 180, { fit: "contain", background: ink }).png().toFile("public/apple-touch-icon.png");

// 1200x630 Open Graph card: logo centred on the ink backdrop.
const big = await sharp(src).resize(420, 420, { fit: "contain", background: ink, kernel: "lanczos3" }).png().toBuffer();
await sharp({ create: { width: 1200, height: 630, channels: 3, background: ink } })
  .composite([{ input: big, gravity: "centre" }])
  .jpeg({ quality: 88 })
  .toFile("public/og.jpg");

// Keyed logo: alpha from brightness (backdrop -> 0), colour un-multiplied so the gold stays the same.
const { data, info } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const out = Buffer.alloc(info.width * info.height * 4);
const LO = 14; // at or below this brightness = backdrop
const HI = 90; // at or above = fully opaque
for (let i = 0, o = 0; i < data.length; i += 3, o += 4) {
  const r = data[i], g = data[i + 1], b = data[i + 2];
  const v = Math.max(r, g, b);
  const a = Math.min(1, Math.max(0, (v - LO) / (HI - LO)));
  const un = a > 0 ? Math.min(1 / a, 4) : 0;
  out[o] = Math.min(255, Math.round(r * (a < 1 ? un : 1)));
  out[o + 1] = Math.min(255, Math.round(g * (a < 1 ? un : 1)));
  out[o + 2] = Math.min(255, Math.round(b * (a < 1 ? un : 1)));
  out[o + 3] = Math.round(a * 255);
}
await sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile("src/assets/brand/logo.png");
console.log("icons written to public/, keyed logo to src/assets/brand/logo.png");
