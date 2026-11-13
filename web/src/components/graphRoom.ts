// The part of the canvas a graph view fits the map into, shared by the flat
// and the 3D view so the two agree on where the rail, the side card and the
// rest of the chrome are. Everything is read from the real rectangles on the
// page, so a folded rail, a phone layout or a longer takeaway line needs
// nothing special; the only numbers kept here are for the side card while it
// is still on its way in, and they follow graph-rail.css.

/** A rectangle of the page that covers the canvas, in canvas pixels. `card`
 *  marks the side card, which only counts while something is selected. */
export type Chrome = { x0: number; y0: number; x1: number; y1: number; card: boolean };
/** Room taken from each side of the canvas, in CSS pixels. */
export type Insets = { l: number; t: number; r: number; b: number };

/** Room left around the map when it is fitted, from the canvas edges and
 *  from every piece of chrome. */
export const FIT_PAD = 48;
/** A phone cannot spare 48px a side: below this width the padding shrinks. */
export const PHONE_W = 600;
export const PHONE_PAD = 24;

// The side card (graph-rail.css .graph-detail). From 768px up it stands at
// the right, 15.75rem wide and 1.5rem from the edge; below that it is a sheet
// across the bottom, up to 55vh tall and 3.5rem above the bottom edge.
const CARD_WIDE = 768;
const CARD_RIGHT = 15.75 * 16 + 1.5 * 16;
const SHEET_SHARE = 0.55;
const SHEET_BOTTOM = 3.5 * 16;

/** The chrome over a view's canvas: everything marked `data-obstacle` (the
 *  rail, the side card, the takeaway line, the legend), the view controls,
 *  and the site's top bar. */
export function readChrome(host: ParentNode, canvas: Element): Chrome[] {
  const base = canvas.getBoundingClientRect();
  const els = new Set(host.querySelectorAll<HTMLElement>("[data-obstacle], .graph-controls"));
  const bar = document.querySelector<HTMLElement>(".site-nav");
  if (bar) els.add(bar);
  const out: Chrome[] = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    out.push({
      x0: r.left - base.left,
      y0: r.top - base.top,
      x1: r.right - base.left,
      y1: r.bottom - base.top,
      card: !!el.closest(".graph-detail"),
    });
  }
  return out;
}

/** The padding around the map at this canvas width. */
export const fitPad = (W: number) => (W < PHONE_W ? PHONE_PAD : FIT_PAD);

/** The insets of the room the map is fitted into: the canvas less the chrome
 *  over it, each piece cut off along the side that loses the least room (the
 *  rail on the left, the card on the right, the takeaway along the top), then
 *  padded. With `card`, the side card counts, and while it has not mounted
 *  yet its place is reserved; without, a card on the page is ignored. */
export function roomFor(chrome: readonly Chrome[], W: number, H: number, card: boolean): Insets {
  const pad = fitPad(W);
  const p: Insets = { l: pad, t: pad, r: pad, b: pad };
  let mounted = false;
  /** the side the card takes, which keeps its padding */
  let cardSide: keyof Insets | null = null;
  for (const c of chrome) {
    if (c.card && !card) continue;
    const x0 = Math.max(0, c.x0), y0 = Math.max(0, c.y0);
    const x1 = Math.min(W, c.x1), y1 = Math.min(H, c.y1);
    if (x1 <= x0 || y1 <= y0) continue;
    mounted ||= c.card;
    const cuts: [keyof Insets, number, number][] = [
      ["l", x1, x1 * H],
      ["r", W - x0, (W - x0) * H],
      ["t", y1, y1 * W],
      ["b", H - y0, (H - y0) * W],
    ];
    const [side, cut] = cuts.reduce((a, b) => (b[2] < a[2] ? b : a));
    p[side] = Math.max(p[side], cut + pad);
    if (c.card) cardSide = side;
  }
  // The card mounts a moment after a click: until it does, reserve its place.
  if (card && !mounted) {
    cardSide = W >= CARD_WIDE ? "r" : "b";
    if (cardSide === "r") p.r = Math.max(p.r, CARD_RIGHT + pad);
    else p.b = Math.max(p.b, H * SHEET_SHARE + SHEET_BOTTOM + pad);
  }
  // Never squeeze the map into a sliver: give back padding, but no more than
  // the padding (the map is never fitted under the chrome itself), and none
  // along the card, so a selection never sits on its edge.
  for (const [a, b, size] of [["l", "r", W], ["t", "b", H]] as const) {
    const over = p[a] + p[b] - (size - 160);
    if (over <= 0) continue;
    if (a === cardSide || b === cardSide) {
      const other = a === cardSide ? b : a;
      p[other] = Math.max(0, p[other] - Math.min(pad, over));
    } else {
      const give = Math.min(pad, over / 2);
      p[a] = Math.max(0, p[a] - give);
      p[b] = Math.max(0, p[b] - give);
    }
  }
  return p;
}
