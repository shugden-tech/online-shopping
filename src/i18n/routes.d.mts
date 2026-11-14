export type Locale = "mn" | "en";
export type RouteKey = "home" | "shop" | "finder" | "checkout" | "success" | "about" | "help";
export const ROUTES: Record<RouteKey, Record<Locale, string>>;
export function route(key: RouteKey, locale: Locale): string;
export function productPath(locale: Locale, slug: string): string;
export function alternatesFor(pathname: string): Record<Locale, string> | null;
