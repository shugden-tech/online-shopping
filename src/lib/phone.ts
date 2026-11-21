// Name and Mongolian phone clean-up shared by the profile page (browser) and the account API (server).

/** Trimmed name with single spaces, 2–60 characters. Returns the cleaned name or null. */
export function cleanName(input: string): string | null {
  const v = input.trim().replace(/\s+/g, " ");
  return v.length >= 2 && v.length <= 60 ? v : null;
}

/**
 * Mongolian mobile number: 8 digits starting with 6–9, optional +976 prefix (spaces and dashes are ignored).
 * Returns the 8-digit form, or null.
 */
export function cleanPhone(input: string): string | null {
  const compact = input.replace(/[\s-]/g, "");
  const digits = compact.startsWith("+976") ? compact.slice(4) : compact;
  // same rule as the checkout (PHONE_RE in order-validate.ts): Mongolian mobiles start with 6–9
  return /^[6-9]\d{7}$/.test(digits) ? digits : null;
}
