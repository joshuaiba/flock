import type { Tone } from "@/lib/art";
import { INNER_RING, SOLICITATION_R, type N } from "@/lib/graphLayout";
import { coinFor, getSprite, tabletFor, wreathFor, type NodeSprite } from "@/lib/nodeSprites";
import type { Palette } from "@/lib/paint";

// How each kind of node looks on the flat canvas (GraphFlat.tsx), one function
// per kind. These are the only places that decide what a mark looks like: the
// canvas works out where a node is, how big it is drawn and whether it is lit,
// and hands that over. Layout and hit-testing never call the draw functions.
//
// Every function draws one node centered on (x, y) in CSS pixels, with the
// canvas transform already set for devicePixelRatio. `r` is the drawn radius in
// CSS pixels from the layout, so the plain mark's diameter on screen is 2r:
// for a company the dot, for an agency or office the outer ring, for a
// solicitation half the diamond's diagonal. A function leaves globalAlpha, the
// styles and the line width in whatever state it likes; the caller sets what
// it needs before drawing anything else.
//
// The marks are engraved sprites (flock-nodes/NODES.md): a silver coin for a
// company big enough on screen (a plain dot below that), a wreath for an
// agency, a tablet for a solicitation, and a crown around the selected node.
// Sprites come pre-scaled from lib/nodeSprites.ts in size buckets, so nothing
// is rescaled from its source per frame. While a sprite is still loading the
// plain mark is drawn in its place; the canvas redraws when it arrives.

/** Everything a mark needs besides its node and its place on screen. */
export type MarkLook = {
  palette: Palette;
  /** How far the mark has dimmed because another node is in focus: 0 is at
   *  rest, 1 is fully dimmed (the selection dims the rest of the map to about
   *  16%; hover previews it partway). */
  fade: number;
  /** the selected node: drawn at full strength, under a crown */
  selected: boolean;
  /** under the pointer: a faint ring */
  hover: boolean;
  /** device pixels per CSS pixel, to pick a sprite's size bucket */
  dpr: number;
  /** the mode's own tone: wreaths, tablets and the crown */
  tone: Tone;
  /** the opposite tone: the coin's sprite, drawn over a disc in the text color */
  coinTone: Tone;
};

/** a + (b - a) t */
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;

// Opacity of each mark at rest and fully dimmed (mockups/after.html and
// after-selected.html).
const COMPANY_ALPHA = 0.9;
const COMPANY_DIM = 0.16;
const RING_ALPHA = 1;
const RING_DIM = 0.2;
const INNER_ALPHA = 0.6;
const INNER_DIM = 0.12;
const DIAMOND_ALPHA = 0.6;
const DIAMOND_DIM = 0.1;
/** a closed solicitation's plain diamond is half as strong as an open one
 *  (the tablet shows the closed state itself, at full strength) */
const CLOSED = 0.5;

// The sprites' sizes on screen (NODES.md).
/** A company becomes a coin from this drawn diameter up; below it, a dot. */
export const COIN_FROM = 24;
/** The coin's sprite is a little wider than its disc, so its rim sits just outside. */
const COIN_SPRITE = 1.075;
/** The disc under the sprite, in the text color. */
const COIN_DISC_ALPHA = 0.95;
/** A dimmed coin keeps this much, so it still reads as a coin. */
const COIN_MIN_ALPHA = 0.3;
const COIN_ALPHA = 1;
/** A wreath is at least this wide on screen, else 2.8x the ring's radius. */
const WREATH_MIN = 30;
const WREATH_PER_R = 2.8;
/** The page-colored disc behind a wreath, as a share of its diameter, so
 *  edges stop at the wreath instead of crossing its center. */
const WREATH_HUB = 0.36;
/** A tablet is 15px on screen, and shrinks with the map no further than 12px. */
const TABLET = 15;
const TABLET_MIN = 12;
const TABLET_ALPHA = 0.85;
const TABLET_DIM = 0.12;
/** The crown is 1.6x the selected mark's drawn diameter, and never so small
 *  around a little dot that it stops reading as a crown. */
const CROWN = 1.6;
const CROWN_MIN = 30;

/** True when a company is drawn as a coin: decided on its drawn size, so
 *  zooming in turns dots into coins and zooming out turns them back. */
export const isCoin = (r: number) => 2 * r >= COIN_FROM;

/** A wreath's drawn radius for an agency whose ring radius is r. */
export const wreathRadius = (r: number) => Math.max(WREATH_MIN, WREATH_PER_R * r) / 2;

/** A tablet's drawn size for a solicitation whose diamond radius is r. */
const tabletSize = (r: number) => Math.max(TABLET_MIN, Math.min(TABLET, (TABLET * r) / SOLICITATION_R));

/** How far a node's mark reaches from its center on screen, as drawn: the
 *  coin's rim, the wreath, the tablet. Names and the fit keep clear of this. */
export function markRadius(n: N, r: number): number {
  if (n.kind === "company") return isCoin(r) ? r * COIN_SPRITE : r;
  if (n.kind === "opportunity") return Math.max(r, tabletSize(r) / 2);
  return Math.max(r, wreathRadius(r));
}

/** How far the selected node's crown reaches from its center. */
export const crownRadius = (n: N, r: number) => Math.max(CROWN_MIN / 2, CROWN * markRadius(n, r));

/** A sprite `size` CSS pixels square centered on (x, y), at the alpha already
 *  set; false (drawing nothing) while it is still loading. */
function sprite(
  ctx: CanvasRenderingContext2D,
  name: NodeSprite,
  tone: Tone,
  x: number,
  y: number,
  size: number,
  look: MarkLook,
): boolean {
  const s = getSprite(name, tone, size * look.dpr);
  if (!s) return false;
  ctx.drawImage(s, x - size / 2, y - size / 2, size, size);
  return true;
}

/** The faint ring around the hovered node, a little clear of its mark. The
 *  selected node wears the crown instead. */
function hoverRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, look: MarkLook) {
  if (!look.hover || look.selected) return;
  ctx.globalAlpha = 0.4;
  ctx.strokeStyle = look.palette.text;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, r + 5, 0, Math.PI * 2);
  ctx.stroke();
}

/** The crown over the selected node, in the mode's tone, at full strength. */
function crown(ctx: CanvasRenderingContext2D, n: N, x: number, y: number, r: number, look: MarkLook) {
  if (!look.selected) return;
  ctx.globalAlpha = 1;
  sprite(ctx, "crown-selected", look.tone, x, y, 2 * crownRadius(n, r), look);
}

/** A company. From 24px across, a silver coin: a disc in the text color with
 *  a hairline of the page color, and the family's coin sprite over it in the
 *  opposite tone. Below that, or while the sprite loads, a filled dot in the
 *  text color with the same hairline, so touching dots stay apart. */
export function drawCompany(ctx: CanvasRenderingContext2D, n: N, x: number, y: number, r: number, look: MarkLook) {
  const strong = look.selected || look.hover;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = look.palette.bg;
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.fillStyle = look.palette.text;
  const coin = isCoin(r) ? getSprite(coinFor(n), look.coinTone, 2 * r * COIN_SPRITE * look.dpr) : null;
  if (coin) {
    const a = strong ? 1 : Math.max(COIN_MIN_ALPHA, mix(COIN_ALPHA, COMPANY_DIM, look.fade));
    ctx.globalAlpha = a * COIN_DISC_ALPHA;
    ctx.fill();
    ctx.globalAlpha = a;
    const s = 2 * r * COIN_SPRITE;
    ctx.drawImage(coin, x - s / 2, y - s / 2, s, s);
  } else {
    ctx.globalAlpha = strong ? 1 : mix(COMPANY_ALPHA, COMPANY_DIM, look.fade);
    ctx.fill();
  }
  hoverRing(ctx, x, y, markRadius(n, r), look);
  crown(ctx, n, x, y, r, look);
}

/** An agency or office: a wreath in the mode's tone (Army oak, Navy rope, Air
 *  Force feather, the rest laurel; lib/nodeSprites.ts keeps the table), over a
 *  small disc of the page color. While the wreath loads, the plain mark: an
 *  outer ring and an inner ring at 45% of it, filled with the page color. */
export function drawAgency(ctx: CanvasRenderingContext2D, n: N, x: number, y: number, r: number, look: MarkLook) {
  const lit = look.selected || look.hover ? 0 : look.fade;
  const wr = wreathRadius(r);
  const wreath = getSprite(wreathFor(n), look.tone, 2 * wr * look.dpr);
  if (wreath) {
    ctx.beginPath();
    ctx.arc(x, y, wr * WREATH_HUB, 0, Math.PI * 2);
    ctx.globalAlpha = 1;
    ctx.fillStyle = look.palette.bg;
    ctx.fill();
    ctx.globalAlpha = mix(RING_ALPHA, RING_DIM, lit);
    ctx.drawImage(wreath, x - wr, y - wr, 2 * wr, 2 * wr);
  } else {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.globalAlpha = 1;
    ctx.fillStyle = look.palette.bg;
    ctx.fill();
    ctx.globalAlpha = mix(RING_ALPHA, RING_DIM, lit);
    ctx.strokeStyle = look.palette.text;
    ctx.lineWidth = 1.3;
    ctx.stroke();
    const ri = r * INNER_RING;
    if (ri >= 1.5) {
      ctx.beginPath();
      ctx.arc(x, y, ri, 0, Math.PI * 2);
      ctx.globalAlpha = mix(INNER_ALPHA, INNER_DIM, lit);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  hoverRing(ctx, x, y, markRadius(n, r), look);
  crown(ctx, n, x, y, r, look);
}

/** A solicitation: an open or a closed tablet in the mode's tone, 15px on
 *  screen. While it loads, the plain outlined diamond, a closed one fainter. */
export function drawSolicitation(ctx: CanvasRenderingContext2D, n: N, x: number, y: number, r: number, look: MarkLook) {
  const lit = look.selected || look.hover ? 0 : look.fade;
  const size = tabletSize(r);
  ctx.globalAlpha = mix(TABLET_ALPHA, TABLET_DIM, lit);
  if (!sprite(ctx, tabletFor(n), look.tone, x, y, size, look)) {
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.globalAlpha = 1;
    ctx.fillStyle = look.palette.bg;
    ctx.fill();
    ctx.globalAlpha = mix(DIAMOND_ALPHA, DIAMOND_DIM, lit) * (n.open ? 1 : CLOSED);
    ctx.strokeStyle = look.palette.text;
    ctx.lineWidth = 1;
    ctx.lineJoin = "miter";
    ctx.stroke();
  }
  hoverRing(ctx, x, y, markRadius(n, r), look);
  crown(ctx, n, x, y, r, look);
}

/** The mark for any node, by kind. */
export function drawMark(ctx: CanvasRenderingContext2D, n: N, x: number, y: number, r: number, look: MarkLook) {
  if (n.kind === "company") drawCompany(ctx, n, x, y, r, look);
  else if (n.kind === "opportunity") drawSolicitation(ctx, n, x, y, r, look);
  else drawAgency(ctx, n, x, y, r, look);
}

/** Text with a halo of the page color behind it, as SVG's paint-order stroke
 *  draws it: the 5px stroke first, at full strength so it always parts the
 *  text from the edges under it, then the fill. The font, alignment and
 *  baseline are the caller's. */
export function haloText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  alpha: number,
  palette: Palette,
) {
  ctx.globalAlpha = 1;
  ctx.lineJoin = "round";
  ctx.lineWidth = 5;
  ctx.strokeStyle = palette.bg;
  ctx.strokeText(text, x, y);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}
