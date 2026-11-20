// Line icons for the admin navigation (24px grid, stroke = currentColor). Decorative: aria-hidden.
const P: Record<string, string> = {
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  bag: "M5 8h14l-1 12.5H6L5 8zM9 8V6.5a3 3 0 016 0V8",
  bottle: "M9 2h6v4H9zM10 6v2M14 6v2M6.5 10.5A2.5 2.5 0 019 8h6a2.5 2.5 0 012.5 2.5V20a2 2 0 01-2 2h-7a2 2 0 01-2-2zM6.5 15h11",
  box: "M3 7.5L12 3l9 4.5v9L12 21l-9-4.5zM3 7.5L12 12l9-4.5M12 12v9",
  gift: "M3 9h18v4H3zM5 13h14v8H5zM12 9v12M12 9c-2-4-6-4-6-1.5S10 9 12 9zM12 9c2-4 6-4 6-1.5S14 9 12 9z",
  card: "M2.5 6h19v12h-19zM2.5 10h19M6 15h4",
  truck: "M2 6h11v10H2zM13 9h4.5L21 12.5V16h-8M6 19a2 2 0 100-4 2 2 0 000 4zM17 19a2 2 0 100-4 2 2 0 000 4z",
  gear: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7 7 0 01-1.7 1L15 20.5h-4l-.4-2.1a7 7 0 01-1.7-1l-1.9.7-2-3.4 1.6-1.2a7 7 0 010-2l-1.6-1.2 2-3.4 1.9.7a7 7 0 011.7-1L11 3.5h4l.4 2.1a7 7 0 011.7 1l1.9-.7 2 3.4-1.6 1.2a7 7 0 010 2z",
  clock: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2",
};
export type IconName = keyof typeof P;
export function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" stroke-linecap="round" stroke-linejoin="round"><path d={P[name]} /></svg>
  );
}
