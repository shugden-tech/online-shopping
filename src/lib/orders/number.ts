// Order numbers: GZ-YYMMDD-XXXX, date in Asia/Ulaanbaatar (UTC+8, no DST), 4 random unambiguous characters.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789";

export function orderNumber(now = new Date()): string {
  const d = new Date(now.getTime() + 8 * 3600_000);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const date = `${p2(d.getUTCFullYear() % 100)}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`;
  let code = "";
  const buf = new Uint8Array(16);
  while (code.length < 4) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      // rejection sampling keeps every character equally likely
      if (b < ALPHABET.length * 7 && code.length < 4) code += ALPHABET[b % ALPHABET.length];
    }
  }
  return `GZ-${date}-${code}`;
}
