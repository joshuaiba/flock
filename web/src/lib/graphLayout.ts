import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import noverlap from "graphology-layout-noverlap";
import type { Graph as ApiGraph, GraphEdge, GraphNode, NodeKind } from "./api";
import { TAGS } from "./tags";

// Graph layout: ForceAtlas2 (strong repulsion, low gravity, linLog off,
// Barnes-Hut for large graphs), then noverlap so no two nodes touch. It runs
// once, in slices so the page stays responsive, and then stops for good: the
// layout never jitters while someone explores.

export type N = GraphNode & {
  x: number;
  y: number;
  /** depth: always 0 in the flat layout, set by the 3D layout */
  z: number;
  /** velocity, used only while the 3D layout settles */
  vx?: number;
  vy?: number;
  vz?: number;
  /** radius of the node's mark in world pixels: sqrt of dollars, clamped */
  r: number;
  /** 0 = most money; label priority */
  rank: number;
  org: boolean;
  nameLower: string;
  labelWidth: number;
};
export type L = Omit<GraphEdge, "source" | "target"> & { source: N; target: N; w: number };
export type Scene = {
  nodes: N[];
  links: L[];
  /** one per category: where its name is written on the map */
  regions: { tag: string; x: number; y: number; top: number; n: number }[];
  near: Map<string, Set<string>>;
  byId: Map<string, N>;
  bounds: { x0: number; y0: number; x1: number; y1: number };
};

// Nodes are plain marks: a filled dot for a company, a ring for an agency or
// office, a small diamond for a solicitation. A company's dot is sized by its
// dollars; rings keep to a narrow range, so an agency reads as a place on the
// map and not as a bigger company.
const DOT_MIN = 3.5;
const DOT_MAX = 22;
const RING_MIN = 9;
const RING_MAX = 14;
const DIAMOND = 5.5;

/** Radius on a sqrt scale of dollars, so a few giants don't swamp the rest.
 *  Solicitations carry no dollars and are all one size. */
export function radius(n: GraphNode): number {
  if (n.kind === "opportunity") return DIAMOND;
  const byDollars = Math.sqrt(Math.max(n.total, 0) / 1e6);
  if (n.kind === "company") return Math.max(DOT_MIN, Math.min(DOT_MAX, 2.5 + byDollars * 1.5));
  return Math.max(RING_MIN, Math.min(RING_MAX, 8 + byDollars * 0.35));
}

const pause = () => new Promise<void>((r) => setTimeout(r, 0));

/** Categories in the graph, in the taxonomy's order (unknown ones last, by name). */
export function orderTags(tags: Iterable<string>): string[] {
  return [...new Set(tags)].sort(
    (a, b) => ((TAGS.indexOf(a) + 99) % 99) - ((TAGS.indexOf(b) + 99) % 99) || a.localeCompare(b),
  );
}

/** The API graph as drawable nodes and links, before any layout: sizes,
 *  label priority and who neighbors whom. Each call returns fresh
 *  objects, so the flat and 3D layouts never share positions. */
export function prepare(data: ApiGraph): Pick<Scene, "nodes" | "links" | "near" | "byId"> {
  const byTotal = [...data.nodes].sort((a, b) => b.total - a.total);
  const rank = new Map(byTotal.map((n, i) => [n.id, i]));
  const nodes: N[] = data.nodes.map((n) => ({
    ...n,
    x: 0,
    y: 0,
    z: 0,
    r: radius(n),
    rank: rank.get(n.id) ?? 0,
    org: n.kind === "agency" || n.kind === "office",
    nameLower: n.name.toLowerCase(),
    labelWidth: 0,
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links: L[] = [];
  for (const e of data.edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t || s === t) continue;
    const w = e.kind === "award" ? Math.max(0, Math.min(4, Math.log10(Math.max(e.amount, 1) / 1e5))) : 0;
    links.push({ ...e, source: s, target: t, w });
  }
  const near = new Map<string, Set<string>>();
  for (const n of nodes) near.set(n.id, new Set());
  for (const l of links) {
    near.get(l.source.id)!.add(l.target.id);
    near.get(l.target.id)!.add(l.source.id);
  }
  return { nodes, links, near, byId };
}

export async function layoutGraph(data: ApiGraph, alive: () => boolean): Promise<Scene | null> {
  const { nodes, links, near, byId } = prepare(data);

  // Each category gets an invisible anchor that its members are tied to, so
  // ForceAtlas2 gathers a category into one region of the map.
  const present = orderTags(nodes.map((n) => n.tag).filter((t): t is string => !!t));
  const g = new Graph({ type: "undirected", multi: false });
  present.forEach((tag, i) => {
    const a = (i / present.length) * Math.PI * 2 - Math.PI / 2;
    g.addNode(`tag:${tag}`, { x: Math.cos(a) * 300, y: Math.sin(a) * 300, size: 1 });
  });
  nodes.forEach((n, i) => {
    const anchor = n.tag ? g.getNodeAttributes(`tag:${n.tag}`) : { x: 0, y: 0 };
    const j = (i * 2654435761) % 1000; // deterministic jitter: the same data lays out the same way
    g.addNode(n.id, { x: anchor.x + ((j % 41) - 20) * 3, y: anchor.y + ((j % 29) - 14) * 3, size: n.r });
    if (n.tag && !n.org) g.addEdge(n.id, `tag:${n.tag}`, { weight: 2.5 });
  });
  for (const l of links) {
    const weight = l.kind === "award" ? 0.5 + l.w * 0.3 : l.kind === "part_of" ? 1.5 : 0.8;
    g.mergeEdge(l.source.id, l.target.id, { weight });
  }

  const big = g.order > 600;
  const settings = {
    linLogMode: false,
    gravity: 0.12,
    scalingRatio: 26,
    strongGravityMode: false,
    outboundAttractionDistribution: true, // keeps hubs from collapsing their neighbors onto them
    edgeWeightInfluence: 1,
    barnesHutOptimize: big,
    barnesHutTheta: 0.6,
    slowDown: 1 + Math.log(g.order),
    adjustSizes: false,
  };
  const total = big ? 260 : 420;
  const slice = big ? 20 : 70;
  for (let done = 0; done < total; done += slice) {
    forceAtlas2.assign(g, { iterations: Math.min(slice, total - done), settings, getEdgeWeight: "weight" });
    await pause();
    if (!alive()) return null;
  }
  for (const tag of present) g.dropNode(`tag:${tag}`);

  // One uniform scale (x and y together, so the shape is never stretched) that
  // gives each node roughly a 125px cell, then noverlap with a gap of about
  // 1.5x the node radius between neighbors.
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  g.forEachNode((_, a) => {
    x0 = Math.min(x0, a.x);
    x1 = Math.max(x1, a.x);
    y0 = Math.min(y0, a.y);
    y1 = Math.max(y1, a.y);
  });
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  let s = Math.sqrt((Math.max(g.order, 12) * 125 * 125) / area);
  // Dense clusters set the scale too, so a crowded region is never left clumped.
  const pts = g.mapNodes((_, a) => a as { x: number; y: number; size: number });
  const sample = pts.length > 1500 ? pts.filter((_, i) => i % Math.ceil(pts.length / 1500) === 0) : pts;
  // For each node: how much the layout must grow for it to clear its nearest neighbor.
  const need = sample
    .map((p) => {
      let best = Infinity;
      let size = 0;
      for (const q of pts) {
        if (q === p) continue;
        const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
        if (d < best) {
          best = d;
          size = q.size;
        }
      }
      return (1.75 * (p.size + size)) / (Math.sqrt(best) || 1);
    })
    .sort((a, b) => a - b);
  // Grow until two thirds of the nodes are already clear; noverlap handles the rest.
  s = Math.max(s, need[Math.floor(need.length * 0.66)] || 0);
  g.updateEachNodeAttributes((_, a) => ({ ...a, x: (a.x - (x0 + x1) / 2) * s, y: (a.y - (y0 + y1) / 2) * s }));
  await pause();
  // noverlap runs in slices too, until it reports nothing left to separate.
  for (let pass = 0; pass < (big ? 12 : 6); pass++) {
    noverlap.assign(g, {
      maxIterations: 60,
      settings: { ratio: 1.75, margin: 4, expansion: 1.12, gridSize: big ? 40 : 20, speed: 3 },
    });
    await pause();
    if (!alive()) return null;
  }

  const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const n of nodes) {
    const a = g.getNodeAttributes(n.id);
    n.x = a.x;
    n.y = a.y;
    bounds.x0 = Math.min(bounds.x0, n.x - n.r);
    bounds.x1 = Math.max(bounds.x1, n.x + n.r);
    bounds.y0 = Math.min(bounds.y0, n.y - n.r);
    bounds.y1 = Math.max(bounds.y1, n.y + n.r);
  }

  // Category regions: the centroid and top edge of each category's members,
  // which is where the category's name is written.
  const regionAcc = new Map<string, { x: number; y: number; top: number; n: number }>();
  for (const n of nodes) {
    if (!n.tag || n.org) continue;
    const r = regionAcc.get(n.tag) ?? { x: 0, y: 0, top: Infinity, n: 0 };
    r.x += n.x;
    r.y += n.y;
    r.top = Math.min(r.top, n.y - n.r);
    r.n++;
    regionAcc.set(n.tag, r);
  }
  const regions = [...regionAcc].map(([tag, r]) => ({ tag, x: r.x / r.n, y: r.y / r.n, top: r.top, n: r.n }));

  nodes.sort((a, b) => a.rank - b.rank);
  return { nodes, links, regions, near, byId, bounds };
}

/** A synthetic graph for profiling the renderer at scale (development only). */
export function stressGraph(count: number): ApiGraph {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const agencies = Math.max(8, Math.round(count / 80));
  const nodes: GraphNode[] = [];
  for (let i = 0; i < count; i++) {
    const agency = i < agencies;
    const tag = TAGS[Math.floor(rnd() * TAGS.length)];
    nodes.push({
      id: `org:${i}`,
      kind: agency ? "agency" : rnd() < 0.2 ? "opportunity" : "company",
      name: `${agency ? "Agency" : "Entity"} ${i}`,
      total: Math.exp(rnd() * 9) * 1e5,
      awards: 1 + Math.floor(rnd() * 9),
      tags: [tag],
      tag,
    });
  }
  const edges: GraphEdge[] = [];
  for (let i = agencies; i < count; i++) {
    for (let k = 0; k < 3; k++) {
      const a = Math.floor(Math.pow(rnd(), 2) * agencies);
      edges.push({ source: `org:${a}`, target: `org:${i}`, kind: "award", amount: Math.exp(rnd() * 9) * 1e5, n: 1 });
    }
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
