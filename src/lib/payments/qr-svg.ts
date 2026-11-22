// Server-side QR rendering for Wire's direct QR mode (CONTRACTS §11): qr.text -> a compact SVG data: URI, so the order
// page shows the code with no QR library in the browser (the JS budget stays as it was). Uses `uqr` (MIT, no deps).
import { encode } from "uqr";

const BORDER = 4; // the quiet zone the QR spec asks for, in modules

/** One <path> of horizontal runs (much smaller than a <rect> per module). Black on white, crisp edges. */
export function qrSvg(text: string): string {
  const { data, size } = encode(text, { ecc: "M", border: 0 });
  const n = size + BORDER * 2;
  let d = "";
  for (let y = 0; y < data.length; y++) {
    const row = data[y]!;
    for (let x = 0; x < row.length; ) {
      if (!row[x]) {
        x++;
        continue;
      }
      let w = 1;
      while (row[x + w]) w++;
      d += `M${x + BORDER} ${y + BORDER}h${w}v1h-${w}z`;
      x += w;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`;
}

/** The SVG as a base64 data: URI (the form `qrSrc` in src/scripts/order-status.ts accepts). Null when it cannot be encoded. */
export function qrDataUri(text: string): string | null {
  try {
    const bytes = new TextEncoder().encode(qrSvg(text));
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:image/svg+xml;base64,${btoa(bin)}`;
  } catch (err) {
    console.error("[payments] Wire QR could not be rendered:", String((err as Error)?.message ?? err));
    return null;
  }
}
