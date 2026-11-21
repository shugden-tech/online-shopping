import type { Locale } from "../i18n";

let nf: Intl.NumberFormat | null = null;

/** 35000 -> "35,000" (Intl mn-MN, with a deterministic fallback when the locale data is missing). */
export function formatNumber(n: number): string {
  const v = Math.round(n);
  try {
    nf ??= new Intl.NumberFormat("mn-MN", { maximumFractionDigits: 0 });
    const out = nf.format(v);
    if (nf.format(1000) === "1,000") return out;
  } catch {
    /* fall through */
  }
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "35,000₮" in Mongolian, "₮35,000" in English. */
export function formatPrice(n: number, locale: Locale): string {
  const s = formatNumber(n);
  return locale === "mn" ? `${s}₮` : `₮${s}`;
}
