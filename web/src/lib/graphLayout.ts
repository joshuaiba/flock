import { forceCollide, forceSimulation, type Force } from "d3-force-3d";
import type { Graph as ApiGraph, GraphEdge, GraphNode, NodeKind } from "./api";
import { familyOf, type Family } from "./signals";
import { TAGS, tagLabel } from "./tags";

// Graph layout. Companies gather in category clusters set on a ring around the
// middle of the map, in a fixed order so a category is always in the same
// place; agencies and offices sit inside the ring, the biggest payers nearest
// the center. A d3-force simulation does the placing (d3-force-3d, which the 3D
// view already uses, run in two dimensions): each company is pulled
// toward its category's anchor and toward the agency that paid it most, and a
// collision force keeps every mark clear of its neighbors. It runs once, in
// slices so the page stays responsive, and then stops for good: the layout
// never jitters while someone explores. Nothing in it is random, so the same
// data always lays out the same way.
//
// Units: world pixels, which are CSS pixels at zoom 1. The map is centered on
// (0, 0) with y pointing down, as on a canvas.

export type N = GraphNode & {
  x: number;
  y: number;
  /** depth: always 0 in the flat layout, set by withDepth for the 3D view */
  z: number;
  /** velocity, used only while a layout settles */
  vx?: number;
  vy?: number;
  vz?: number;
  /** radius of the node's mark in world pixels (see radius()); for an agency
   *  or office, the outer ring */
  r: number;
  /** 0 = most money; label priority */
  rank: number;
  org: boolean;
  /** the short label: the API's display_name, else the full name */
  display: string;
  /** the full name and the short label, lower-cased, for search */
  nameLower: string;
  labelWidth: number;
  /** the family of the node's primary category; null when it has none */
  family: Family | null;
  /** a company's main paying agency or office (the id of the org that paid it
   *  the most in the window); null for everything else */
  mainAgency: string | null;
  /** dollars an agency or office paid out in the window; 0 for the rest */
  paid: number;
};

/** A drawable edge. An award edge is every award between one agency (or
 *  office) and one company merged into one: `source` is the agency, `target`
 *  the company, `amount` the summed dollars and `n` the award count. Other
 *  edges (issued, answered, part_of) are as the API sent them. */
export type L = Omit<GraphEdge, "source" | "target"> & {
  source: N;
  target: N;
  /** log10 of the dollars over $100k, 0 to 4; kept for older drawing code */
  w: number;
  /** stroke width in world pixels at zoom 1 (edgeWidth for awards) */
  width: number;
  /** stroke opacity: 0.07 to 0.29 for awards, in the accent; QUIET_ALPHA for
   *  the rest, in the text color */
  alpha: number;
};

/** A category's caption: written centered at x, with its top edge at `top`. */
export type Region = {
  tag: string;
  family: Family;
  /** the caption text */
  label: string;
  /** the horizontal center of the cluster */
  x: number;
  /** the vertical centroid of the cluster */
  y: number;
  /** the top of the cluster: the highest member's y minus its radius */
  top: number;
  /** companies in the category */
  n: number;
  /** the members the caption sits over (the body of the cluster, without
   *  the strays), so a view can place it over the marks as it draws them */
  core: N[];
};

export type Scene = {
  nodes: N[];
  links: L[];
  /** one per category with members: where its caption goes */
  regions: Region[];
  near: Map<string, Set<string>>;
  byId: Map<string, N>;
  /** every mark and caption, in world pixels */
  bounds: { x0: number; y0: number; x1: number; y1: number };
  /** the half-width and half-height of the ellipse the category anchors sit on
   *  (always set by layoutGraph) */
  ring?: { rx: number; ry: number };
};

// ---- Sizes ----
//
// A company's dot has its area in proportion to the dollars it was awarded, so
// its radius goes with the square root. The scale is fixed rather than fitted
// to the data, so a company keeps its size when the window or the filters
// change: $250M, about what the largest autonomy vendors take in a quarter,
// reaches the 26px cap, $20M is 7.4px, and anything under about $4.5M sits at
// the 3.5px floor where a dot is still easy to see and to hit.

export const COMPANY_MIN_R = 3.5;
export const COMPANY_MAX_R = 26;
/** pixels per sqrt($M): 26 / sqrt(250) */
export const COMPANY_SCALE = COMPANY_MAX_R / Math.sqrt(250);
/** half the diagonal of a solicitation's diamond; every solicitation is this size */
export const SOLICITATION_R = 3.6;
/** an agency's inner ring, as a share of its outer ring's radius */
export const INNER_RING = 0.45;
/** a company at least this big is "large": it keeps more room around it */
export const LARGE_R = 14;

export function companyRadius(dollars: number): number {
  return Math.max(COMPANY_MIN_R, Math.min(COMPANY_MAX_R, COMPANY_SCALE * Math.sqrt(Math.max(dollars, 0) / 1e6)));
}

/** An agency's outer ring: 5 + 5.5 log10(1 + $M paid). $100M is 16px, $1B 21.5px. */
export function agencyRadius(paid: number): number {
  return 5 + 5.5 * Math.log10(1 + Math.max(paid, 0) / 1e6);
}

/** The radius of a node's mark in world pixels at zoom 1. */
export function radius(n: GraphNode): number {
  if (n.kind === "opportunity") return SOLICITATION_R;
  if (n.kind === "company") return companyRadius(n.total);
  return agencyRadius(n.total);
}

// ---- Edges ----

/** Award edge opacity runs from the smallest merged edge in the graph to the largest. */
export const EDGE_ALPHA_MIN = 0.07;
export const EDGE_ALPHA_MAX = 0.29;
/** Stroke of the edges that carry no money (solicitations, part_of): dotted, in the text color. */
export const QUIET_ALPHA = 0.14;
export const QUIET_WIDTH = 0.7;
/** How far a curved edge bows out: its control point sits this share of its length off the chord. */
export const BEND = 0.12;

/** An award edge's stroke width in world pixels: 0.5 + 1.15 log10(1 + 4 x $M). */
export function edgeWidth(dollars: number): number {
  return 0.5 + 1.15 * Math.log10(1 + (4 * Math.max(dollars, 0)) / 1e6);
}

/** The control point of a quadratic curve from (x0, y0) to (x1, y1), bowed
 *  `bend` of the chord's length to the left of the direction of travel (as
 *  seen on a y-down screen). Works on world or screen coordinates. */
export function bendPoint(x0: number, y0: number, x1: number, y1: number, bend = BEND): { cx: number; cy: number } {
  const dx = x1 - x0;
  const dy = y1 - y0;
  return { cx: (x0 + x1) / 2 - dy * bend, cy: (y0 + y1) / 2 + dx * bend };
}

/** The ends of an edge in the order its curve is drawn: an award runs from
 *  the company to the agency, everything else from source to target. Always
 *  going the same way is what makes the bends consistent. */
export function curveEnds(l: L): [N, N] {
  return l.kind === "award" ? [l.target, l.source] : [l.source, l.target];
}

/** The control point of an edge's curve in world coordinates: draw it as
 *  moveTo(from) quadraticCurveTo(cx, cy, to) with [from, to] = curveEnds(l). */
export function curveControl(l: L, bend = BEND): { cx: number; cy: number } {
  const [a, b] = curveEnds(l);
  return bendPoint(a.x, a.y, b.x, b.y, bend);
}

// ---- Clusters ----

/** Where each category's cluster sits on the ring, in degrees clockwise from
 *  12 o'clock on the screen (the angle on the ring before it is stretched
 *  into an ellipse). Grouped by family so neighbors stay stable: the aerial
 *  categories top right (uncrewed aircraft, collaborative combat aircraft,
 *  swarming), ground robotics right, command and teaming bottom right,
 *  autonomy software bottom, maritime bottom left, loitering munitions left,
 *  counter-drone top left, and navigation without GPS at the top, between
 *  counter-drone and the aircraft. Within that order the angles are spread
 *  as evenly as the ellipse allows, since the closest pair of neighbors sets
 *  the size of the whole ring. */
export const CATEGORY_ANGLES: Readonly<Record<string, number>> = {
  uas: 18,
  "collaborative-combat-aircraft": 47,
  swarming: 82,
  "ground-robotics": 118,
  "uxs-c2": 150,
  "autonomy-software": 182,
  maritime: 222,
  "loitering-munitions": 264,
  "counter-uas": 304,
  "gps-denied-nav": 343,
};

/** The map is wider than it is tall: the ring is an ellipse this much wider
 *  than high, like the canvas it is drawn on. */
const ASPECT = 1.45;
/** Smallest half-height of the anchor ring, in world pixels. */
const RING_MIN = 330;
/** Where a cluster settles between its anchor (1) and the middle (0): the
 *  pull toward each company's agency draws it in a little. */
const SETTLE = 0.78;
/** Clear space kept between neighboring clusters, and between a cluster and the agencies. */
const CLUSTER_GAP = 56;
/** How tightly a cluster packs its members' collision circles. */
const PACK = 0.8;
/** The half-height of the region the agencies sit in grows with the square root of their number. */
const ZONE = 50;
/** An agency's keep-clear zone: no other mark comes nearer than this to its ring. */
const KEEP_CLEAR = 30;
/** The pull toward the main paying agency is a spring that goes slack this
 *  share of the way from the agency to the company's category anchor, so a
 *  company is drawn toward its payer without leaving its cluster. */
const REST = 0.5;

const STRENGTH_CATEGORY = 0.16;
const STRENGTH_AGENCY = 0.16;
const STRENGTH_AGENCY_TOP = 0.22;
/** how hard an agency is held at its slot */
const STRENGTH_SLOT = 0.5;
const STRENGTH_SOLICITATION = 0.3;

/** A category's angle on the ring (see CATEGORY_ANGLES); one the table lacks gets a stable spot of its own. */
export function categoryAngle(tag: string): number {
  const a = CATEGORY_ANGLES[tag];
  if (a !== undefined) return a;
  let h = 0;
  for (const c of tag) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

const DEG = Math.PI / 180;
/** A unit step in a compass direction, on a y-down screen. */
const compass = (deg: number) => ({ x: Math.sin(deg * DEG), y: -Math.cos(deg * DEG) });
/** A category's anchor on the ring of half-height 1. */
const onRing = (deg: number) => ({ x: ASPECT * Math.sin(deg * DEG), y: -Math.cos(deg * DEG) });

/** Room a node keeps around it in the collision force. Two companies keep
 *  10px apart (22px when both are large); an agency's ring keeps KEEP_CLEAR
 *  from any company's edge. */
function room(n: N): number {
  if (n.org) return n.r + KEEP_CLEAR - 5;
  if (n.kind === "company") return n.r + (n.r >= LARGE_R ? 11 : 5);
  return n.r + 5;
}

const pause = () => new Promise<void>((r) => setTimeout(r, 0));

/** Categories in the graph, in the taxonomy's order (unknown ones last, by name). */
export function orderTags(tags: Iterable<string>): string[] {
  return [...new Set(tags)].sort(
    (a, b) => ((TAGS.indexOf(a) + 99) % 99) - ((TAGS.indexOf(b) + 99) % 99) || a.localeCompare(b),
  );
}

/** The API graph as drawable nodes and links, before any layout: sizes,
 *  label priority, merged money edges and who neighbors whom. Each call
 *  returns fresh objects, so the flat and 3D layouts never share positions. */
export function prepare(data: ApiGraph): Pick<Scene, "nodes" | "links" | "near" | "byId"> {
  const byTotal = [...data.nodes].sort((a, b) => b.total - a.total);
  const rank = new Map(byTotal.map((n, i) => [n.id, i]));
  const nodes: N[] = data.nodes.map((n) => {
    const org = n.kind === "agency" || n.kind === "office";
    const display = n.display_name?.trim() || n.name;
    return {
      ...n,
      x: 0,
      y: 0,
      z: 0,
      r: radius(n),
      rank: rank.get(n.id) ?? 0,
      org,
      display,
      nameLower: (display === n.name ? n.name : `${n.name}\n${display}`).toLowerCase(),
      labelWidth: 0,
      family: n.tag ? familyOf(n.tag) : null,
      mainAgency: null,
      paid: org ? Math.max(n.total, 0) : 0,
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Every award between the same agency and company becomes one edge.
  const links: L[] = [];
  const merged = new Map<string, L>();
  for (const e of data.edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t || s === t) continue;
    if (e.kind !== "award") {
      links.push({ ...e, source: s, target: t, w: 0, width: QUIET_WIDTH, alpha: QUIET_ALPHA });
      continue;
    }
    const [org, other] = !s.org && t.org ? [t, s] : [s, t];
    const key = `${org.id}>${other.id}`;
    const m = merged.get(key);
    if (m) {
      m.amount += e.amount;
      m.n += e.n || 1;
    } else {
      const l: L = { kind: "award", source: org, target: other, amount: e.amount, n: e.n || 1, w: 0, width: 0, alpha: 0 };
      merged.set(key, l);
      links.push(l);
    }
  }

  // Award opacity follows log dollars across the merged edges.
  let lo = Infinity;
  let hi = -Infinity;
  for (const l of merged.values()) {
    const v = Math.log(Math.max(l.amount, 1));
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  for (const l of merged.values()) {
    const v = Math.log(Math.max(l.amount, 1));
    const t = hi > lo ? (v - lo) / (hi - lo) : 1;
    l.alpha = EDGE_ALPHA_MIN + (EDGE_ALPHA_MAX - EDGE_ALPHA_MIN) * t;
    l.width = edgeWidth(l.amount);
    l.w = Math.max(0, Math.min(4, Math.log10(Math.max(l.amount, 1) / 1e5)));
  }

  // A company's main paying agency is the one whose merged edge carries the
  // most dollars (the first of them on a tie, so it is stable).
  const best = new Map<string, number>();
  for (const l of merged.values()) {
    const c = l.target;
    if (c.kind !== "company" || !l.source.org) continue;
    if (l.amount > (best.get(c.id) ?? -1)) {
      best.set(c.id, l.amount);
      c.mainAgency = l.source.id;
    }
  }
  // An agency the API sent without a total still paid what its edges carry.
  for (const l of merged.values()) if (l.source.org && l.source.total <= 0) l.source.paid += l.amount;
  for (const n of nodes) if (n.org && n.total <= 0 && n.paid > 0) n.r = agencyRadius(n.paid);

  const near = new Map<string, Set<string>>();
  for (const n of nodes) near.set(n.id, new Set());
  for (const l of links) {
    near.get(l.source.id)!.add(l.target.id);
    near.get(l.target.id)!.add(l.source.id);
  }
  return { nodes, links, near, byId };
}

/** What pulls one node during the simulation: toward a fixed point (`ax`,
 *  `ay`, with strength `ak`), and toward another node (`to`) by a spring that
 *  goes slack within `rest` pixels of it (strength `lk`). */
type Pull = { n: N; ax: number; ay: number; ak: number; to: N | null; rest: number; lk: number };

/** Lay the graph out. Resolves to null if `alive` turns false while it works
 *  (the graph was replaced or the view closed). */
export async function layoutGraph(data: ApiGraph, alive: () => boolean): Promise<Scene | null> {
  const { nodes, links, near, byId } = prepare(data);
  const companies = nodes.filter((n) => n.kind === "company");
  const orgs = nodes.filter((n) => n.org).sort((a, b) => b.paid - a.paid || a.rank - b.rank);

  // How much room each category needs: the area of its members' collision
  // circles, loosely packed, as a radius.
  const area = new Map<string, number>();
  const count = new Map<string, number>();
  for (const n of companies) {
    if (!n.tag) continue;
    area.set(n.tag, (area.get(n.tag) ?? 0) + room(n) ** 2);
    count.set(n.tag, (count.get(n.tag) ?? 0) + 1);
  }
  const tags = orderTags(area.keys());
  const reach = new Map(tags.map((t) => [t, Math.sqrt(area.get(t)! / PACK)]));
  const unit = new Map(tags.map((t) => [t, onRing(categoryAngle(t))]));

  // The agencies' region, and the ring just big enough that every cluster
  // clears it and its neighbors once settled.
  const zoneY = ZONE * Math.sqrt(Math.max(orgs.length, 1));
  const zoneX = zoneY * ASPECT;
  let ry = RING_MIN;
  for (const t of tags) {
    const u = Math.hypot(unit.get(t)!.x, unit.get(t)!.y);
    ry = Math.max(ry, (zoneY * u + CLUSTER_GAP + reach.get(t)!) / (SETTLE * u));
  }
  for (let i = 0; i < tags.length; i++) {
    for (let j = i + 1; j < tags.length; j++) {
      const a = unit.get(tags[i])!;
      const b = unit.get(tags[j])!;
      const apart = Math.hypot(a.x - b.x, a.y - b.y);
      if (apart > 0) ry = Math.max(ry, (reach.get(tags[i])! + reach.get(tags[j])! + CLUSTER_GAP) / (SETTLE * apart));
    }
  }
  const anchor = new Map(tags.map((t) => [t, { x: unit.get(t)!.x * ry, y: unit.get(t)!.y * ry }]));

  // Agency slots. The biggest payer takes the center and the rest spread out
  // in order of dollars paid, each toward the categories its money went to,
  // so the Navy sits on the maritime side. Then a few passes push apart any
  // two slots closer than their keep-clear zones allow.
  const slot = new Map<string, { x: number; y: number }>();
  const pull = new Map<string, { x: number; y: number }>();
  for (const l of links) {
    if (l.kind !== "award" || !l.target.tag) continue;
    const d = compass(categoryAngle(l.target.tag));
    const p = pull.get(l.source.id) ?? { x: 0, y: 0 };
    p.x += d.x * l.amount;
    p.y += d.y * l.amount;
    pull.set(l.source.id, p);
  }
  const parentOf = new Map<string, string>();
  for (const l of links) if (l.kind === "part_of") parentOf.set(l.source.id, l.target.id);
  orgs.forEach((o, i) => {
    let p = pull.get(o.id) ?? pull.get(parentOf.get(o.id) ?? "");
    if (!p || Math.hypot(p.x, p.y) === 0) p = compass(i * 137.508);
    const len = Math.hypot(p.x, p.y);
    const f = orgs.length > 1 ? Math.sqrt(i / (orgs.length - 1)) : 0;
    slot.set(o.id, { x: (p.x / len) * f * zoneX, y: (p.y / len) * f * zoneY });
  });
  for (let pass = 0; pass < 60; pass++) {
    let moved = false;
    for (let i = 0; i < orgs.length; i++) {
      for (let j = i + 1; j < orgs.length; j++) {
        const a = slot.get(orgs[i].id)!;
        const b = slot.get(orgs[j].id)!;
        const need = room(orgs[i]) + room(orgs[j]) + 4;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= need) continue;
        if (d === 0) {
          const c = compass(j * 137.508);
          dx = c.x;
          dy = c.y;
          d = 1;
        }
        // the smaller payer gives way more, so the big ones keep the middle
        const push = (need - d) / d;
        const share = i === 0 ? 1 : 0.7;
        a.x -= dx * push * (1 - share);
        a.y -= dy * push * (1 - share);
        b.x += dx * push * share;
        b.y += dy * push * share;
        moved = true;
      }
    }
    if (!moved) break;
  }

  // What pulls each node.
  const topCompanies = new Set(
    [...companies].sort((a, b) => b.total - a.total || a.rank - b.rank).slice(0, 10).map((n) => n.id),
  );
  const issuer = new Map<string, N>();
  const answerer = new Map<string, N>();
  for (const l of links) {
    if (l.kind === "issued" && l.target.kind === "opportunity" && l.source.org) issuer.set(l.target.id, l.source);
    if (l.kind === "answered") {
      const [o, c] = l.source.kind === "opportunity" ? [l.source, l.target] : [l.target, l.source];
      if (c.kind === "company" && !answerer.has(o.id)) answerer.set(o.id, c);
    }
  }
  const pulls: Pull[] = nodes.map((n) => {
    if (n.org) {
      const s = slot.get(n.id)!;
      return { n, ax: s.x, ay: s.y, ak: STRENGTH_SLOT, to: null, rest: 0, lk: 0 };
    }
    if (n.kind === "company") {
      const payer = n.mainAgency ? (byId.get(n.mainAgency) ?? null) : null;
      const lk = topCompanies.has(n.id) ? STRENGTH_AGENCY_TOP : STRENGTH_AGENCY;
      const a = n.tag ? anchor.get(n.tag) : undefined;
      if (a) {
        const s = payer ? slot.get(payer.id)! : null;
        const rest = s ? REST * Math.hypot(a.x - s.x, a.y - s.y) : 0;
        return { n, ax: a.x, ay: a.y, ak: STRENGTH_CATEGORY, to: payer, rest, lk };
      }
      // No category: it stays by its agency, just outside the keep-clear zone.
      if (payer) return { n, ax: 0, ay: 0, ak: 0.02, to: payer, rest: room(payer) + room(n) + 30, lk };
      return { n, ax: 0, ay: 0, ak: 0.05, to: null, rest: 0, lk: 0 };
    }
    // A solicitation stays by the agency that issued it, or failing that by
    // the company that answered it.
    const by = issuer.get(n.id);
    if (by) return { n, ax: 0, ay: 0, ak: 0, to: by, rest: room(by) + room(n) + 6, lk: STRENGTH_SOLICITATION };
    const co = answerer.get(n.id);
    if (co) return { n, ax: 0, ay: 0, ak: 0, to: co, rest: room(co) + room(n) + 6, lk: 0.2 };
    return { n, ax: 0, ay: 0, ak: 0.05, to: null, rest: 0, lk: 0 };
  });

  // Starting places, all computed: an agency at its slot, a company on a
  // spiral around where its cluster will settle (biggest first, nearest the
  // middle of it), a solicitation on a spiral around its agency.
  const placed = new Map<string, number>();
  const golden = Math.PI * (3 - Math.sqrt(5));
  const spiral = (key: string, step: number, from: number) => {
    const k = placed.get(key) ?? 0;
    placed.set(key, k + 1);
    const d = from + step * Math.sqrt(k + 0.5);
    return { x: Math.cos(k * golden) * d, y: Math.sin(k * golden) * d };
  };
  const pullOf = new Map(pulls.map((p) => [p.n, p]));
  const order = [...nodes].sort((a, b) => a.rank - b.rank);
  for (const n of order) {
    const p = pullOf.get(n)!;
    if (n.org) {
      n.x = p.ax;
      n.y = p.ay;
    } else if (n.kind === "company" && n.tag && anchor.has(n.tag)) {
      const s = p.to ? slot.get(p.to.id)! : { x: 0, y: 0 };
      const cx = p.ax + (s.x - p.ax) * (1 - SETTLE) * 0.5;
      const cy = p.ay + (s.y - p.ay) * (1 - SETTLE) * 0.5;
      const o = spiral(`tag:${n.tag}`, reach.get(n.tag)! / Math.sqrt(count.get(n.tag)!), 0);
      n.x = cx + o.x;
      n.y = cy + o.y;
    } else if (p.to) {
      const s = slot.get(p.to.id) ?? { x: p.to.x, y: p.to.y };
      const o = spiral(`to:${p.to.id}`, 7, p.rest);
      n.x = s.x + o.x;
      n.y = s.y + o.y;
    } else {
      const o = spiral("center", 12, zoneY);
      n.x = o.x;
      n.y = o.y;
    }
  }
  if (!alive()) return null;

  const place: Force<N> = (alpha) => {
    for (const p of pulls) {
      const n = p.n;
      let vx = n.vx ?? 0;
      let vy = n.vy ?? 0;
      if (p.ak) {
        vx += (p.ax - n.x) * p.ak * alpha;
        vy += (p.ay - n.y) * p.ak * alpha;
      }
      if (p.to) {
        const dx = p.to.x - n.x;
        const dy = p.to.y - n.y;
        const d = Math.hypot(dx, dy);
        if (d > p.rest) {
          const k = ((d - p.rest) / d) * p.lk * alpha;
          vx += dx * k;
          vy += dy * k;
        }
      }
      n.vx = vx;
      n.vy = vy;
    }
  };

  // d3's own jiggle (for marks that land exactly on one another) draws from a
  // seeded generator, so the run is repeatable from start to end.
  const big = nodes.length > 600;
  const ticks = big ? 240 : 320;
  const sim = forceSimulation<N>(nodes, 2)
    .stop()
    .alpha(1)
    .alphaMin(0.001)
    .alphaDecay(1 - Math.pow(0.001, 1 / ticks))
    .velocityDecay(0.4)
    .force("place", place)
    .force("collide", forceCollide<N>(room).strength(0.85).iterations(big ? 1 : 2));
  for (let done = 0; done < ticks; ) {
    const started = performance.now();
    while (done < ticks && performance.now() - started < 12) {
      sim.tick();
      done++;
    }
    await pause();
    if (!alive()) return null;
  }
  // A last pass of collisions alone: whatever still touches is pushed apart.
  sim.force("place", null).force("collide", forceCollide<N>(room).strength(1).iterations(3)).alpha(0.001);
  sim.tick(big ? 6 : 10);
  for (const n of nodes) {
    n.vx = n.vy = n.vz = 0;
    n.z = 0;
  }

  const regions = captions(nodes);
  const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const n of nodes) {
    bounds.x0 = Math.min(bounds.x0, n.x - n.r);
    bounds.x1 = Math.max(bounds.x1, n.x + n.r);
    bounds.y0 = Math.min(bounds.y0, n.y - n.r);
    bounds.y1 = Math.max(bounds.y1, n.y + n.r);
  }
  // Captions count too, at a rough width for 13.5px italic EB Garamond. This
  // is only a world-sized estimate, for limiting how far the map pans: the
  // views fit the map with the captions and names measured in screen pixels,
  // which keep their size at any zoom.
  for (const g of regions) {
    const half = g.label.length * 3.2;
    bounds.x0 = Math.min(bounds.x0, g.x - half);
    bounds.x1 = Math.max(bounds.x1, g.x + half);
    bounds.y0 = Math.min(bounds.y0, g.top - CAPTION_RISE - 12);
  }
  if (!nodes.length) Object.assign(bounds, { x0: -1, y0: -1, x1: 1, y1: 1 });

  nodes.sort((a, b) => a.rank - b.rank);
  return { nodes, links, regions, near, byId, bounds, ring: { rx: ry * ASPECT, ry } };
}

/** How far above a cluster's top its caption's baseline sits, in world pixels. */
export const CAPTION_RISE = 8;

/** One caption per category with companies in it, over the body of the
 *  cluster: a member pulled far from the rest by its agency is left out of
 *  the measurement, so the caption stays on the cluster people see. */
function captions(nodes: N[]): Region[] {
  const groups = new Map<string, N[]>();
  for (const n of nodes) {
    if (n.kind !== "company" || !n.tag) continue;
    const g = groups.get(n.tag);
    if (g) g.push(n);
    else groups.set(n.tag, [n]);
  }
  const out: Region[] = [];
  for (const tag of orderTags(groups.keys())) {
    const members = groups.get(tag)!;
    let cx = 0;
    let cy = 0;
    for (const n of members) {
      cx += n.x;
      cy += n.y;
    }
    cx /= members.length;
    cy /= members.length;
    const dist = members.map((n) => Math.hypot(n.x - cx, n.y - cy)).sort((a, b) => a - b);
    const limit = Math.max(60, dist[Math.floor(dist.length / 2)] * 2.2);
    let core = members.filter((n) => Math.hypot(n.x - cx, n.y - cy) <= limit);
    if (!core.length) core = members;
    let x0 = Infinity;
    let x1 = -Infinity;
    let top = Infinity;
    for (const n of core) {
      x0 = Math.min(x0, n.x - n.r);
      x1 = Math.max(x1, n.x + n.r);
      top = Math.min(top, n.y - n.r);
    }
    out.push({ tag, family: familyOf(tag), label: tagLabel(tag), x: (x0 + x1) / 2, y: cy, top, n: members.length, core });
  }
  return out;
}

// ---- 3D ----
//
// The 3D view uses the flat layout's positions, lifted off the plane a little
// so the map has depth to orbit, rather than a layout of its own.

/** Give every node a depth, in place: companies and solicitations up to
 *  `depth` world pixels either side of the plane, agencies and offices within
 *  a third of that, so the hubs stay near the middle. The depth comes from the
 *  node's id, so it is the same on every visit. x and y are untouched (y still
 *  points down: a y-up 3D scene should negate it). */
export function withDepth(nodes: N[], depth = 90): void {
  for (const n of nodes) {
    let h = 2166136261;
    for (let i = 0; i < n.id.length; i++) h = Math.imul(h ^ n.id.charCodeAt(i), 16777619) >>> 0;
    const j = (h % 2001) / 1000 - 1;
    n.z = j * depth * (n.org ? 0.33 : 1);
  }
}

/** A synthetic graph for profiling the renderer at scale (development only):
 *  agencies, companies across every category, and solicitations, with each
 *  node's dollars summed from its edges as the API does. */
export function stressGraph(count: number): ApiGraph {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const agencies = Math.max(8, Math.round(count / 80));
  const nodes: GraphNode[] = [];
  const spent = new Map<GraphNode, Map<string, number>>();
  for (let i = 0; i < count; i++) {
    const agency = i < agencies;
    const tag = TAGS[Math.floor(rnd() * TAGS.length)];
    nodes.push({
      id: `org:${i}`,
      kind: agency ? "agency" : rnd() < 0.2 ? "opportunity" : "company",
      name: `${agency ? "Agency" : "Entity"} ${i}`,
      total: 0,
      awards: 0,
      tags: agency ? [] : [tag],
      tag: agency ? null : tag,
    });
  }
  const edges: GraphEdge[] = [];
  // Most money comes from a few agencies, as it does in the real record.
  const payer = () => Math.floor(Math.pow(rnd(), 2) * agencies);
  const companies = nodes.filter((n) => n.kind === "company");
  for (const n of nodes.slice(agencies)) {
    if (n.kind === "opportunity") {
      edges.push({ source: `org:${payer()}`, target: n.id, kind: "issued", amount: 0, n: 1 });
      if (rnd() < 0.6) {
        const c = companies[Math.floor(rnd() * companies.length)];
        edges.push({ source: n.id, target: c.id, kind: "answered", amount: 0, n: 1 });
      }
      continue;
    }
    const k = 1 + Math.floor(rnd() * 3);
    for (let e = 0; e < k; e++) {
      const a = nodes[payer()];
      const amount = Math.exp(rnd() * 7) * 2e5;
      const awards = 1 + Math.floor(rnd() * 4);
      edges.push({ source: a.id, target: n.id, kind: "award", amount, n: awards });
      n.total += amount;
      n.awards += awards;
      a.total += amount;
      a.awards += awards;
      const s = spent.get(a) ?? new Map<string, number>();
      s.set(n.tag!, (s.get(n.tag!) ?? 0) + amount);
      spent.set(a, s);
    }
  }
  for (const [a, s] of spent) {
    a.tags = orderTags(s.keys());
    a.tag = [...s].sort((x, y) => y[1] - x[1])[0][0];
  }
  return { days: 90, nodes, edges };
}

// ---- Filters ----
//
// One filter for both views of the graph. It works on the API graph, before
// any layout, and answers with the ids to hide; an edge is drawn only when both
// of its ends are shown.

export type GraphFilters = {
  /** categories to keep; empty means all of them */
  tags: ReadonlySet<string>;
  /** one agency or office ("org:12"): it, its offices, their awardees and solicitations */
  agency: string | null;
  /** companies awarded less than this many dollars in the window are hidden */
  min: number;
  /** the node types that are shown */
  kinds: ReadonlySet<NodeKind>;
  /** only the watchlist and its direct neighbors */
  watch: boolean;
};

export const ALL_KINDS: NodeKind[] = ["company", "agency", "office", "opportunity"];

type Index = {
  near: Map<string, string[]>;
  /** agency -> the offices that are part of it */
  offices: Map<string, string[]>;
  byId: Map<string, GraphNode>;
};
const indexes = new WeakMap<ApiGraph, Index>();

function indexOf(data: ApiGraph): Index {
  let ix = indexes.get(data);
  if (ix) return ix;
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const near = new Map<string, string[]>(data.nodes.map((n) => [n.id, []]));
  const offices = new Map<string, string[]>();
  for (const e of data.edges) {
    if (e.source === e.target || !byId.has(e.source) || !byId.has(e.target)) continue;
    near.get(e.source)!.push(e.target);
    near.get(e.target)!.push(e.source);
    // part_of points from the office to its parent
    if (e.kind === "part_of") offices.set(e.target, [...(offices.get(e.target) ?? []), e.source]);
  }
  ix = { near, offices, byId };
  indexes.set(data, ix);
  return ix;
}

const isOrg = (n: GraphNode) => n.kind === "agency" || n.kind === "office";

/** The ids the filters hide. `pinned` are the watchlist's node ids ("org:12"). */
export function hiddenNodes(data: ApiGraph, f: GraphFilters, pinned: ReadonlySet<string>): Set<string> {
  const { near, offices, byId } = indexOf(data);
  const hidden = new Set<string>();

  // The chosen agency with every office beneath it, and everything they touch.
  let group: Set<string> | null = null;
  let reach: Set<string> | null = null;
  if (f.agency && byId.has(f.agency)) {
    group = new Set([f.agency]);
    const todo = [f.agency];
    while (todo.length) {
      for (const o of offices.get(todo.pop()!) ?? []) {
        if (group.has(o)) continue;
        group.add(o);
        todo.push(o);
      }
    }
    reach = new Set(group);
    for (const id of group) for (const o of near.get(id) ?? []) reach.add(o);
  }

  let watched: Set<string> | null = null;
  if (f.watch) {
    watched = new Set();
    for (const id of pinned) {
      if (!byId.has(id)) continue;
      watched.add(id);
      for (const o of near.get(id) ?? []) watched.add(o);
    }
  }

  for (const n of data.nodes) {
    const org = isOrg(n);
    if (
      !f.kinds.has(n.kind) ||
      (group && reach && !(org ? group : reach).has(n.id)) ||
      (watched && !watched.has(n.id)) ||
      (!org && f.tags.size > 0 && !n.tags.some((t) => f.tags.has(t))) ||
      (n.kind === "company" && n.total < f.min)
    )
      hidden.add(n.id);
  }

  // A solicitation whose every answering company fell below the minimum has
  // nothing left to show. One that nobody answered yet stays with its agency.
  if (f.min > 0) {
    for (const n of data.nodes) {
      if (n.kind !== "opportunity" || hidden.has(n.id)) continue;
      const answered = (near.get(n.id) ?? []).filter((o) => byId.get(o)!.kind === "company");
      if (answered.length && answered.every((o) => byId.get(o)!.total < f.min)) hidden.add(n.id);
    }
  }

  // When the map is narrowed by category or amount, an agency or office stays
  // only while it still connects to something shown: offices first, so an
  // agency can stay for the sake of its office. The chosen agency and pinned
  // organizations are never dropped this way.
  if (f.tags.size > 0 || f.min > 0) {
    for (const pass of ["office", "agency"] as const) {
      for (const n of data.nodes) {
        if (n.kind !== pass || hidden.has(n.id)) continue;
        if (n.id === f.agency || (watched && pinned.has(n.id))) continue;
        const linked = (near.get(n.id) ?? []).some((o) => {
          const q = byId.get(o)!;
          return !hidden.has(o) && (!isOrg(q) || (pass === "agency" && q.kind === "office"));
        });
        if (!linked) hidden.add(n.id);
      }
    }
  }
  return hidden;
}
