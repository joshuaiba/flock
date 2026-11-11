import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import noverlap from "graphology-layout-noverlap";
import type { Graph as ApiGraph, GraphEdge, GraphNode } from "./api";
import { medallionFor, type MedallionName } from "./art";
import { TAGS } from "./tags";

// Graph layout: ForceAtlas2 (strong repulsion, low gravity, linLog off,
// Barnes-Hut for large graphs), then noverlap so no two nodes touch. It runs
// once, in slices so the page stays responsive, and then stops for good: the
// layout never jitters while someone explores.

export type N = GraphNode & {
  x: number;
  y: number;
  /** radius in world pixels: sqrt of dollars, clamped */
  r: number;
  /** which medallion image the node is drawn with */
  medallion: MedallionName;
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

// Nodes are drawn as medallion images, so the smallest must still be large
// enough for the art to read.
const R_MIN = 7;
const R_MAX = 30;

/** Radius on a sqrt scale of dollars, so a few giants don't swamp the rest.
 *  Solicitations carry no dollars and stay at the smallest size. */
export function radius(n: GraphNode): number {
  if (n.kind === "opportunity") return R_MIN;
  return Math.max(R_MIN, Math.min(R_MAX, 5.5 + Math.sqrt(Math.max(n.total, 0) / 1e6) * 1.85));
}

const pause = () => new Promise<void>((r) => setTimeout(r, 0));

export async function layoutGraph(data: ApiGraph, alive: () => boolean): Promise<Scene | null> {
  const byTotal = [...data.nodes].sort((a, b) => b.total - a.total);
  const rank = new Map(byTotal.map((n, i) => [n.id, i]));
  const nodes: N[] = data.nodes.map((n) => ({
    ...n,
    x: 0,
    y: 0,
    r: radius(n),
    medallion: medallionFor(n.tag, n.kind),
    rank: rank.get(n.id) ?? 0,
    org: n.kind === "agency" || n.kind === "office",
    nameLower: n.name.toLowerCase(),
    labelWidth: 0,
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Each category gets an invisible anchor that its members are tied to, so
  // ForceAtlas2 gathers a category into one region of the map.
  const present = [...new Set(nodes.map((n) => n.tag).filter((t): t is string => !!t))].sort(
    (a, b) => ((TAGS.indexOf(a) + 99) % 99) - ((TAGS.indexOf(b) + 99) % 99) || a.localeCompare(b),
  );
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
  const links: L[] = [];
  for (const e of data.edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t || s === t) continue;
    const w = e.kind === "award" ? Math.max(0, Math.min(4, Math.log10(Math.max(e.amount, 1) / 1e5))) : 0;
    links.push({ ...e, source: s, target: t, w });
    const weight = e.kind === "award" ? 0.5 + w * 0.3 : e.kind === "part_of" ? 1.5 : 0.8;
    g.mergeEdge(s.id, t.id, { weight });
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

  const near = new Map<string, Set<string>>();
  for (const n of nodes) near.set(n.id, new Set());
  for (const l of links) {
    near.get(l.source.id)!.add(l.target.id);
    near.get(l.target.id)!.add(l.source.id);
  }
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
