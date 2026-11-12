// Canvas helpers shared by the murmuration and the graph: the watercolor bloom
// where a bird lands, and the palette read from CSS so canvases follow day/dusk.

export type Bloom = { x: number; y: number; t: number; seed?: number };

/** A watercolor bloom: pigment spreading into wet paper where a bird lands or
 *  an award arrives. Returns false once it has dried. */
export function drawBloom(ctx: CanvasRenderingContext2D, b: Bloom, color: string): boolean {
  const life = 2.4;
  if (b.t > life) return false;
  const k = b.t / life;
  const ease = 1 - Math.pow(1 - k, 3);
  const fade = (1 - k) * (1 - k);
  const seed = b.seed ?? (b.x * 13 + b.y * 7) % 6.28;
  for (let i = 0; i < 3; i++) {
    const a = seed + i * 2.1;
    const r = 10 + ease * (38 + i * 12);
    const cx = b.x + Math.cos(a) * ease * 9;
    const cy = b.y + Math.sin(a) * ease * 7;
    const g = ctx.createRadialGradient(cx, cy, r * 0.15, cx, cy, r);
    g.addColorStop(0, hexA(color, 0.3 * fade));
    g.addColorStop(0.72, hexA(color, 0.2 * fade));
    g.addColorStop(0.9, hexA(color, 0.3 * fade)); // the darker tide line at the edge
    g.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return true;
}

/** "#rrggbb" with an alpha, as an rgba() string. */
function hexA(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, alpha).toFixed(3)})`;
}

export type Palette = Record<
  | "paper" | "card" | "ink" | "muted" | "sage" | "cypress" | "sky" | "lake"
  | "terracotta" | "ochre" | "pompeii" | "marble" | "gold",
  string
> & { night: boolean };

/** The palette from CSS variables (all plain #rrggbb). The names are the
 *  painted design's; until the canvases are redrawn for the engraving design
 *  each one reads the token that took its place. */
export function readPalette(): Palette {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => s.getPropertyValue(n).trim();
  return {
    paper: v("--bg"),
    card: v("--surface"),
    ink: v("--text"),
    muted: v("--muted"),
    sage: v("--faint"),
    cypress: v("--text"),
    sky: v("--surface"),
    lake: v("--surface"),
    terracotta: v("--accent"),
    ochre: v("--muted"),
    pompeii: v("--accent"),
    marble: v("--surface"),
    gold: v("--muted"),
    night: document.documentElement.dataset.theme !== "paper",
  };
}
