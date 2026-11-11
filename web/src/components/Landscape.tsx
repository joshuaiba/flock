// The painted world: an Italian lake landscape in the manner of a faded villa
// fresco. Fine sepia linework over soft watercolor fills, drawn procedurally as
// SVG so it follows the day/dusk palette and needs no image assets. Composition
// is fixed by `seed`. Dusk keeps the same scene and lights the lamps.
//
// Ambient life is slow and slight: cypresses sway, the water shimmers, clouds
// drift, and a patch of light crosses the hills. All of it stops under reduced
// motion or the "still" toggle.
//
// These are original scenes and stand-ins for commissioned illustrations: swap
// a scene for a WebP by replacing this component where it is used.

type Props = {
  seed?: number;
  /** viewBox size; the SVG fills its container and crops (slice) */
  width?: number;
  height?: number;
  /** where the far shore sits, as a fraction of height */
  horizon?: number;
  water?: boolean;
  trees?: number;
  mountains?: boolean;
  sun?: boolean;
  villa?: boolean;
  className?: string;
};

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = (n: number) => Math.round(n * 10) / 10;

type Line = (x: number) => number;

/** A ridge line as a sum of a few sines; `jag` adds sharper peaks. */
function ridge(r: () => number, base: number, amp: number, w: number, jag = 0): Line {
  const terms = [1, 2.3, 4.1, 7.7].map((k, i) => ({
    k: ((k * (0.7 + r() * 0.6)) / w) * Math.PI * 2,
    p: r() * Math.PI * 2,
    a: [0.5, 0.28, 0.14, 0.08][i],
  }));
  return (x) => {
    let y = 0;
    for (const t of terms) y += t.a * Math.sin(x * t.k + t.p);
    if (jag) y += jag * (Math.abs(Math.sin(x * terms[2].k * 1.7 + terms[0].p)) - 0.5);
    return base - amp * y;
  };
}

function area(line: Line, w: number, h: number, step = 14): string {
  let d = `M0,${f(line(0))}`;
  for (let x = step; x <= w + step; x += step) d += ` L${f(x)},${f(line(x))}`;
  return `${d} L${w},${h} L0,${h} Z`;
}

function trace(line: Line, w: number, step = 14, dy = 0): string {
  let d = `M0,${f(line(0) + dy)}`;
  for (let x = step; x <= w; x += step) d += ` L${f(x)},${f(line(x) + dy)}`;
  return d;
}

const LINE = { stroke: "var(--paint-line)", fill: "none", strokeLinecap: "round" as const };

export function Landscape({
  seed = 1,
  width = 1600,
  height = 900,
  horizon = 0.56,
  water = true,
  trees = 22,
  mountains = true,
  sun = true,
  villa = true,
  className,
}: Props) {
  const r = mulberry(seed * 7919 + 13);
  const W = width;
  const H = height;
  const hz = H * horizon;
  const u = H / 900; // scale strokes and details with the scene height

  const far = ridge(r, hz - 120 * u, 130 * u, W, 0.45);
  const mid = ridge(r, hz - 28 * u, 52 * u, W, 0.12);
  const shore = hz + (water ? 74 : 12) * u; // the near bank of the lake
  const near = ridge(r, shore, 22 * u, W);
  const fore = ridge(r, H * 0.91, 20 * u, W);
  const sunX = W * (0.56 + r() * 0.26);
  const sunY = hz - (230 + r() * 80) * u;

  // Engraver's hatching down the shaded side of the far range.
  const hatch: string[] = [];
  for (let x = 10; x < W; x += 15 + r() * 10) {
    const slope = far(x + 12) - far(x);
    if (slope < 1.5) continue;
    const len = Math.min(60, 12 + slope * 5) * u * (0.6 + r() * 0.8);
    hatch.push(`M${f(x)},${f(far(x) + 5 * u)} l${f(len * 0.42)},${f(len)}`);
  }

  // Cypresses and olives stand on the near bank, thickest toward the edges so
  // the middle of the scene stays open.
  const stand: { x: number; y: number; h: number; tall: boolean; d: number }[] = [];
  for (let i = 0; i < trees; i++) {
    const side = r() < 0.5 ? r() * r() * 0.44 : 1 - r() * r() * 0.44;
    const x = side * W;
    stand.push({ x, y: near(x) + 3 * u, h: (34 + r() * 56) * u, tall: r() < 0.62, d: r() });
  }
  stand.sort((a, b) => a.y - b.y);

  // A villa on the bank: plaster walls, terracotta roof, an arched loggia.
  const vx = W * (r() < 0.5 ? 0.16 + r() * 0.12 : 0.72 + r() * 0.12);
  const vy = near(vx) + 2 * u;
  const vw = 96 * u;
  const vh = 40 * u;

  const dashes: string[] = [];
  if (water) {
    for (let i = 0; i < 54; i++) {
      const y = hz + (6 + r() * 60) * u;
      dashes.push(`M${f(r() * W)},${f(y)} h${f((16 + r() * 64) * u)}`);
    }
  }

  // Terraces: a few long contour lines across the foreground.
  const terraces = [0.25, 0.5, 0.75].map((t) => {
    const y = shore + (H - shore) * t;
    const bend = (r() - 0.5) * 30 * u;
    return `M0,${f(y)} Q${f(W / 2)},${f(y + bend - 22 * u)} ${W},${f(y + bend)}`;
  });

  const clouds = [0, 1, 2, 3].map(() => ({
    x: r() * W,
    y: (70 + r() * 170) * u,
    w: (120 + r() * 200) * u,
  }));
  const stars = Array.from({ length: 22 }, () => ({ x: r() * W, y: r() * hz * 0.7, s: 0.6 + r() * 1.1 }));

  const id = `ls${seed}-${W}`;
  return (
    <svg
      className={className}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: "var(--paint-sky)" }} />
          <stop offset="0.72" style={{ stopColor: "var(--paint-glow)", stopOpacity: 0.85 }} />
          <stop offset="1" style={{ stopColor: "var(--paint-glow)", stopOpacity: 0.3 }} />
        </linearGradient>
        <linearGradient id={`${id}-field`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: "var(--paint-near)" }} />
          <stop offset="0.28" style={{ stopColor: "var(--paint-field)" }} />
          <stop offset="1" style={{ stopColor: "var(--paint-field)", stopOpacity: 0.5 }} />
        </linearGradient>
        <linearGradient id={`${id}-water`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: "var(--paint-water)" }} />
          <stop offset="1" style={{ stopColor: "var(--paint-sky)", stopOpacity: 0.8 }} />
        </linearGradient>
        <radialGradient id={`${id}-sun`}>
          <stop offset="0" style={{ stopColor: "var(--paint-sun)", stopOpacity: 0.95 }} />
          <stop offset="0.3" style={{ stopColor: "var(--paint-sun)", stopOpacity: 0.55 }} />
          <stop offset="1" style={{ stopColor: "var(--paint-sun)", stopOpacity: 0 }} />
        </radialGradient>
        <radialGradient id={`${id}-light`}>
          <stop offset="0" style={{ stopColor: "var(--paint-sun)", stopOpacity: 0.34 }} />
          <stop offset="1" style={{ stopColor: "var(--paint-sun)", stopOpacity: 0 }} />
        </radialGradient>
        <filter id={`${id}-soft`} x="-20%" y="-50%" width="140%" height="200%">
          <feGaussianBlur stdDeviation={f(9 * u)} />
        </filter>
        {/* A hand-painted wobble on every edge of the land. */}
        <filter id={`${id}-wet`} x="-2%" y="-2%" width="104%" height="104%">
          <feTurbulence type="fractalNoise" baseFrequency="0.011" numOctaves="2" seed={seed} result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale={f(9 * u)} />
        </filter>
      </defs>

      <rect width={W} height={f(hz + 50 * u)} fill={`url(#${id}-sky)`} />
      <g className="night-only">
        {stars.map((s, i) => (
          <circle key={i} cx={f(s.x)} cy={f(s.y)} r={f(s.s * u)} style={{ fill: "var(--paint-sun)" }} opacity={0.55} />
        ))}
      </g>
      {sun && (
        <g>
          <circle cx={f(sunX)} cy={f(sunY)} r={f(150 * u)} fill={`url(#${id}-sun)`} />
          <circle cx={f(sunX)} cy={f(sunY)} r={f(34 * u)} style={{ fill: "var(--paint-sun)" }} opacity={0.9} />
        </g>
      )}
      <g className="paint-drift" filter={`url(#${id}-soft)`}>
        {clouds.map((c, i) => (
          <g key={i} style={{ fill: "var(--paint-cloud)" }} opacity={0.7}>
            <ellipse cx={f(c.x)} cy={f(c.y)} rx={f(c.w)} ry={f(c.w * 0.13)} />
            <ellipse cx={f(c.x + c.w * 0.3)} cy={f(c.y - c.w * 0.09)} rx={f(c.w * 0.5)} ry={f(c.w * 0.12)} />
          </g>
        ))}
      </g>

      <g filter={`url(#${id}-wet)`}>
        {mountains && (
          <g>
            <path d={area(far, W, H)} style={{ fill: "var(--paint-far)" }} />
            <path d={trace(far, W)} {...LINE} strokeWidth={1 * u} opacity={0.6} />
            <path d={hatch.join(" ")} {...LINE} strokeWidth={0.7 * u} opacity={0.32} />
          </g>
        )}
        <path d={area(mid, W, H)} style={{ fill: "var(--paint-mid)" }} />
        <path d={trace(mid, W)} {...LINE} strokeWidth={1 * u} opacity={0.65} />
        {[12, 26].map((dy, i) => (
          <path
            key={dy}
            d={trace(mid, W, 14, dy * u)}
            {...LINE}
            strokeWidth={0.7 * u}
            strokeDasharray={`${f(22 * u)} ${f(7 * u)} ${f(4 * u)} ${f(9 * u)}`}
            opacity={0.34 - i * 0.1}
          />
        ))}
      </g>

      {water && (
        <g>
          <rect y={f(hz - 2 * u)} width={W} height={f(shore - hz + 30 * u)} fill={`url(#${id}-water)`} />
          <g className="paint-shimmer">
            <path d={dashes.join(" ")} {...LINE} strokeWidth={0.9 * u} opacity={0.42} />
          </g>
          {/* the sun's path on the water */}
          {sun && (
            <ellipse cx={f(sunX)} cy={f(hz + 34 * u)} rx={f(60 * u)} ry={f(30 * u)} fill={`url(#${id}-light)`} />
          )}
        </g>
      )}

      {/* light moving slowly across the hills */}
      <ellipse className="paint-light" cx={f(W * 0.45)} cy={f(hz - 20 * u)} rx={f(W * 0.3)} ry={f(120 * u)} fill={`url(#${id}-light)`} />

      <g filter={`url(#${id}-wet)`}>
        <path d={area(near, W, H)} fill={`url(#${id}-field)`} />
        <path d={trace(near, W)} {...LINE} strokeWidth={1 * u} opacity={0.6} />
        <path d={terraces.join(" ")} {...LINE} strokeWidth={0.8 * u} opacity={0.2} />
      </g>

      {villa && (
        <g stroke="var(--paint-line)" strokeWidth={0.9 * u} strokeLinejoin="round">
          {/* tower */}
          <rect x={f(vx + vw * 0.62)} y={f(vy - vh * 1.75)} width={f(vw * 0.2)} height={f(vh * 1.75)} style={{ fill: "var(--paint-wall)" }} />
          <path
            d={`M${f(vx + vw * 0.59)},${f(vy - vh * 1.75)} l${f(vw * 0.13)},${f(-vh * 0.3)} l${f(vw * 0.13)},${f(vh * 0.3)} Z`}
            style={{ fill: "var(--paint-roof)" }}
          />
          {/* hall */}
          <rect x={f(vx)} y={f(vy - vh)} width={f(vw)} height={f(vh)} style={{ fill: "var(--paint-wall)" }} />
          <path
            d={`M${f(vx - vw * 0.05)},${f(vy - vh)} L${f(vx + vw * 0.08)},${f(vy - vh * 1.32)} L${f(vx + vw * 0.92)},${f(vy - vh * 1.32)} L${f(vx + vw * 1.05)},${f(vy - vh)} Z`}
            style={{ fill: "var(--paint-roof)" }}
          />
          {/* loggia: by day shaded arches, at dusk lamp-lit */}
          {[0.14, 0.34, 0.54, 0.74].map((t) => {
            const d = `M${f(vx + vw * t)},${f(vy)} v${f(-vh * 0.42)} a${f(vw * 0.06)},${f(vw * 0.06)} 0 0 1 ${f(vw * 0.12)},0 v${f(vh * 0.42)} Z`;
            return (
              <g key={t}>
                <path d={d} style={{ fill: "var(--paint-line)" }} opacity={0.55} />
                <path d={d} className="night-only" style={{ fill: "var(--ochre)" }} stroke="none" />
              </g>
            );
          })}
        </g>
      )}

      {stand.map((t, i) =>
        t.tall ? (
          <path
            key={i}
            className="paint-sway"
            style={{
              fill: "var(--paint-cypress)",
              animationDuration: `${f(6 + t.d * 5)}s`,
              animationDelay: `${f(-t.d * 9)}s`,
            }}
            d={`M${f(t.x)},${f(t.y)} q${f(-t.h * 0.17)},${f(-t.h * 0.46)} 0,${f(-t.h)} q${f(t.h * 0.17)},${f(t.h * 0.54)} 0,${f(t.h)} Z`}
            stroke="var(--paint-line)"
            strokeWidth={0.8 * u}
            opacity={0.9}
          />
        ) : (
          <g
            key={i}
            className="paint-sway"
            style={{
              fill: "color-mix(in srgb, var(--paint-near) 78%, var(--paint-cypress))",
              animationDuration: `${f(8 + t.d * 5)}s`,
              animationDelay: `${f(-t.d * 9)}s`,
            }}
            stroke="var(--paint-line)"
            strokeWidth={0.8 * u}
          >
            <path d={`M${f(t.x)},${f(t.y)} v${f(-t.h * 0.22)}`} fill="none" />
            <circle cx={f(t.x - t.h * 0.14)} cy={f(t.y - t.h * 0.27)} r={f(t.h * 0.17)} />
            <circle cx={f(t.x + t.h * 0.15)} cy={f(t.y - t.h * 0.28)} r={f(t.h * 0.15)} />
            <circle cx={f(t.x)} cy={f(t.y - t.h * 0.4)} r={f(t.h * 0.18)} />
          </g>
        ),
      )}

      <g filter={`url(#${id}-wet)`}>
        <path d={area(fore, W, H)} style={{ fill: "var(--paint-mid)" }} opacity={0.5} />
        <path d={trace(fore, W)} {...LINE} strokeWidth={0.9 * u} opacity={0.45} />
      </g>
    </svg>
  );
}
