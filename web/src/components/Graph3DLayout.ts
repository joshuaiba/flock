import type { Graph as ApiGraph } from "@/lib/api";
import type { Family } from "@/lib/signals";
import { layoutGraph, withDepth, type L, type N } from "@/lib/graphLayout";

// The 3D layout is the flat one (lib/graphLayout.ts) lifted off the page: the
// same category clusters in the same places around the ring, the same agencies
// in the middle, the same sizes and the same merged money edges, with a little
// depth given to every node so the map has something to orbit. Seen from the
// front it reads like the flat view; turned, the clusters show their depth.
//
// Like the flat layout it runs once, in slices, and then stops for good, and
// nothing in it is random: the depth comes from each node's id.
//
// Coordinates here are three.js world units, which are the flat layout's world
// pixels, with y turned to point up (three.js is y-up, the canvas y-down).

/** How far a company or solicitation may sit in front of or behind the plane,
 *  in world pixels. Small beside the map's width (about 1,500 on the sample
 *  data), so the clusters keep their shape from the front. */
export const DEPTH = 90;

/** A category's caption in the 3D scene. */
export type Region3 = {
  tag: string;
  family: Family;
  /** the caption text */
  label: string;
  /** the horizontal center of the cluster's body */
  x: number;
  /** the centroid's height (y up) */
  y: number;
  /** the members' average depth: where the caption floats */
  z: number;
  /** the top of the cluster (y up): its highest member's y plus its radius.
   *  The caption's baseline sits CAPTION_RISE above it. */
  top: number;
  /** companies in the category */
  n: number;
};

export type Scene3 = {
  nodes: N[];
  links: L[];
  near: Map<string, Set<string>>;
  byId: Map<string, N>;
  /** every link that touches a node */
  linksOf: Map<string, L[]>;
  /** one per category with members: where its caption is written */
  regions: Region3[];
  /** where the camera looks: the middle of the box that holds every mark */
  center: { x: number; y: number; z: number };
  /** radius of the sphere around `center` that holds every node */
  radius: number;
};

/** Position every node in three dimensions. Resolves to null if `alive` turns
 *  false while it works (the graph was replaced or the view closed). */
export async function layoutGraph3D(data: ApiGraph, alive: () => boolean): Promise<Scene3 | null> {
  const flat = await layoutGraph(data, alive);
  if (!flat || !alive()) return null;
  // layoutGraph hands back objects of its own, never shared with the flat
  // view, so they can be turned y-up in place.
  const { nodes, links, near, byId, bounds } = flat;
  withDepth(nodes, DEPTH);
  for (const n of nodes) n.y = -n.y;

  const linksOf = new Map<string, L[]>(nodes.map((n) => [n.id, []]));
  for (const l of links) {
    linksOf.get(l.source.id)!.push(l);
    linksOf.get(l.target.id)!.push(l);
  }

  // Each caption floats at its cluster's average depth.
  const depth = new Map<string, { z: number; k: number }>();
  for (const n of nodes) {
    if (n.kind !== "company" || !n.tag) continue;
    const d = depth.get(n.tag) ?? { z: 0, k: 0 };
    d.z += n.z;
    d.k++;
    depth.set(n.tag, d);
  }
  const regions: Region3[] = flat.regions.map((g) => {
    const d = depth.get(g.tag);
    return { tag: g.tag, family: g.family, label: g.label, x: g.x, y: -g.y, z: d ? d.z / d.k : 0, top: -g.top, n: g.n };
  });

  // The middle of the map, captions included, which is what the camera orbits.
  const center = { x: (bounds.x0 + bounds.x1) / 2, y: -(bounds.y0 + bounds.y1) / 2, z: 0 };
  let radius = 60;
  for (const n of nodes) radius = Math.max(radius, Math.hypot(n.x - center.x, n.y - center.y, n.z - center.z) + n.r);

  return { nodes, links, near, byId, linksOf, regions, center, radius };
}
