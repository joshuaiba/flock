import { forceCollide, forceLink, forceManyBody, forceSimulation, type Force } from "d3-force-3d";
import type { Graph as ApiGraph } from "@/lib/api";
import { orderTags, prepare, type L, type N } from "@/lib/graphLayout";

// The 3D layout. Like the flat one it runs once, in slices so the page stays
// responsive, and then stops for good: nothing jitters while someone explores.
//
// Each category is a constellation. Its members are pulled weakly toward the
// category's own point on a sphere, agencies and offices are pulled gently
// toward the middle, and the award edges between them do the rest. Strong
// repulsion and a collision force by radius keep big nodes from swallowing
// their neighbors, so no two medallions ever share space.

export type Region3 = {
  tag: string;
  x: number;
  y: number;
  z: number;
  /** how far the category's members reach from its center */
  radius: number;
  n: number;
};

export type Scene3 = {
  nodes: N[];
  links: L[];
  near: Map<string, Set<string>>;
  byId: Map<string, N>;
  /** every link that touches a node */
  linksOf: Map<string, L[]>;
  /** one per category: where its name is written */
  regions: Region3[];
  /** radius of the sphere around the origin that holds every node */
  radius: number;
};

/** Room each node takes inside its constellation, used to size the sphere. */
const CELL = 66;
/** Clear space left between neighboring constellations. */
const GAP = 140;
/** How much room a node claims: its radius and half again, plus a margin, so
 *  neighbors never touch and a name has somewhere to go. */
const room = (n: N) => n.r * 1.5 + 9;

const pause = () => new Promise<void>((r) => setTimeout(r, 0));

/** k points spread evenly over a unit sphere (a Fibonacci lattice). */
function spherePoints(k: number): { x: number; y: number; z: number }[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: k }, (_, i) => {
    const y = k === 1 ? 0 : 1 - (2 * (i + 0.5)) / k;
    const ring = Math.sqrt(1 - y * y);
    return { x: Math.cos(i * golden) * ring, y, z: Math.sin(i * golden) * ring };
  });
}

/** Position every node in three dimensions. Resolves to null if `alive` turns
 *  false while it works (the graph was replaced or the view closed). */
export async function layoutGraph3D(data: ApiGraph, alive: () => boolean): Promise<Scene3 | null> {
  const { nodes, links, near, byId } = prepare(data);
  const linksOf = new Map<string, L[]>(nodes.map((n) => [n.id, []]));
  for (const l of links) {
    linksOf.get(l.source.id)!.push(l);
    linksOf.get(l.target.id)!.push(l);
  }

  // One center per category that has members, spread over a sphere just large
  // enough for the biggest constellation to keep a gap from its neighbors.
  const members = new Map<string, number>();
  for (const n of nodes) if (!n.org && n.tag) members.set(n.tag, (members.get(n.tag) ?? 0) + 1);
  const tags = orderTags(members.keys());
  const biggest = Math.max(1, ...members.values());
  const reach = CELL * Math.cbrt(biggest);
  // neighbors on the lattice sit about this many radians apart
  const apart = Math.min(2, Math.sqrt((4 * Math.PI) / Math.max(tags.length, 1)));
  const sphere = tags.length < 2 ? 0 : (2 * reach + GAP) / apart;
  const points = spherePoints(tags.length);
  const center = new Map(tags.map((t, i) => [t, { x: points[i].x * sphere, y: points[i].y * sphere, z: points[i].z * sphere }]));
  const ORIGIN = { x: 0, y: 0, z: 0 };
  const home = (n: N) => (!n.org && n.tag ? (center.get(n.tag) ?? ORIGIN) : ORIGIN);

  // Start each node near where it belongs, with a deterministic scatter: the
  // same data always lays out the same way.
  nodes.forEach((n, i) => {
    const h = home(n);
    const j = (i * 2654435761) % 4093;
    const spread = n.org ? reach * 0.5 : reach * 0.8;
    n.x = h.x + (((j % 41) - 20) / 20) * spread;
    n.y = h.y + (((j % 29) - 14) / 14) * spread;
    n.z = h.z + (((j % 37) - 18) / 18) * spread;
  });

  // The weak pull that makes the constellations. Agencies and offices feel a
  // gentler pull toward the middle, where they sit between their awardees.
  const cluster: Force<N> = (alpha) => {
    for (const n of nodes) {
      const h = home(n);
      // stronger than the edges, or awards to shared agencies would blur the groups together
      const k = (n.org ? 0.09 : 0.4) * alpha;
      n.vx = (n.vx ?? 0) + (h.x - n.x) * k;
      n.vy = (n.vy ?? 0) + (h.y - n.y) * k;
      n.vz = (n.vz ?? 0) + (h.z - n.z) * k;
    }
  };

  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.source.id, (degree.get(l.source.id) ?? 0) + 1);
    degree.set(l.target.id, (degree.get(l.target.id) ?? 0) + 1);
  }
  const springs = links.map((l) => ({ source: l.source, target: l.target, link: l }));

  const big = nodes.length > 450;
  const ticks = big ? 130 : 300;
  const sim = forceSimulation<N>(nodes, 3)
    .stop()
    .alphaMin(0.001)
    .alphaDecay(1 - Math.pow(0.001, 1 / ticks))
    .velocityDecay(0.45)
    .force(
      "charge",
      forceManyBody<N>()
        .strength((n) => -(80 + n.r * n.r * 0.55))
        .theta(big ? 1.3 : 0.8)
        .distanceMax(Math.max(380, reach * 2.2)),
    )
    .force(
      "link",
      forceLink<N, (typeof springs)[number]>(springs)
        // longer between bigger nodes, so a large medallion keeps its neighbors at arm's length
        .distance((s) => 30 + (s.source.r + s.target.r) * 1.7)
        // a hub with many edges pulls each one weakly, or it would collapse its neighbors onto itself
        .strength((s) => {
          const share = 1 / Math.min(degree.get(s.source.id) ?? 1, degree.get(s.target.id) ?? 1);
          return share * (s.link.kind === "part_of" ? 0.9 : s.link.kind === "award" ? 0.28 : 0.22);
        }),
    )
    .force("cluster", cluster)
    .force("collide", forceCollide<N>(room).strength(0.9).iterations(big ? 1 : 2));

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
  sim.force("charge", null).force("link", null).force("cluster", null).alpha(0.001);
  sim.force("collide", forceCollide<N>(room).strength(1).iterations(3));
  sim.tick(big ? 4 : 8);

  // Center the whole graph on the origin, which is what the camera orbits.
  let cx = 0, cy = 0, cz = 0;
  for (const n of nodes) {
    cx += n.x;
    cy += n.y;
    cz += n.z;
  }
  const count = Math.max(nodes.length, 1);
  cx /= count;
  cy /= count;
  cz /= count;
  let radius = 0;
  for (const n of nodes) {
    n.x -= cx;
    n.y -= cy;
    n.z -= cz;
    n.vx = n.vy = n.vz = 0;
    radius = Math.max(radius, Math.hypot(n.x, n.y, n.z) + n.r);
  }

  // Where each category's name goes: the center of its members.
  const sums = new Map<string, Region3>();
  for (const n of nodes) {
    if (n.org || !n.tag) continue;
    const g = sums.get(n.tag) ?? { tag: n.tag, x: 0, y: 0, z: 0, radius: 0, n: 0 };
    g.x += n.x;
    g.y += n.y;
    g.z += n.z;
    g.n++;
    sums.set(n.tag, g);
  }
  const regions = [...sums.values()];
  for (const g of regions) {
    g.x /= g.n;
    g.y /= g.n;
    g.z /= g.n;
  }
  for (const n of nodes) {
    const g = !n.org && n.tag ? sums.get(n.tag) : null;
    if (g) g.radius = Math.max(g.radius, Math.hypot(n.x - g.x, n.y - g.y, n.z - g.z) + n.r);
  }

  nodes.sort((a, b) => a.rank - b.rank);
  return { nodes, links, near, byId, linksOf, regions, radius: Math.max(radius, 60) };
}
