// The illustration pack, as served from /public/art (built by
// web/scripts/build-art.py). Every decorative image on the site comes from
// here. Widths are the variants that exist on disk: never guess a size.

export const ART = {
  // Hero layers. midground, lake and foreground are 2170x725 and share one
  // coordinate system: stack them at the same size and position.
  "hero/sky": { widths: [836, 1672], w: 1672, h: 941, alpha: false },
  "hero/sky-dusk": { widths: [1086, 2172], w: 2172, h: 724, alpha: false },
  "hero/midground": { widths: [1085, 2170], w: 2170, h: 725, alpha: true },
  "hero/lake": { widths: [1085, 2170], w: 2170, h: 725, alpha: true },
  "hero/foreground": { widths: [1085, 2170], w: 2170, h: 725, alpha: true },
  "props/cloud-1": { widths: [315, 629], w: 629, h: 243, alpha: true },
  "props/cloud-2": { widths: [284, 568], w: 568, h: 147, alpha: true },
  "props/cloud-3": { widths: [266, 531], w: 531, h: 150, alpha: true },
  "props/sailboat": { widths: [160, 320], w: 478, h: 540, alpha: true },
  "props/rowboat": { widths: [160, 320], w: 517, h: 240, alpha: true },
  "props/swallow-glide-1": { widths: [123, 246], w: 246, h: 230, alpha: true },
  "props/swallow-glide-2": { widths: [135], w: 135, h: 104, alpha: true },
  "props/swallow-glide-3": { widths: [141], w: 141, h: 122, alpha: true },
  "props/swallow-glide-4": { widths: [133], w: 133, h: 99, alpha: true },
  "props/swallow-glide-5": { widths: [120], w: 120, h: 84, alpha: true },
  "medallions/anchor": { widths: [128, 256, 512], w: 512, h: 512, alpha: true },
  "medallions/column": { widths: [128, 256, 512], w: 512, h: 512, alpha: true },
  "medallions/compass": { widths: [128, 256, 512], w: 512, h: 512, alpha: true },
  "medallions/laurel": { widths: [128, 256, 512], w: 512, h: 512, alpha: true },
  "medallions/shield": { widths: [128, 256, 512], w: 512, h: 512, alpha: true },
  "medallions/wing": { widths: [128, 256, 512], w: 512, h: 512, alpha: true },
  "ornaments/laurel-garland": { widths: [560, 1120], w: 1966, h: 189, alpha: true },
  "ornaments/greek-key": { widths: [278, 556], w: 1481, h: 128, alpha: true },
  "ornaments/cartouche": { widths: [430, 861], w: 861, h: 341, alpha: true },
  "ornaments/corner-vine": { widths: [220, 440], w: 646, h: 472, alpha: true },
  // cropped to the drawing: swallow on a broken column, with a sprig
  "vignettes/swallow-on-column": { widths: [280, 560], w: 906, h: 820, alpha: true },
  "footer/terrace": { widths: [1086, 2172], w: 2172, h: 724, alpha: false },
  // A real Roman wall painting (Boscoreale; The Metropolitan Museum of Art).
  "fresco/wall": { widths: [1250, 2499], w: 2499, h: 1856, alpha: false },
  "fresco/garland-band": { widths: [1250, 2499], w: 2499, h: 687, alpha: false },
} as const;

export type ArtName = keyof typeof ART;

export function artUrl(name: ArtName, width?: number): string {
  const widths = ART[name].widths as readonly number[];
  const w = width && widths.includes(width) ? width : widths[widths.length - 1];
  return `/art/${name}-${w}.webp`;
}

/** The smallest variant: enough for a CSS mask or a thumbnail. */
export function artSmall(name: ArtName): string {
  return `/art/${name}-${ART[name].widths[0]}.webp`;
}

export function artSrcSet(name: ArtName): string {
  return ART[name].widths.map((w) => `/art/${name}-${w}.webp ${w}w`).join(", ");
}

export type MedallionName = "wing" | "anchor" | "compass" | "shield" | "column" | "laurel";

// Category -> medallion, as the pack's instructions map them. Aerial and swarm
// categories share the wing; anything without its own icon gets the laurel.
const BY_TAG: Record<string, MedallionName> = {
  uas: "wing",
  swarming: "wing",
  "collaborative-combat-aircraft": "wing",
  "loitering-munitions": "wing",
  maritime: "anchor",
  "gps-denied-nav": "compass",
  "counter-uas": "shield",
};

/** The medallion for an entity: agencies and offices are the column; companies
 *  and solicitations take their main category, or the laurel. */
export function medallionFor(tag: string | null | undefined, kind: string): MedallionName {
  if (kind === "agency" || kind === "office") return "column";
  return BY_TAG[tag ?? ""] ?? "laurel";
}

/** The medallion for a category on its own (filters, legends). */
export function medallionForTag(tag: string): MedallionName {
  return BY_TAG[tag] ?? "laurel";
}

export function medallionUrl(name: MedallionName, size: 128 | 256 | 512 = 256): string {
  return `/art/medallions/${name}-${size}.webp`;
}

export const FRESCO_CREDIT = "Wall painting, Boscoreale. The Metropolitan Museum of Art, Open Access.";
