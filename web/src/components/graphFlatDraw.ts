import { INNER_RING, type N } from "@/lib/graphLayout";
import type { Palette } from "@/lib/paint";

// How each kind of node looks on the flat canvas (GraphFlat.tsx), one function
// per kind. These are the only places that decide what a mark looks like: the
// canvas works out where a node is, how big it is drawn and whether it is lit,
// and hands that over. Layout and hit-testing never call them, so the plain
// marks here can be swapped for engraved sprites (a coin for a company, a
// wreath for an agency, a tablet for a solicitation) without touching either.
//
// Every function draws one node centered on (x, y) in CSS pixels, with the
// canvas transform already set for devicePixelRatio. `r` is the drawn radius in
// CSS pixels, so the mark's diameter on screen is 2r: for a company the dot,
// for an agency or office the outer ring, for a solicitation half the
// diamond's diagonal. A function leaves globalAlpha, the styles and the line
// width in whatever state it likes; the caller sets what it needs before
// drawing anything else.

/** Everything a mark needs besides its node and its place on screen. */
export type MarkLook = {
  palette: Palette;
  /** How far the mark has dimmed because another node is in focus: 0 is at
   *  rest, 1 is fully dimmed (the selection dims the rest of the map to about
   *  16%; hover previews it partway). */
  fade: number;
  /** the selected node: drawn at full strength with a thin ring around it */
  selected: boolean;
  /** under the pointer: a fainter ring */
  hover: boolean;
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
/** a closed solicitation is half as strong as an open one */
const CLOSED = 0.5;

/** The thin ring around the selected (or hovered) node, a little clear of its mark. */
function focusRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, look: MarkLook) {
  if (!look.selected && !look.hover) return;
  ctx.globalAlpha = look.selected ? 0.7 : 0.4;
  ctx.strokeStyle = look.palette.text;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, r + 5, 0, Math.PI * 2);
  ctx.stroke();
}

/** A company: a filled dot in the text color, with a hairline of the page
 *  color around it so touching dots stay apart. */
export function drawCompany(ctx: CanvasRenderingContext2D, _n: N, x: number, y: number, r: number, look: MarkLook) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = look.palette.bg;
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.globalAlpha = look.selected || look.hover ? 1 : mix(COMPANY_ALPHA, COMPANY_DIM, look.fade);
  ctx.fillStyle = look.palette.text;
  ctx.fill();
  focusRing(ctx, x, y, r, look);
}

/** An agency or office: an outer ring and an inner ring at 45% of it, both
 *  filled with the page color so no edge shows through the hub. */
export function drawAgency(ctx: CanvasRenderingContext2D, _n: N, x: number, y: number, r: number, look: MarkLook) {
  const lit = look.selected || look.hover ? 0 : look.fade;
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
  focusRing(ctx, x, y, r, look);
}

/** A solicitation: an outlined diamond, all of one size; a closed one fainter. */
export function drawSolicitation(ctx: CanvasRenderingContext2D, n: N, x: number, y: number, r: number, look: MarkLook) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.globalAlpha = 1;
  ctx.fillStyle = look.palette.bg;
  ctx.fill();
  const lit = look.selected || look.hover ? 0 : look.fade;
  ctx.globalAlpha = mix(DIAMOND_ALPHA, DIAMOND_DIM, lit) * (n.open ? 1 : CLOSED);
  ctx.strokeStyle = look.palette.text;
  ctx.lineWidth = 1;
  ctx.lineJoin = "miter";
  ctx.stroke();
  focusRing(ctx, x, y, r, look);
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
