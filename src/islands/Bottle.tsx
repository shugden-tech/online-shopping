// Preact twin of components/BottleArt.astro. Relies on <BottleSprite /> being in the page.
interface Props {
  shape: string;
  family: string;
  initial: string;
  img?: string;
  label?: string;
  class?: string;
}

export function Bottle({ shape, family, initial, img, label, class: cls }: Props) {
  if (img) {
    return <img class={`bottle-photo ${cls ?? ""}`} src={img} alt={label ?? ""} loading="lazy" decoding="async" />;
  }
  return (
    <svg
      class={`bottle ${cls ?? ""}`}
      viewBox="0 0 200 280"
      style={`--tint:var(--fam-${family})`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
      focusable="false"
    >
      <use href={`#gz-b-${shape}`} />
      <text x="100" y="196" text-anchor="middle" font-size="36">
        {initial}
      </text>
    </svg>
  );
}

export const initialOf = (brand: string) => brand.trim().charAt(0).toUpperCase();
