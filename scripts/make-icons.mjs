// Generates favicon / apple-touch-icon / OG card from the keyed brand assets in
// src/assets/brand/ (logo-mark.png and wordmark.png already have transparent
// backgrounds). Run: npm run icons
import sharp from "sharp";

const mark = "src/assets/brand/logo-mark.png";
const wordmark = "src/assets/brand/wordmark.png";
const ink = "#070707";

// Favicon keeps transparency; apple-touch-icon needs an opaque backdrop (ink).
await sharp(mark).resize(64, 64, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile("public/favicon.png");
const appleMark = await sharp(mark).resize(150, 150, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
await sharp({ create: { width: 180, height: 180, channels: 4, background: ink } })
  .composite([{ input: appleMark, gravity: "centre" }])
  .png()
  .toFile("public/apple-touch-icon.png");

// 1200x630 Open Graph card: mark above wordmark, centred on the ink backdrop.
const ogMark = await sharp(mark).resize(300, 300, { fit: "inside", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
const ogWord = await sharp(wordmark).resize(600, 600, { fit: "inside", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
const markMeta = await sharp(ogMark).metadata();
const wordMeta = await sharp(ogWord).metadata();
const gap = 48;
const total = markMeta.height + gap + wordMeta.height;
const top = Math.round((630 - total) / 2);
await sharp({ create: { width: 1200, height: 630, channels: 3, background: ink } })
  .composite([
    { input: ogMark, left: Math.round((1200 - markMeta.width) / 2), top },
    { input: ogWord, left: Math.round((1200 - wordMeta.width) / 2), top: top + markMeta.height + gap },
  ])
  .jpeg({ quality: 88 })
  .toFile("public/og.jpg");

console.log("icons written to public/");
