// The landing page's star chart, as geometry. Agencies on the outer ring, the
// missions as sectors, every company a star inside the sector of the mission
// it is paid most for, and an arc for each agency -> company flow. Everything
// is placed by rank and by a hash of its id (no simulation, no randomness), so
// the chart is the same on every load and can be drawn on the server.

import { byDollars, hash01, missionLabel, r1, type Award, type Flows, type Model, type Named } from "./flows";

export const SIZE = 640; // the chart's own square; the drawing adds a margin
const C = SIZE / 2;
export const R = {
  limb: 300,
  limbIn: 282,
  agency: 264,
  sector: 246,
  starMax: 222,
  starMin: 106,
  hub: 92,
  disk: 70,
  core: 44,
};

export type ChartAgency = {
  id: string;
  label: string;
  x: number;
  y: number;
  angle: number;
  dollars: number;
  awards: number;
  lead: boolean;
  labelPath: string;
};
export type ChartSector = {
  id: string;
  label: string;
  a0: number;
  a1: number;
  companies: number;
  dollars: number;
  labelPath: string | null;
  spoke: [number, number, number, number];
};
export type ChartStar = {
  id: string;
  label: string;
  x: number;
  y: number;
  r: number;
  dollars: number;
  awards: number;
  sector: string;
  rank: number;
};
export type ChartArc = {
  key: string;
  source: string;
  target: string;
  d: string;
  dollars: number;
  awards: number;
  lead: boolean;
};
export type ChartLive = { award: Award; d: string; source: string; target: string };
export type StarChart = {
  agencies: ChartAgency[];
  sectors: ChartSector[];
  stars: ChartStar[];
  named: (ChartStar & { lx: number; ly: number; anchor: "start" | "end" })[];
  figures: string[]; // one polyline per sector: its brightest stars joined, like a constellation figure
  arcs: ChartArc[];
  live: ChartLive[];
};

/** A point at `angle` (radians, clockwise from the top) and radius `r`. */
export function polar(angle: number, r: number): [number, number] {
  return [r1(C + Math.sin(angle) * r), r1(C - Math.cos(angle) * r)];
}
/** An arc of radius r from a0 to a1, drawn so text set on it reads upright:
 *  clockwise over the top half, counterclockwise under the bottom half. */
function textArc(a0: number, a1: number, r: number): string {
  const mid = (a0 + a1) / 2;
  const under = Math.cos(mid) < -0.15;
  const [x0, y0] = polar(under ? a1 : a0, under ? r + 9 : r);
  const [x1, y1] = polar(under ? a0 : a1, under ? r + 9 : r);
  const rr = under ? r + 9 : r;
  return `M${x0} ${y0}A${rr} ${rr} 0 0 ${under ? 0 : 1} ${x1} ${y1}`;
}
function sweepPath(x0: number, y0: number, x1: number, y1: number): string {
  // Bowed toward the hub, like a great-circle route on a chart.
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const cx = r1(mx + (C - mx) * 0.6);
  const cy = r1(my + (C - my) * 0.6);
  return `M${x0} ${y0}Q${cx} ${cy} ${x1} ${y1}`;
}

export function layoutStarChart(
  data: Flows,
  model: Model,
  who: Map<string, Named>,
  opts: { stars?: number; arcs?: number; live?: number } = {},
): StarChart {
  const label = (id: string) => who.get(id)?.label ?? id;
  const TAU = Math.PI * 2;

  // Agencies: largest at the top, then clockwise, evenly spaced.
  const payers = [...model.agencies.values()].sort(byDollars);
  const agencies: ChartAgency[] = payers.map((t, i) => {
    const angle = (i / Math.max(1, payers.length)) * TAU;
    const [x, y] = polar(angle, R.agency);
    const step = TAU / Math.max(3, payers.length);
    return {
      id: t.id,
      label: label(t.id),
      x,
      y,
      angle,
      dollars: t.dollars,
      awards: t.awards,
      lead: i < 3,
      labelPath: textArc(angle + 0.062, angle + step * 0.96, R.agency + 4),
    };
  });
  const agencyAt = new Map(agencies.map((a) => [a.id, a]));

  // Sectors: one per mission with a company in it, largest first, each as
  // wide as the square root of its company count (so a mission of two is
  // still a sector, not a sliver).
  const primary = new Map<string, string>(); // company -> mission id
  const best = new Map<string, number>();
  for (const l of model.mc.values())
    if (l.dollars > (best.get(l.target) ?? -1)) (best.set(l.target, l.dollars), primary.set(l.target, l.source));
  const members = new Map<string, string[]>();
  for (const [co, m] of primary) (members.get(m) ?? members.set(m, []).get(m)!).push(co);
  const missions = [...model.missions.values()].filter((t) => members.has(t.id)).sort(byDollars);
  const weight = missions.map((t) => 0.55 + Math.sqrt(members.get(t.id)!.length));
  const whole = weight.reduce((s, v) => s + v, 0) || 1;
  let a = 0;
  const sectors: ChartSector[] = missions.map((t, i) => {
    const span = (weight[i] / whole) * TAU;
    const a0 = a;
    const a1 = (a += span);
    const text = missionLabel(t.id.slice(4));
    // A name is set along the sector's outer arc when the arc is long enough.
    const fits = span * (R.sector - 14) > text.length * 7.2 + 10;
    const [sx0, sy0] = polar(a0, R.hub + 4);
    const [sx1, sy1] = polar(a0, R.sector);
    return {
      id: t.id,
      label: text,
      a0,
      a1,
      companies: members.get(t.id)!.length,
      dollars: t.dollars,
      labelPath: fits ? textArc(a0 + 0.02, a1 - 0.02, R.sector - 17) : null,
      spoke: [sx0, sy0, sx1, sy1],
    };
  });
  const sectorAt = new Map(sectors.map((s) => [s.id, s]));

  // Stars: a company sits in its mission's sector, at an angle and a depth
  // taken from its id; its size is its dollars.
  const ranked = [...model.companies.values()].sort(byDollars);
  const top = ranked[0]?.dollars || 1;
  const stars: ChartStar[] = [];
  ranked.slice(0, opts.stars ?? 240).forEach((t, rank) => {
    const s = sectorAt.get(primary.get(t.id) ?? "");
    if (!s) return;
    const pad = Math.min(0.05, (s.a1 - s.a0) * 0.12);
    const angle = s.a0 + pad + hash01(t.id, 11) * (s.a1 - s.a0 - pad * 2);
    const depth = R.starMin + Math.sqrt(hash01(t.id, 12)) * (R.starMax - R.starMin - 22);
    const [x, y] = polar(angle, depth);
    stars.push({
      id: t.id,
      label: label(t.id),
      x,
      y,
      r: r1(Math.min(5.2, 0.8 + 4.6 * Math.sqrt(t.dollars / top))),
      dollars: t.dollars,
      awards: t.awards,
      sector: s.id,
      rank,
    });
  });
  const starAt = new Map(stars.map((s) => [s.id, s]));

  // The four brightest are named. Names keep a line's height apart.
  const named = stars.slice(0, 4).map((s) => {
    const anchor: "start" | "end" = s.x > C + 150 ? "end" : "start";
    return { ...s, lx: s.x + (anchor === "start" ? s.r + 8 : -(s.r + 8)), ly: s.y + 4, anchor };
  });
  [...named]
    .sort((p, q) => p.ly - q.ly)
    .forEach((n, i, list) => {
      if (i && n.ly - list[i - 1].ly < 15 && Math.abs(n.lx - list[i - 1].lx) < 150) n.ly = list[i - 1].ly + 15;
    });

  const figures = sectors
    .map((s) => stars.filter((st) => st.sector === s.id).slice(0, 5))
    .filter((group) => group.length >= 3)
    .map((group) => group.map((st) => `${st.x},${st.y}`).join(" "));

  const arcs: ChartArc[] = [...model.ac.values()]
    .filter((l) => agencyAt.has(l.source) && starAt.has(l.target))
    .sort(byDollars)
    .slice(0, opts.arcs ?? 64)
    .map((l) => {
      const from = agencyAt.get(l.source)!;
      const to = starAt.get(l.target)!;
      return {
        key: l.key,
        source: l.source,
        target: l.target,
        d: sweepPath(from.x, from.y, to.x, to.y),
        dollars: l.dollars,
        awards: l.awards.length,
        lead: from.lead,
      };
    });

  // The newest awards on record, one arc each: the chart's "proof of life".
  const live: ChartLive[] = [...model.awards]
    .filter((aw) => agencyAt.has(aw.agency) && starAt.has(aw.company))
    .sort((p, q) => (p.day < q.day ? 1 : p.day > q.day ? -1 : q.id - p.id))
    .slice(0, opts.live ?? 14)
    .map((award) => {
      const from = agencyAt.get(award.agency)!;
      const to = starAt.get(award.company)!;
      return { award, d: sweepPath(from.x, from.y, to.x, to.y), source: award.agency, target: award.company };
    });

  return { agencies, sectors, stars, named, figures, arcs, live };
}

/** The limb's tick marks: one every two degrees, a longer one every ten. */
export function limbTicks(): { x1: number; y1: number; x2: number; y2: number; major: boolean }[] {
  const out = [];
  for (let deg = 0; deg < 360; deg += 2) {
    const major = deg % 10 === 0;
    const a = (deg * Math.PI) / 180;
    const [x1, y1] = polar(a, R.limb);
    const [x2, y2] = polar(a, R.limb - (major ? 11 : 5));
    out.push({ x1, y1, x2, y2, major });
  }
  return out;
}
