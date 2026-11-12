// The engraving pack, as served from /public/art (built by
// web/scripts/build-art.py). Every decorative image on the site comes from
// here. Each file is one flat color with transparency and exists in two
// tones: `on-dark` (light lines, for the dark page) and `on-light` (ink lines,
// for paper and Classic). Widths are the variants that exist on disk: never
// guess a size. The Classic mode's painted art is listed apart, at the end.

export type Tone = "on-dark" | "on-light";
export const TONES: readonly Tone[] = ["on-dark", "on-light"];

/** The tone that suits a mode: light lines on the dark page, ink on the rest. */
export function toneFor(theme: "dark" | "paper" | "classic"): Tone {
  return theme === "dark" ? "on-dark" : "on-light";
}

export const ART = {
  // Village and lake in one picture; the waterline meets the shore. The two
  // boats are their own files because they move (components/HeroBoats.tsx).
  "hero/scene": { widths: [1085, 2170], w: 2170, h: 905 },
  "hero/rowboat": { widths: [160, 320], w: 320, h: 149 },
  "hero/sailboat": { widths: [160, 320], w: 320, h: 362 },
  // The left 27% of the vine frame: the Field Report's margin.
  "margins/vine": { widths: [293, 586], w: 586, h: 725 },
  "props/swallow-glide-1": { widths: [123, 246], w: 246, h: 230 },
  "props/swallow-glide-2": { widths: [135], w: 135, h: 104 },
  "props/swallow-glide-4": { widths: [133], w: 133, h: 99 },
  "props/swallow-glide-5": { widths: [120], w: 120, h: 84 },
  "medallions/anchor": { widths: [64, 128], w: 128, h: 128 },
  "medallions/compass": { widths: [64, 128], w: 128, h: 128 },
  "medallions/laurel": { widths: [64, 128], w: 128, h: 128 },
  "medallions/shield": { widths: [64, 128], w: 128, h: 128 },
  "medallions/wing": { widths: [64, 128], w: 128, h: 128 },
  // cropped to the drawing: swallow on a broken column, with a sprig
  "vignettes/swallow-on-column": { widths: [280, 560], w: 906, h: 820 },
  // fades out toward its own top edge
  "footer/terrace": { widths: [1086, 2172], w: 2172, h: 724 },
  // A detail of a real Roman wall painting, as a tonal ghost with faded edges.
  "fresco/garland-band": { widths: [625, 1250], w: 2499, h: 687 },
  // A photograph of the Pergamon Altar's frieze, as a tonal ghost with faded
  // edges: About's one picture.
  "frieze/pergamon-athena": { widths: [600, 1200], w: 2164, h: 1384 },
  // The Forum's margin figures.
  "figures/nike": { widths: [973], w: 973, h: 1511 },
  "figures/athena": { widths: [619], w: 619, h: 1475 },
  "figures/trophy": { widths: [736], w: 736, h: 1526 },
} as const;

export type ArtName = keyof typeof ART;

export function artUrl(name: ArtName, tone: Tone, width?: number): string {
  const widths = ART[name].widths as readonly number[];
  const w = width && widths.includes(width) ? width : widths[widths.length - 1];
  return `/art/${tone}/${name}-${w}.webp`;
}

export function artSrcSet(name: ArtName, tone: Tone): string {
  return ART[name].widths.map((w) => `/art/${tone}/${name}-${w}.webp ${w}w`).join(", ");
}

// The Classic mode's painted art: full color, in one tone, under
// /art/classic. Only Classic shows it, and only on the landing page; in Dark
// and Paper none of it is fetched (see Art.tsx). The painted swallow strips
// are in lib/sprites.ts with the engraved ones.
export const CLASSIC_ART = {
  "classic/hero/sky": { widths: [836, 1672], w: 1672, h: 941 },
  // On the engraved scene's canvas, so it fills the same box.
  "classic/hero/scene": { widths: [1085, 2170], w: 2170, h: 905 },
  // The leafy frame's two halves: olive and urn, pomegranate and column.
  "classic/hero/frame-left": { widths: [560, 976], w: 976, h: 725 },
  "classic/hero/frame-right": { widths: [560, 977], w: 977, h: 725 },
  "classic/hero/rowboat": { widths: [160, 320], w: 320, h: 149 },
  "classic/hero/sailboat": { widths: [160, 320], w: 320, h: 362 },
  // About's frieze in color, its edges already faded to transparent.
  "classic/frieze/pergamon-athena": { widths: [600, 1200], w: 2164, h: 1384 },
  // Opaque: the footer fades its top edge with a mask (footer.css).
  "classic/footer/terrace": { widths: [1086, 2172], w: 2172, h: 724 },
} as const;

export type ClassicArtName = keyof typeof CLASSIC_ART;

export function classicUrl(name: ClassicArtName): string {
  const widths = CLASSIC_ART[name].widths;
  return `/art/${name}-${widths[widths.length - 1]}.webp`;
}

export function classicSrcSet(name: ClassicArtName): string {
  return CLASSIC_ART[name].widths.map((w) => `/art/${name}-${w}.webp ${w}w`).join(", ");
}

export type MedallionName = "wing" | "anchor" | "compass" | "shield" | "laurel";

// The medallions are small category icons, one per category family (the
// families themselves come from the API: config/taxonomy.yaml).
const BY_FAMILY: Record<string, MedallionName> = {
  aerial: "wing",
  maritime: "anchor",
  navigation: "compass",
  counter: "shield",
};

/** The icon for a category family; anything without its own gets the laurel. */
export function medallionForFamily(family: string | null | undefined): MedallionName {
  return BY_FAMILY[family ?? ""] ?? "laurel";
}

// The caption under About's frieze, and the credit line the photograph's
// license asks for: who took it, the license, and that it was adapted (the
// site shows it cropped, toned and faded at the edges). Both links were
// checked against the photo's Flickr page on 2026-11-12.
export const FRIEZE_CAPTION =
  "Athena and Nike against the giant Alkyoneus. East frieze of the Pergamon Altar, second century BC, Pergamon Museum, Berlin.";
export const FRIEZE_CREDIT = {
  photographer: { name: "Carole Raddato", href: "https://www.flickr.com/photos/carolemage/5912953449" },
  license: { name: "CC BY-SA 2.0", href: "https://creativecommons.org/licenses/by-sa/2.0/" },
} as const;
