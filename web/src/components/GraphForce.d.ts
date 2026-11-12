// d3-force-3d ships no types. This declares the small part of it the 3D graph
// layout uses (components/Graph3DLayout.ts).

declare module "d3-force-3d" {
  export type SimNode = {
    index?: number;
    x: number;
    y: number;
    z: number;
    vx?: number;
    vy?: number;
    vz?: number;
  };

  export interface Force<T extends SimNode> {
    (alpha: number): void;
    initialize?: (nodes: T[], ...rest: unknown[]) => void;
  }

  export interface Simulation<T extends SimNode> {
    tick(iterations?: number): this;
    stop(): this;
    alpha(): number;
    alpha(value: number): this;
    alphaMin(value: number): this;
    alphaDecay(value: number): this;
    velocityDecay(value: number): this;
    force(name: string, force: Force<T> | null): this;
    nodes(): T[];
  }

  export function forceSimulation<T extends SimNode>(nodes: T[], dimensions?: 1 | 2 | 3): Simulation<T>;

  export interface ManyBody<T extends SimNode> extends Force<T> {
    strength(value: number | ((node: T) => number)): this;
    theta(value: number): this;
    distanceMax(value: number): this;
  }
  export function forceManyBody<T extends SimNode>(): ManyBody<T>;

  export interface Collide<T extends SimNode> extends Force<T> {
    radius(value: number | ((node: T) => number)): this;
    strength(value: number): this;
    iterations(value: number): this;
  }
  export function forceCollide<T extends SimNode>(radius?: number | ((node: T) => number)): Collide<T>;

  export interface LinkForce<T extends SimNode, E> extends Force<T> {
    distance(value: number | ((link: E) => number)): this;
    strength(value: number | ((link: E) => number)): this;
    iterations(value: number): this;
  }
  export function forceLink<T extends SimNode, E extends { source: T; target: T }>(links?: E[]): LinkForce<T, E>;
}
