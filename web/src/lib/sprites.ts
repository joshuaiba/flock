// Swallow sprites for the flock canvas. Two strips of 8 frames, birds facing
// right: award birds in the accent, solicitation birds in the text color.
// Plus three single glide poses, drawn in the text color only. Everything
// comes in two tones (light lines for the dark page, ink lines for paper); a
// set is loaded once and shared.
//
// Classic has a third set: the painted strips (a brown award bird and a pale
// blue solicitation bird), with the same cells, frame count and speed. It has
// no glide poses of its own, so a gliding bird holds the strip's flattest
// frame.
//
// Strip metadata is from the packs' sprite-meta.json, at half size: the site
// ships 130x195 cells, sharp for birds up to 60px wide on a 2x display.

import { toneFor, type Tone } from "./art";

export type SpriteSet = Tone | "classic";

/** The sprites a mode draws with (the value of <html data-theme>). */
export function spriteSetFor(theme: string | undefined): SpriteSet {
  return theme === "classic" ? "classic" : toneFor(theme === "paper" ? "paper" : "dark");
}

export const SPRITE = { cellW: 130, cellH: 195, frames: 8, fps: 12 } as const;

// Where the bird's body sits in a cell (wings move above and below it).
const BODY_X = 0.52;
const BODY_Y = 0.55;
// Glide poses that face right and read as level flight, with their aspect ratios.
const GLIDES = [
  { file: "swallow-glide-2-135", w: 135, h: 104 },
  { file: "swallow-glide-4-133", w: 133, h: 99 },
  { file: "swallow-glide-5-120", w: 120, h: 84 },
];
export const GLIDE_COUNT = GLIDES.length;
/** The flattest wing position in the strip: a glide for birds with no glide art. */
export const GLIDE_FRAME = 3;

export type Sprites = {
  award: HTMLImageElement;
  solicitation: HTMLImageElement;
  glides: HTMLImageElement[];
};

const pending = new Map<SpriteSet, Promise<Sprites>>();

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${src}`));
    img.src = src;
  });
}

function spriteUrl(set: SpriteSet, kind: "award" | "solicitation"): string {
  return `/art/${set}/sprites/swallow-${kind}-1040.webp`;
}

/** Load one set's sprite images (once). A failed load is forgotten, so the
 *  next caller tries again. */
export function loadSprites(set: SpriteSet): Promise<Sprites> {
  let p = pending.get(set);
  if (!p) {
    p = Promise.all([
      load(spriteUrl(set, "award")),
      load(spriteUrl(set, "solicitation")),
      ...(set === "classic" ? [] : GLIDES.map((g) => load(`/art/${set}/props/${g.file}.webp`))),
    ])
      .then(([award, solicitation, ...glides]) => ({ award, solicitation, glides }))
      .catch((e) => {
        pending.delete(set);
        throw e;
      });
    pending.set(set, p);
  }
  return p;
}

export type Swallow = {
  x: number;
  y: number;
  /** drawn width of a sprite cell in CSS pixels (26-60 in the flock) */
  width: number;
  /** velocity; sets facing (flipped when vx < 0) and tilt (clamped to +/-25 degrees) */
  vx: number;
  vy: number;
  /** animation position in frames; any float, wraps */
  frame: number;
  award: boolean;
  alpha?: number;
  /** index of a glide pose (0..GLIDE_COUNT-1) to hold instead of flapping, or null */
  glide?: number | null;
};

const MAX_TILT = (25 * Math.PI) / 180;

/** Draw one swallow, centered on its body at (x, y). */
export function drawSwallow(ctx: CanvasRenderingContext2D, s: Sprites, b: Swallow): void {
  const left = b.vx < 0;
  const tilt = Math.max(-MAX_TILT, Math.min(MAX_TILT, Math.atan2(b.vy, Math.abs(b.vx) || 0.001)));
  ctx.save();
  ctx.translate(b.x, b.y);
  if (left) ctx.scale(-1, 1);
  ctx.rotate(tilt);
  ctx.globalAlpha = b.alpha ?? 1;
  if (b.glide != null && !b.award && s.glides.length) {
    // The glide art is in the text color, so only solicitation birds use it;
    // an award bird glides on the strip's flattest frame, in the accent. (So
    // does every bird of a set without glide art.)
    const g = GLIDES[b.glide % GLIDES.length];
    const w = b.width * 0.92;
    const h = (w * g.h) / g.w;
    ctx.drawImage(s.glides[b.glide % GLIDES.length], -w * 0.5, -h * 0.5, w, h);
  } else {
    const f = b.glide != null ? GLIDE_FRAME : ((Math.floor(b.frame) % SPRITE.frames) + SPRITE.frames) % SPRITE.frames;
    const w = b.width;
    const h = (w * SPRITE.cellH) / SPRITE.cellW;
    ctx.drawImage(
      b.award ? s.award : s.solicitation,
      f * SPRITE.cellW,
      0,
      SPRITE.cellW,
      SPRITE.cellH,
      -w * BODY_X,
      -h * BODY_Y,
      w,
      h,
    );
  }
  ctx.restore();
}
