// Painted rendering shared by the murmuration and the graph: brushstroke birds,
// watercolor blooms, and the palette read from CSS so canvases follow day/dusk.

/** A swallow seen from above, heading along +x, as SVG path data.
 *  `flap` runs 0 (wings swept back) to 1 (spread). About 20 units long. */
export function birdPath(flap: number): string {
  const f = Math.max(0, Math.min(1, flap));
  const n = (v: number) => v.toFixed(1);
  const tipX = -8 + 4 * f;
  const tipY = 3.5 + 10.5 * f;
  let d =
    // body, tapering into a forked tail
    "M8.5,0 Q3,-2.7 -4.5,-0.9 L-11.5,-3.4 L-7.5,0 L-11.5,3.4 L-4.5,0.9 Q3,2.7 8.5,0 Z";
  for (const s of [-1, 1]) {
    // a wing: one curved blade from shoulder to tip and back
    d += ` M4,${n(s * 1.1)} Q3,${n(s * (3 + 6.5 * f))} ${n(tipX)},${n(s * tipY)} Q-1,${n(s * (1.8 + 3.2 * f))} -2.5,${n(s * 1.1)} Z`;
  }
  return d;
}

const WINGS: Path2D[] = [];
const STEPS = 16;

/** Draw one bird as a soft brushstroke silhouette. */
export function drawBird(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  flap: number,
  scale: number,
  color: string,
  alpha = 0.9,
): void {
  const i = Math.max(0, Math.min(STEPS, Math.round(flap * STEPS)));
  const path = (WINGS[i] ??= new Path2D(birdPath(i / STEPS)));
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(scale, scale);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fill(path);
  // a second, lighter pass slightly offset: the uneven edge of a loaded brush
  ctx.globalAlpha = alpha * 0.28;
  ctx.translate(-0.9, 0.5);
  ctx.fill(path);
  ctx.restore();
}

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
export function hexA(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, alpha).toFixed(3)})`;
}

/** Mix two "#rrggbb" colors; t = 0 gives a, 1 gives b. */
export function mix(a: string, b: string, t: number): string {
  const x = parseInt(a.slice(1, 7), 16);
  const y = parseInt(b.slice(1, 7), 16);
  const ch = (s: number) => Math.round(((x >> s) & 255) * (1 - t) + ((y >> s) & 255) * t);
  return "#" + ((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1);
}

export type Palette = Record<
  | "paper" | "card" | "ink" | "muted" | "sage" | "cypress" | "sky" | "lake"
  | "terracotta" | "ochre" | "pompeii" | "marble" | "gold" | "paleBird",
  string
> & { night: boolean };

/** The palette from CSS variables (all plain #rrggbb). */
export function readPalette(): Palette {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => s.getPropertyValue(n).trim();
  return {
    paper: v("--paper"),
    card: v("--card"),
    ink: v("--ink"),
    muted: v("--muted"),
    sage: v("--sage"),
    cypress: v("--cypress"),
    sky: v("--sky"),
    lake: v("--lake"),
    terracotta: v("--terracotta"),
    ochre: v("--ochre"),
    pompeii: v("--pompeii"),
    marble: v("--marble"),
    gold: v("--gold"),
    paleBird: v("--pale-bird"),
    night: document.documentElement.dataset.theme === "night",
  };
}
