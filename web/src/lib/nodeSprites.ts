// The graph's node art: coins for companies, wreaths for agencies and
// offices, tablets for solicitations and a crown for the selected node (the
// "nodes/..." entries in lib/art.ts, built by web/scripts/build-art.py). Both
// the flat and the 3D view take their sprites from here.
//
// Each sprite is loaded once per tone, as an image of its largest width, the
// first time anything asks for it. Drawing a 256px image down to 30px every
// frame is slow and looks rough, so each sprite is also pre-scaled into a few
// offscreen canvases ("buckets", sized in device pixels), built the first
// time a size is asked for and kept. A caller asks for the bucket that covers
// the size it will draw and draws that, so the flat canvas never rescales the
// source per frame. Nothing here touches the window at import time, so the
// module is safe to import during server rendering.

import { artSrcSet, artUrl, ART, toneFor, type Tone } from "./art";
import { familyOf, type Family } from "./signals";
import type { Theme } from "./store";

export type NodeSprite =
  | "coin-aerial"
  | "coin-maritime"
  | "coin-navigation"
  | "coin-counter"
  | "coin-other"
  | "coin-plain"
  | "wreath-oak"
  | "wreath-rope"
  | "wreath-feather"
  | "wreath-laurel"
  | "tablet-open"
  | "tablet-closed"
  | "crown-selected";

export const NODE_SPRITES: readonly NodeSprite[] = [
  "coin-aerial",
  "coin-maritime",
  "coin-navigation",
  "coin-counter",
  "coin-other",
  "coin-plain",
  "wreath-oak",
  "wreath-rope",
  "wreath-feather",
  "wreath-laurel",
  "tablet-open",
  "tablet-closed",
  "crown-selected",
];

// ------------------------------------------------------------ which sprite

/** A company's coin, by the family of its first category: the swallow for
 *  aerial, the anchor for maritime, the compass star for navigation, the
 *  shield for counter-drone and the column for the rest. */
export const COIN_BY_FAMILY: Record<Family, NodeSprite> = {
  aerial: "coin-aerial",
  maritime: "coin-maritime",
  navigation: "coin-navigation",
  counter: "coin-counter",
  other: "coin-other",
};

/** The coin for a company. Its family comes from its first category (the
 *  API lists a node's categories primary first); a company with none gets
 *  the column, like any other family the table does not know. */
export function coinFor(n: { tags?: readonly string[] | null; tag?: string | null }): NodeSprite {
  const tag = n.tags?.[0] ?? n.tag;
  return COIN_BY_FAMILY[tag ? familyOf(tag) : "other"];
}

// The agencies with a wreath of their own: only the three service
// departments themselves, by short name or by legal name. Their offices and
// commands ("Army Contracting Command", NAVSEA, AFRL) and every other agency
// get the laurel, like anything this table does not list. Keys are written
// the way key() below normalizes a name: lower case, letters and spaces only,
// "dept" spelled out and "the" dropped.
export const WREATH_BY_AGENCY: Record<string, NodeSprite> = {
  army: "wreath-oak",
  "department of army": "wreath-oak",
  "us army": "wreath-oak",
  navy: "wreath-rope",
  "department of navy": "wreath-rope",
  "us navy": "wreath-rope",
  "air force": "wreath-feather",
  "department of air force": "wreath-feather",
  "us air force": "wreath-feather",
};

function key(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .replace(/\bdept\b/g, "department")
    .replace(/\bu s\b/g, "us")
    .replace(/\bthe\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The wreath for an agency or office: Army oak, Navy rope, Air Force
 *  feather, every other agency or office laurel. */
export function wreathFor(n: { name: string; display_name?: string | null }): NodeSprite {
  for (const name of [n.display_name, n.name]) {
    const hit = name ? WREATH_BY_AGENCY[key(name)] : undefined;
    if (hit) return hit;
  }
  return "wreath-laurel";
}

/** The tablet for a solicitation: open, or closed for a closed or archived
 *  one (anything the API does not mark open). */
export function tabletFor(n: { open?: boolean | null }): NodeSprite {
  return n.open ? "tablet-open" : "tablet-closed";
}

// ------------------------------------------------------------ tones

/** The tone of the wreaths, tablets and crown: the mode's own (light lines
 *  in Dark, ink in Paper and Classic). */
export function artTone(theme: Theme): Tone {
  return toneFor(theme);
}

/** The tone of a coin's sprite: the opposite of the mode's, because the coin
 *  is drawn over a disc in the text color (ink lines on a light disc in Dark,
 *  light lines on an ink disc in Paper and Classic). */
export function coinTone(theme: Theme): Tone {
  return toneFor(theme) === "on-dark" ? "on-light" : "on-dark";
}

/** The mode the page is in now, from <html data-theme>; "dark" on the server. */
export function currentTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  const t = document.documentElement.dataset.theme;
  return t === "paper" || t === "classic" ? t : "dark";
}

// ------------------------------------------------------------ URLs, for <img>

/** The URL of one width of a sprite (the largest when `width` is not one of
 *  its widths). */
export function nodeSpriteUrl(name: NodeSprite, tone: Tone, width?: number): string {
  return artUrl(`nodes/${name}`, tone, width);
}

/** A srcSet of every width of a sprite, for an <img> with `sizes`. */
export function nodeSpriteSrcSet(name: NodeSprite, tone: Tone): string {
  return artSrcSet(`nodes/${name}`, tone);
}

/** The sprite's natural width (and height: they are square) in pixels. */
export function nodeSpriteSize(name: NodeSprite): number {
  return ART[`nodes/${name}`].w;
}

// ------------------------------------------------------------ loading

type Loaded = { img: HTMLImageElement; buckets: Map<number, CanvasImageSource> };

// One entry per "tone/name": null while loading, false when it failed.
const loaded = new Map<string, Loaded | null | false>();
const listeners = new Set<() => void>();
let version = 0;

/** Goes up by one each time a sprite finishes loading, so a view can tell
 *  whether anything new arrived since its last frame. */
export function spriteVersion(): number {
  return version;
}

/** Calls `cb` each time a sprite finishes loading (once per sprite and tone).
 *  Returns the function that unsubscribes. */
export function onSpritesReady(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function load(name: NodeSprite, tone: Tone): Loaded | null {
  const id = `${tone}/${name}`;
  const have = loaded.get(id);
  if (have !== undefined) return have || null;
  if (typeof Image === "undefined") return null;
  loaded.set(id, null);
  const img = new Image();
  img.decoding = "async";
  const done = () => {
    if (!img.naturalWidth) {
      loaded.set(id, false);
      return;
    }
    loaded.set(id, { img, buckets: new Map() });
    version++;
    for (const cb of listeners) cb();
  };
  img.onload = () => {
    // decode() first, so the first frame that draws it does not stall
    img.decode().then(done, done);
  };
  img.onerror = () => loaded.set(id, false);
  img.src = nodeSpriteUrl(name, tone);
  return null;
}

/** Starts loading sprites in one tone (all of them when `names` is left out),
 *  so they are ready by the time a frame wants them. Safe to call often. */
export function preloadSprites(tone: Tone, names: readonly NodeSprite[] = NODE_SPRITES): void {
  for (const n of names) load(n, tone);
}

/** The loaded full-size image, or null while it loads: for a 3D texture,
 *  which the GPU scales with mipmaps. */
export function getSpriteImage(name: NodeSprite, tone: Tone): HTMLImageElement | null {
  return load(name, tone)?.img ?? null;
}

// ------------------------------------------------------------ buckets

// Bucket edges in device pixels. The smallest mark drawn is a 12px tablet
// (24 device px on a 2x screen) and the largest a crown at 1.6x a big
// company, a few hundred device px; steps of about 1.5x keep a bucket within
// 50% of the size it is drawn at, where a single downscale still looks clean.
// A bucket never exceeds the sprite's own size (256px, the tablets 128px, the
// crown 384px): past that the source itself is the largest bucket.
export const SPRITE_BUCKETS: readonly number[] = [16, 24, 32, 48, 64, 96, 128, 192, 256, 384];

function canvas(size: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(size, size);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  return c;
}

/** The image drawn at `size` square, halving first while it is more than
 *  twice too big: one big downscale skips pixels and shimmers. */
function scaled(img: HTMLImageElement, size: number): CanvasImageSource {
  let src: CanvasImageSource = img;
  let at = img.naturalWidth;
  while (at > size) {
    const next = at / 2 >= size ? Math.round(at / 2) : size;
    const c = canvas(next);
    const ctx = c.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return src;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, next, next);
    src = c;
    at = next;
  }
  return src;
}

/** The bucket a draw of `devicePx` device pixels should use: the smallest
 *  bucket at least that big, capped at the sprite's own size. */
export function spriteBucket(name: NodeSprite, devicePx: number): number {
  const max = nodeSpriteSize(name);
  for (const b of SPRITE_BUCKETS) if (b >= devicePx && b <= max) return b;
  return max;
}

/** A sprite pre-scaled to the bucket covering `devicePx` (the size it will
 *  be drawn at, in device pixels), or null while it is still loading (start
 *  it with preloadSprites, and redraw on onSpritesReady). Draw it with
 *  drawImage at the size you want: it is at least that big unless the size
 *  is past the source's own. Buckets are built the first time they are asked
 *  for and kept. */
export function getSprite(name: NodeSprite, tone: Tone, devicePx: number): CanvasImageSource | null {
  const l = load(name, tone);
  if (!l) return null;
  const b = spriteBucket(name, devicePx);
  let c = l.buckets.get(b);
  if (!c) {
    c = scaled(l.img, b);
    l.buckets.set(b, c);
  }
  return c;
}

/** Draws a sprite centered on (x, y), `size` user units square, where one
 *  unit is `pxPerUnit` device pixels (the canvas's devicePixelRatio times any
 *  zoom in its transform). Returns false, drawing nothing, while the sprite
 *  loads. Opacity is the context's globalAlpha, as for any other mark. */
export function drawSprite(
  ctx: CanvasRenderingContext2D,
  name: NodeSprite,
  tone: Tone,
  x: number,
  y: number,
  size: number,
  pxPerUnit: number,
): boolean {
  const s = getSprite(name, tone, size * pxPerUnit);
  if (!s) return false;
  ctx.drawImage(s, x - size / 2, y - size / 2, size, size);
  return true;
}
