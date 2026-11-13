"use client";

import { useEffect, useRef } from "react";
import type { Graph } from "@/lib/api";
import { day, money, plural, truncate } from "@/lib/format";
import { BEND, CAPTION_RISE, EDGE_ALPHA_MIN, layoutGraph, type N, type Scene } from "@/lib/graphLayout";
import { readPalette } from "@/lib/paint";
import { useStore } from "@/lib/store";
import { NO_API, type GraphViewProps } from "./GraphView";
import { drawMark, haloText, mix, type MarkLook } from "./graphFlatDraw";
import { fitPad, readChrome, roomFor, type Chrome } from "./graphRoom";

// The flat view of the graph, drawn on one canvas. Companies gather in
// category clusters, sized by the dollars they were awarded; agencies and
// offices are rings among them, sized by the dollars they paid out; every
// award between one agency and one company is one curved edge in the accent
// (the one color, and it means dollars awarded), its weight and strength
// following the money. The edges that carry no money are faint dotted curves
// in the text color. How each kind of node looks is decided in
// graphFlatDraw.ts, one function per kind; this file decides where things go.
//
// The layout is computed once (lib/graphLayout.ts) and never moves on its own.
// Nothing here animates by itself: the canvas redraws only while the reader
// pans, zooms or drags, or while a short camera move or fade answers a click.
// The camera is smooth: inertial panning, zoom toward the cursor, eased moves
// when focusing. Rendering culls to the viewport and strokes edges in a few
// batches by strength and width, so large graphs stay fluid.
//
// Few names are written: the seven companies with the most money and every
// agency. Each name tries eight places around its mark and takes the first
// that overlaps no other mark, name or caption; a name with no room, and every
// other node's, appears on hover.
//
// What is shown is decided outside (GraphExplorer.tsx): this view is handed the
// graph, the ids the filters hide, the selection and the search text, and
// shares them with the 3D view.

type View = { k: number; tx: number; ty: number };
type Spring = { n: N; ox: number; oy: number; tx: number; ty: number; vx: number; vy: number };

const MAX_K = 3.5;
const MIN_R = 2; // the smallest a mark is drawn, in CSS pixels
const MOVE_S = 0.4; // seconds a camera move takes

// The room the map is fitted into (48px from the canvas edges and from every
// piece of chrome, 24px on a phone) is worked out in graphRoom.ts, shared with
// the 3D view.

// Focus. A selected node lights itself and its neighbors and dims the rest of
// the map fully; hovering previews the same, about halfway; a search dims what
// does not match.
const HOVER_DIM = 0.55;
const SEARCH_DIM = 0.85;

// Edges. At rest an award edge has its own strength and width (the layout's
// `alpha` and `width`); the money edges of the node in focus rise to 85% at
// 1.25x width, its dotted edges keep their 14% (as in the 3D view), and every
// other edge drops to 3%.
const FOCUS_EDGE_ALPHA = 0.85;
const FOCUS_EDGE_WIDTH = 1.25;
const FADED_EDGE_ALPHA = 0.03;
const DOTS = [1.5, 3]; // the dotted line of an edge that is not an award
/** Edges are batched by strength and width in steps this fine. */
const ALPHA_STEP = 0.01;
const WIDTH_STEP = 0.2;

// Names: companies in the display serif, agencies and offices in the
// interface face, category captions in the reading serif's italic, quieter.
const NAME_PX = 16;
const ORG_PX = 11.5;
const CAPTION_PX = 13.5;
const NAMED_COMPANIES = 7;
/** a name's opacity at rest and fully dimmed */
const NAME_ALPHA = [1, 0.22];
const ORG_NAME_ALPHA = [0.85, 0.17];
const CAPTION_ALPHA = [0.55, 0.25];

const EMPTY: Scene = {
  nodes: [],
  links: [],
  regions: [],
  near: new Map(),
  byId: new Map(),
  bounds: { x0: 0, y0: 0, x1: 1, y1: 1 },
};

/** Layouts already computed, so switching between the two views is instant. */
const laidOut = new WeakMap<Graph, Scene>();

/** The eight places a name can go around its mark, in the order they are
 *  tried: right, left, above, below, then the diagonals. An agency's name
 *  tries under its ring first, where every hub's name sits in the mockups,
 *  then right, left and above: a deliberate change to the spec's order,
 *  shared with the 3D view (Graph3DStage.ts). Each is the
 *  text's anchor, its alignment and its baseline. `r` is the mark's drawn
 *  radius, `org` picks the agency metrics (the interface face is smaller). */
function spots(x: number, y: number, r: number, org: boolean): [number, number, CanvasTextAlign][] {
  const g = org ? 6 : 7; // the gap between a mark and a name beside it
  const mid = org ? 4 : 5; // baseline offset that centers a name on the mark
  const up = org ? 6 : 7;
  const down = org ? 14 : 16;
  const d = r * 0.7;
  const right: [number, number, CanvasTextAlign] = [x + r + g, y + mid, "left"];
  const left: [number, number, CanvasTextAlign] = [x - r - g, y + mid, "right"];
  const above: [number, number, CanvasTextAlign] = [x, y - r - up, "center"];
  const below: [number, number, CanvasTextAlign] = [x, y + r + down, "center"];
  const diagonals: [number, number, CanvasTextAlign][] = [
    [x + d + g - 2, y - d - 4, "left"],
    [x - d - g + 2, y - d - 4, "right"],
    [x + d + g - 2, y + d + down - 2, "left"],
    [x - d - g + 2, y + d + down - 2, "right"],
  ];
  return org ? [below, right, left, above, ...diagonals] : [right, left, above, below, ...diagonals];
}

export function GraphFlat({ graph, hidden, tags, selected, query, ready, api, onSelect, onReady }: GraphViewProps) {
  const { motion } = useStore();

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const scene = useRef<Scene>(EMPTY);
  const ui = useRef({ selected, hidden, tags, query, hover: null as string | null, motion });
  const inner = useRef({
    invalidate: () => {},
    fit: (_animate: boolean) => {},
    refilter: () => {},
    settle: () => {},
  });
  const out = useRef({ onSelect, onReady });

  ui.current.selected = selected;
  ui.current.hidden = hidden;
  ui.current.tags = tags;
  ui.current.query = query;
  ui.current.motion = motion;
  out.current = { onSelect, onReady };

  // Canvas
  useEffect(() => {
    const wrap = wrapRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const tip = tipRef.current!;
    // the rail and the panel live in the explorer around this view
    const host = wrap.closest<HTMLElement>("[data-graph-root]") ?? wrap;
    let palette = readPalette();
    let fonts = {
      name: `400 ${NAME_PX}px serif`,
      org: `400 ${ORG_PX}px sans-serif`,
      caption: `italic 400 ${CAPTION_PX}px serif`,
    };
    /** measured name widths by node id, and caption widths by category, in
     *  the current fonts */
    const widths = new Map<string, number>();
    const captionWidths = new Map<string, number>();
    let W = 0;
    let H = 0;
    let dpr = 1;
    let raf = 0;
    let last = 0;
    let alive = true;

    // Camera: `view` is what is drawn, `goal` is where it is heading.
    let view: View = { k: 1, tx: 0, ty: 0 };
    let goal: View = { ...view };
    let tween: { from: View; to: View; t: number } | null = null;
    let fitK = 1;
    const vel = { x: 0, y: 0 };
    /** false until the reader moves the camera: until then the graph refits
     *  itself when the chrome around it or the window changes */
    let touched = false;
    /** the node the last focus was for, until the reader moves the camera:
     *  once the side card has landed and been measured, the focus is checked
     *  again against where it really is */
    let focused: string | null = null;

    let hidden: ReadonlySet<string> = ui.current.hidden;
    let live = new Set<string>(); // categories that still have a member on the map
    let named = new Set<string>(); // the companies whose names are always written
    let matches: Set<string> | null = null;
    let dim = 0; // 0..1: how far the nodes out of focus have faded
    let fading: string | null = null; // the last node in focus, kept while its fade runs out
    let springs: Spring[] = [];
    let obstacles: number[] = [];
    let chrome: Chrome[] = [];
    let pointer: null | {
      node: N | null;
      sx: number;
      sy: number;
      ox: number;
      oy: number;
      lx: number;
      ly: number;
      lt: number;
      moved: boolean;
    } = null;

    /** Rail, panel, takeaway, controls and top bar, in canvas pixels: names
     *  are never written under them, and the fit keeps the graph clear of them. */
    const measure = () => {
      chrome = readChrome(host, canvas);
      obstacles = [];
      for (const c of chrome) obstacles.push(c.x0 - 6, c.y0 - 6, c.x1 + 6, c.y1 + 6);
    };

    /** The part of the canvas the graph is fitted into (graphRoom.ts). The
     *  side card counts while something is selected. */
    const room = (card = !!ui.current.selected) => roomFor(chrome, W, H, card);

    const clamp = (v: View): View => {
      const b = scene.current.bounds;
      const k = Math.max(fitK * 0.5, Math.min(MAX_K, v.k));
      const pad = Math.min(160, W / 3);
      return {
        k,
        tx: Math.max(pad - b.x1 * k, Math.min(W - pad - b.x0 * k, v.tx)),
        ty: Math.max(pad - b.y1 * k, Math.min(H - pad - b.y0 * k, v.ty)),
      };
    };

    const sx = (n: { x: number }) => n.x * view.k + view.tx;
    const sy = (n: { y: number }) => n.y * view.k + view.ty;
    /** Marks grow with zoom, but more slowly than the space between them. */
    const zsAt = (k: number) => Math.min(Math.pow(k, 0.7), k * 1.45);
    const zs = () => zsAt(view.k);

    /** A node's drawn radius in CSS pixels. */
    const rad = (n: N, z: number) => Math.max(MIN_R, n.r * z);

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (!w || !h) return;
      // Keep the same world point at the center, so a resize never jumps or stretches.
      if (W && H) {
        view.tx += (w - W) / 2;
        view.ty += (h - H) / 2;
        goal.tx += (w - W) / 2;
        goal.ty += (h - H) / 2;
      }
      W = w;
      H = h;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      measure();
    };

    /** A name's width in its font, as label() writes it at rest. */
    const nameWidth = (n: N) => {
      let w = widths.get(n.id);
      if (w === undefined) {
        ctx.font = n.kind !== "company" ? fonts.org : fonts.name;
        w = ctx.measureText(truncate(n.display, 34)).width;
        widths.set(n.id, w);
      }
      return w;
    };
    const captionWidth = (tag: string, label: string) => {
      let w = captionWidths.get(tag);
      if (w === undefined) {
        ctx.font = fonts.caption;
        w = ctx.measureText(label).width;
        captionWidths.set(tag, w);
      }
      return w;
    };
    const captioned = (tag: string) => live.has(tag) && (!ui.current.tags.size || ui.current.tags.has(tag));

    /** The screen box, relative to the camera's offset, of everything the fit
     *  must keep in the room at scale k: every shown mark at the size it is
     *  drawn, every caption, and every name written at rest in the place it
     *  tries first. Names and captions keep their size at any zoom and marks
     *  shrink more slowly than the map, so this is worked out per scale. */
    const span = (k: number) => {
      const { nodes, regions } = scene.current;
      const z = zsAt(k);
      const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      const add = (x0: number, y0: number, x1: number, y1: number) => {
        if (x0 < box.x0) box.x0 = x0;
        if (y0 < box.y0) box.y0 = y0;
        if (x1 > box.x1) box.x1 = x1;
        if (y1 > box.y1) box.y1 = y1;
      };
      const all = nodes.every((n) => hidden.has(n.id));
      for (const n of nodes) {
        if (!all && hidden.has(n.id)) continue;
        const x = n.x * k, y = n.y * k, r = rad(n, z);
        add(x - r, y - r, x + r, y + r);
        if (!n.org && !named.has(n.id)) continue;
        // the boxes label() measures for the first spot of spots()
        const w = nameWidth(n);
        if (n.org) add(x - w / 2 - 2, y + r + 14 - 9, x + w / 2 + 2, y + r + 14 + 3);
        else add(x + r + 7, y + 5 - 12, x + r + 7 + w + 2, y + 5 + 4);
      }
      for (const g of regions) {
        if (!captioned(g.tag)) continue;
        const half = captionWidth(g.tag, g.label) / 2 + 2;
        let top = Infinity;
        for (const n of g.core) if (!hidden.has(n.id)) top = Math.min(top, n.y * k - rad(n, z));
        if (top === Infinity) continue;
        add(g.x * k - half, top - CAPTION_RISE - 11, g.x * k + half, top);
      }
      return box;
    };

    /** Where the camera goes to fit the map: the largest scale (up to 1.5) at
     *  which span() fits the room, found by halving, and the offset that
     *  centers it there. */
    const fitTarget = (): View => {
      const p = room();
      const aw = Math.max(40, W - p.l - p.r);
      const ah = Math.max(40, H - p.t - p.b);
      const fits = (k: number) => {
        const b = span(k);
        return b.x1 - b.x0 <= aw && b.y1 - b.y0 <= ah;
      };
      let k = 1.5;
      if (!fits(k)) {
        let lo = 0.01;
        let hi = 1.5;
        for (let i = 0; i < 26; i++) {
          const mid = (lo + hi) / 2;
          if (fits(mid)) lo = mid;
          else hi = mid;
        }
        k = lo;
      }
      const b = span(k);
      return {
        k,
        tx: p.l + aw / 2 - (b.x0 + b.x1) / 2,
        ty: p.t + ah / 2 - (b.y0 + b.y1) / 2,
      };
    };

    const moveTo = (to: View, animate: boolean) => {
      vel.x = vel.y = 0;
      to = clamp(to);
      if (animate && ui.current.motion) tween = { from: { ...view }, to, t: 0 };
      else {
        tween = null;
        view = { ...to };
      }
      goal = { ...to };
      invalidate();
    };

    const fit = (animate: boolean) => {
      if (!scene.current.nodes.length || !W) return;
      measure();
      const t = fitTarget();
      fitK = t.k;
      touched = false;
      focused = null;
      moveTo(t, animate);
    };

    /** Where the camera must go so that a node and its shown neighbors sit in
     *  the room (allowed half of its padding, as the mockup's selection sits
     *  close to the card), moving as little as it can: at the scale it has
     *  (never zooming in), panned only as far as needed; zoomed out only if
     *  the neighborhood does not fit at that scale, and then centered. Null
     *  when everything is already in place. */
    const focusTarget = (id: string): View | null => {
      const n = scene.current.byId.get(id);
      if (!n) return null;
      const p = room(true);
      const open = room(false);
      // half the padding may go, except along the card
      const slack = fitPad(W) / 2;
      for (const side of ["l", "r", "t", "b"] as const) if (p[side] <= open[side]) p[side] -= slack;
      const aw = Math.max(40, W - p.l - p.r);
      const ah = Math.max(40, H - p.t - p.b);
      // the neighborhood in world pixels, and how far its marks reach beyond
      // it on screen (at the largest scale used); the node's name finds its
      // own place around it
      let x0 = n.x, x1 = n.x, y0 = n.y, y1 = n.y;
      let reachOut = 0;
      const z = zsAt(Math.max(goal.k, fitK));
      for (const o of scene.current.near.get(id) ?? []) {
        const q = scene.current.byId.get(o);
        if (!q || hidden.has(o)) continue;
        x0 = Math.min(x0, q.x);
        x1 = Math.max(x1, q.x);
        y0 = Math.min(y0, q.y);
        y1 = Math.max(y1, q.y);
        reachOut = Math.max(reachOut, rad(q, z));
      }
      const m = Math.max(reachOut, rad(n, z)) + 8;
      const fitsAt = (k: number) => (x1 - x0) * k + 2 * m <= aw && (y1 - y0) * k + 2 * m <= ah;
      let k = Math.max(goal.k, fitK * 0.5);
      if (!fitsAt(k)) {
        let lo = fitK * 0.5;
        let hi = k;
        for (let i = 0; i < 20; i++) {
          const mid = (lo + hi) / 2;
          if (fitsAt(mid)) lo = mid;
          else hi = mid;
        }
        k = lo;
        if (!fitsAt(k)) {
          // too wide to see whole: the node itself in the middle of the room
          return { k, tx: p.l + aw / 2 - n.x * k, ty: p.t + ah / 2 - n.y * k };
        }
      }
      // the neighborhood's screen box at this scale, about the current offset
      const tx = k === goal.k ? goal.tx : goal.tx + (W / 2 - goal.tx) * (1 - k / goal.k);
      const ty = k === goal.k ? goal.ty : goal.ty + (H / 2 - goal.ty) * (1 - k / goal.k);
      const bx0 = x0 * k + tx - m, bx1 = x1 * k + tx + m;
      const by0 = y0 * k + ty - m, by1 = y1 * k + ty + m;
      // the least pan that brings it inside the room
      const shove = (lo: number, hi: number, from: number, to: number) =>
        lo < from ? from - lo : hi > to ? Math.max(to - hi, from - lo) : 0;
      const dx = shove(bx0, bx1, p.l, W - p.r);
      const dy = shove(by0, by1, p.t, H - p.b);
      if (k === goal.k && Math.abs(dx) < 1 && Math.abs(dy) < 1) return null;
      return { k, tx: tx + dx, ty: ty + dy };
    };

    /** Bring a node and its neighborhood into view, clear of the side card,
     *  with the least camera move (focusTarget). */
    const focusOn = (id: string) => {
      if (!scene.current.byId.has(id) || !W) return;
      measure();
      focused = id;
      const to = focusTarget(id);
      if (!to) return invalidate();
      touched = true;
      tip.style.opacity = "0"; // the camera is about to move out from under it
      moveTo(to, true);
    };

    /** For when the chrome around the map has settled or changed: measure it
     *  again, then check the last focus against the side card as it really
     *  is, or fit again if the reader has not moved the camera since the last
     *  fit. A selection made without moving the camera leaves the fit as it
     *  is: the card was already allowed for when the node was picked, and
     *  refitting around it would shift the map under the reader. */
    const settle = () => {
      measure();
      if (!scene.current.nodes.length || !W) return invalidate();
      const selected = ui.current.selected;
      if (focused && focused === selected) return focusOn(focused);
      if (touched || selected) return invalidate();
      const t = fitTarget();
      if (Math.abs(t.k - goal.k) < 0.002 * goal.k && Math.abs(t.tx - goal.tx) < 1 && Math.abs(t.ty - goal.ty) < 1)
        return invalidate();
      fit(true);
    };

    const zoomAt = (f: number, px = W / 2, py = H / 2) => {
      tween = null;
      vel.x = vel.y = 0;
      touched = true;
      focused = null;
      const k = Math.max(fitK * 0.5, Math.min(MAX_K, goal.k * f));
      goal = clamp({ k, tx: px - ((px - goal.tx) / goal.k) * k, ty: py - ((py - goal.ty) / goal.k) * k });
      invalidate();
    };

    const refilter = () => {
      const { nodes } = scene.current;
      hidden = ui.current.hidden;
      live = new Set();
      named = new Set();
      // nodes are sorted by money, so the first companies shown are the biggest
      for (const n of nodes) {
        if (n.org || hidden.has(n.id)) continue;
        if (n.tag) live.add(n.tag);
        if (n.kind === "company" && named.size < NAMED_COMPANIES) named.add(n.id);
      }
      const q = ui.current.query;
      matches = q ? new Set(nodes.filter((n) => n.nameLower.includes(q)).map((n) => n.id)) : null;
      // the side card comes or goes with the selection: measure once it has
      // mounted, and settle once it has landed (or a closing card has faded
      // out), which checks a focus against the card's real size
      setTimeout(measure, 60);
      setTimeout(() => alive && settle(), 260);
      invalidate();
    };

    /** Tell the explorer, and know it here at once: the next frame is already drawing. */
    const select = (id: string | null) => {
      ui.current.selected = id;
      out.current.onSelect(id);
    };

    const nodeAt = (px: number, py: number): N | null => {
      const z = zs();
      let best: N | null = null;
      let bd = Infinity;
      for (const n of scene.current.nodes) {
        if (hidden.has(n.id)) continue;
        const d = Math.hypot(sx(n) - px, sy(n) - py) - Math.max(3, n.r * z);
        if (d < 6 && d < bd) {
          bd = d;
          best = n;
        }
      }
      return best;
    };

    /** How strongly the map is focused right now, before easing: a selection
     *  fully, a hover partway, a search mostly. */
    const focusWant = () =>
      ui.current.selected ? 1 : ui.current.hover ? HOVER_DIM : matches ? SEARCH_DIM : 0;

    /** Advance camera, springs and fades. Returns true while anything is still moving. */
    const update = (dt: number): boolean => {
      let moving = false;
      if (tween) {
        tween.t = Math.min(1, tween.t + dt / MOVE_S);
        const e = 1 - Math.pow(1 - tween.t, 3);
        const { from, to } = tween;
        view = {
          k: from.k + (to.k - from.k) * e,
          tx: from.tx + (to.tx - from.tx) * e,
          ty: from.ty + (to.ty - from.ty) * e,
        };
        if (tween.t >= 1) tween = null;
        moving = true;
      } else {
        if (!pointer && (Math.abs(vel.x) > 6 || Math.abs(vel.y) > 6)) {
          // inertia: the pan eases to a stop
          goal = clamp({ k: goal.k, tx: goal.tx + vel.x * dt, ty: goal.ty + vel.y * dt });
          const decay = Math.exp(-dt * 4.2);
          vel.x *= decay;
          vel.y *= decay;
          moving = true;
        }
        const a = 1 - Math.exp(-dt * 16);
        const dk = goal.k - view.k;
        const dx = goal.tx - view.tx;
        const dy = goal.ty - view.ty;
        if (Math.abs(dk) > 0.0005 || Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2) {
          view = { k: view.k + dk * a, tx: view.tx + dx * a, ty: view.ty + dy * a };
          moving = true;
        } else view = { ...goal };
      }

      // Soft springs: neighbors of a dragged node follow it, then settle.
      if (springs.length) {
        let energy = 0;
        const sub = Math.min(dt, 0.033);
        for (const s of springs) {
          const ax = (s.tx - s.n.x) * 70 - s.vx * 13;
          const ay = (s.ty - s.n.y) * 70 - s.vy * 13;
          s.vx += ax * sub;
          s.vy += ay * sub;
          s.n.x += s.vx * sub;
          s.n.y += s.vy * sub;
          energy += Math.abs(s.vx) + Math.abs(s.vy) + Math.abs(s.tx - s.n.x) + Math.abs(s.ty - s.n.y);
        }
        if (!pointer?.node && energy < 0.4 * springs.length) {
          for (const s of springs) {
            s.n.x = s.tx;
            s.n.y = s.ty;
          }
          springs = [];
        }
        moving = true;
      }

      const want = focusWant();
      if (Math.abs(want - dim) > 0.004) {
        dim += (want - dim) * (1 - Math.exp(-dt * 11));
        moving = true;
      } else dim = want;
      return moving;
    };

    // Reused per frame, so drawing thousands of edges and nodes allocates
    // almost nothing. Edges are batched by key: lit or not, strength, width.
    const batches = new Map<number, number[]>();
    const keys: number[] = [];
    // marks in drawing order: faded before lit, companies under solicitations
    // under agencies, and within a kind the least money first, as the mockups
    // draw them (the hairline around each dot keeps a small one visible on a
    // big one)
    const marks: N[][] = Array.from({ length: 6 }, () => []);
    const vis: N[] = [];
    // A coarse grid over the screen holding the marks in view, so a name can
    // ask which marks are near it without looking at all of them.
    const CELL = 64;
    const grid = new Map<number, N[]>();
    let reach = 0; // the largest drawn radius in view, plus clearance
    const placed: number[] = [];
    const look: MarkLook = { palette, fade: 0, selected: false, hover: false };

    /** True if the box is on screen, clear of the chrome and of every name
     *  and caption placed so far. */
    const clear = (x0: number, y0: number, x1: number, y1: number) => {
      // names keep a margin from the edge of the view
      if (x0 < 8 || y0 < 8 || x1 > W - 8 || y1 > H - 8) return false;
      for (let i = 0; i < obstacles.length; i += 4)
        if (x0 < obstacles[i + 2] && x1 > obstacles[i] && y0 < obstacles[i + 3] && y1 > obstacles[i + 1]) return false;
      for (let i = 0; i < placed.length; i += 4)
        if (x0 < placed[i + 2] && x1 > placed[i] && y0 < placed[i + 3] && y1 > placed[i + 1]) return false;
      return true;
    };
    /** As clear(), and clear of every mark in view but `self`'s. */
    const free = (x0: number, y0: number, x1: number, y1: number, self: N, z: number) => {
      if (!clear(x0, y0, x1, y1)) return false;
      // a mark is filed under the cell of its center: look as far out as the biggest one reaches
      const c0 = Math.floor((x0 - reach) / CELL), c1 = Math.floor((x1 + reach) / CELL);
      const r0 = Math.floor((y0 - reach) / CELL), r1 = Math.floor((y1 + reach) / CELL);
      for (let cx = c0; cx <= c1; cx++)
        for (let cy = r0; cy <= r1; cy++) {
          const cell = grid.get(cx * 4096 + cy);
          if (!cell) continue;
          for (const n of cell) {
            if (n === self) continue;
            // the box against the mark's circle, with a hair of clearance
            const x = sx(n), y = sy(n), r = rad(n, z) + 1.5;
            const dx = x - Math.max(x0, Math.min(x, x1));
            const dy = y - Math.max(y0, Math.min(y, y1));
            if (dx * dx + dy * dy < r * r) return false;
          }
        }
      return true;
    };

    const draw = () => {
      const { nodes, links, near, byId, regions } = scene.current;
      const z = zs();
      const { selected, hover } = ui.current;
      // The node whose neighborhood is lit: the selection, else the hover,
      // else the last one, while its fade runs out.
      let fid = selected ?? hover;
      if (fid) fading = fid;
      else if (dim > 0.01 && !matches) fid = fading;
      const around = fid ? near.get(fid) : null;
      const lit = (n: N) => (fid ? n.id === fid || !!around?.has(n.id) : matches ? matches.has(n.id) : true);
      look.palette = palette;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // 1. Edges, as quadratic curves bowed 12% of their length, culled to the
      //    view and batched by strength and width.
      for (const list of batches.values()) list.length = 0;
      let onScreen = 0;
      for (let i = 0; i < links.length; i++) {
        const l = links[i];
        if (hidden.has(l.source.id) || hidden.has(l.target.id)) continue;
        const x1 = sx(l.source), y1 = sy(l.source), x2 = sx(l.target), y2 = sy(l.target);
        // the curve stays within its chord's box widened by the bow
        const m = (Math.abs(x2 - x1) + Math.abs(y2 - y1)) * 0.07;
        if (Math.max(x1, x2) + m < 0 || Math.min(x1, x2) - m > W || Math.max(y1, y2) + m < 0 || Math.min(y1, y2) - m > H)
          continue;
        onScreen++;
      }
      // A great many edges in view are drawn fainter, so they read as a haze, not a tangle.
      const crowd = fid ? 1 : Math.min(1, Math.sqrt(1500 / Math.max(onScreen, 1)));
      for (let i = 0; i < links.length; i++) {
        const l = links[i];
        if (hidden.has(l.source.id) || hidden.has(l.target.id)) continue;
        const x1 = sx(l.source), y1 = sy(l.source), x2 = sx(l.target), y2 = sy(l.target);
        const m = (Math.abs(x2 - x1) + Math.abs(y2 - y1)) * 0.07;
        if (Math.max(x1, x2) + m < 0 || Math.min(x1, x2) - m > W || Math.max(y1, y2) + m < 0 || Math.min(y1, y2) - m > H)
          continue;
        const on = fid
          ? l.source.id === fid || l.target.id === fid
          : matches
            ? matches.has(l.source.id) || matches.has(l.target.id)
            : true;
        const award = l.kind === "award";
        // the crowd fades an award edge no further than the faintest the
        // money scale draws (0.07)
        const rest = award ? Math.max(EDGE_ALPHA_MIN, l.alpha * crowd) : l.alpha * crowd;
        let alpha: number;
        let width = award ? l.width * z : 0.7;
        if (fid && on) {
          // the focused node's money edges rise; its dotted ones stay as they are
          alpha = award ? mix(rest, FOCUS_EDGE_ALPHA, dim) : rest;
          if (award) width *= mix(1, FOCUS_EDGE_WIDTH, dim);
        } else alpha = on ? rest : mix(rest, FADED_EDGE_ALPHA, dim);
        if (alpha < 0.004) continue;
        // key: lit edges after faded ones, then quiet before award, then strength and width
        const key =
          (on ? 1 << 22 : 0) +
          (award ? 1 << 21 : 0) +
          (Math.round(alpha / ALPHA_STEP) << 10) +
          Math.min(1023, Math.round(Math.max(0.5, width) / WIDTH_STEP));
        let list = batches.get(key);
        if (!list) batches.set(key, (list = []));
        list.push(i);
      }
      // With a great many edges in view, the dotted ones are drawn solid: a
      // dash pattern on thousands of short curves costs more than it shows.
      const plain = onScreen > 1400;
      // keys come and go with every zoom step and fade, so an empty batch is
      // dropped rather than kept for a key that may never come back
      keys.length = 0;
      for (const [key, list] of batches) {
        if (list.length) keys.push(key);
        else batches.delete(key);
      }
      keys.sort((a, b) => a - b);
      ctx.lineCap = "round";
      for (const key of keys) {
        const award = (key & (1 << 21)) !== 0;
        ctx.globalAlpha = ((key >> 10) & 2047) * ALPHA_STEP;
        ctx.lineWidth = (key & 1023) * WIDTH_STEP;
        ctx.strokeStyle = award ? palette.accent : palette.text;
        ctx.setLineDash(award || plain ? [] : DOTS);
        ctx.beginPath();
        for (const i of batches.get(key)!) {
          // curveEnds() and bendPoint() of graphLayout.ts, inlined so the
          // loop allocates nothing: an award runs from the company to the
          // agency, and bows BEND of its length to the left
          const l = links[i];
          const a = l.kind === "award" ? l.target : l.source;
          const b = l.kind === "award" ? l.source : l.target;
          const x0 = sx(a), y0 = sy(a), x1 = sx(b), y1 = sy(b);
          ctx.moveTo(x0, y0);
          ctx.quadraticCurveTo((x0 + x1) / 2 - (y1 - y0) * BEND, (y0 + y1) / 2 + (x1 - x0) * BEND, x1, y1);
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // 2. Marks, each through its kind's function (graphFlatDraw.ts).
      for (const list of marks) list.length = 0;
      vis.length = 0;
      reach = 0;
      for (const cell of grid.values()) cell.length = 0;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (hidden.has(n.id)) continue;
        const x = sx(n), y = sy(n), m = rad(n, z) + 6;
        if (x + m < 0 || x - m > W || y + m < 0 || y - m > H) continue;
        vis.push(n);
        reach = Math.max(reach, m);
        const key = Math.floor(x / CELL) * 4096 + Math.floor(y / CELL);
        let cell = grid.get(key);
        if (!cell) grid.set(key, (cell = []));
        cell.push(n);
        if (n.id === selected || n.id === hover) continue; // drawn last, on top
        const kind = n.kind === "company" ? 0 : n.kind === "opportunity" ? 1 : 2;
        marks[(lit(n) ? 3 : 0) + kind].push(n);
      }
      for (let g = 0; g < marks.length; g++) {
        look.fade = g < 3 ? dim : 0;
        look.selected = look.hover = false;
        for (const n of marks[g]) drawMark(ctx, n, sx(n), sy(n), rad(n, z), look);
      }
      for (const id of hover === selected ? [selected] : [hover, selected]) {
        const n = id ? byId.get(id) : null;
        if (!n || hidden.has(n.id)) continue;
        look.fade = lit(n) ? 0 : dim;
        look.selected = id === selected;
        look.hover = id === hover && !look.selected;
        drawMark(ctx, n, sx(n), sy(n), rad(n, z), look);
      }
      ctx.globalAlpha = 1;

      // 3. Captions: every category with a member on the map, centered over
      //    the top of its cluster as its marks are drawn (below zoom 1 a mark
      //    is drawn larger than the map's scale). They go first, and names
      //    keep clear of them. Over a mark is fine (the halo parts them); over
      //    another caption or the chrome is not, so a caption with no room
      //    there tries a line higher, then under its cluster, then two lines
      //    higher, before it is left out.
      placed.length = 0;
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "center";
      ctx.font = fonts.caption;
      const capAlpha = mix(CAPTION_ALPHA[0], CAPTION_ALPHA[1], fid || matches ? dim : 0);
      for (const g of regions) {
        if (!captioned(g.tag)) continue;
        let top = Infinity;
        let bottom = -Infinity;
        for (const n of g.core) {
          if (hidden.has(n.id)) continue;
          const y = sy(n), r = rad(n, z);
          if (y - r < top) top = y - r;
          if (y + r > bottom) bottom = y + r;
        }
        if (top === Infinity) continue;
        const w = captionWidth(g.tag, g.label);
        const x = sx(g);
        const line = CAPTION_PX + 2;
        const base = top - CAPTION_RISE;
        const y = [base, base - line, bottom + CAPTION_RISE + 11, base - 2 * line].find((y) =>
          clear(x - w / 2 - 2, y - 11, x + w / 2 + 2, y + 4),
        );
        if (y === undefined) continue;
        placed.push(x - w / 2 - 2, y - 11, x + w / 2 + 2, y + 4);
        haloText(ctx, g.label, x, y, palette.text, capAlpha, palette);
      }

      // 4. Names: the hovered and selected nodes first (written even with no
      //    free place), then every agency and the seven biggest companies by
      //    money, each at the first of its eight places that is free. A name
      //    stays inside the fitted room, give or take half its padding, so
      //    none runs up against the rail or the edge of the window.
      const lim = room(false);
      const slack = fitPad(W) / 2;
      const lx0 = lim.l - slack, lx1 = W - lim.r + slack;
      const ly0 = lim.t - slack, ly1 = H - lim.b + slack;
      const label = (n: N, forced: boolean) => {
        const org = n.kind !== "company";
        const text = truncate(n.display, forced ? 60 : 34);
        let w = nameWidth(n);
        ctx.font = org ? fonts.org : fonts.name;
        if (forced) w = ctx.measureText(text).width;
        const x = sx(n), y = sy(n), r = rad(n, z);
        // the box around a name's ink, from its baseline
        const asc = org ? 9 : 12;
        const desc = org ? 3 : 4;
        const options = spots(x, y, r, org);
        let spot = options.find(([ax, ay, align]) => {
          const x0 = align === "left" ? ax : align === "right" ? ax - w : ax - w / 2;
          if (x0 < lx0 || x0 + w > lx1 || ay - asc < ly0 || ay + desc > ly1) return false;
          return free(x0 - 2, ay - asc, x0 + w + 2, ay + desc, n, z);
        });
        if (!spot) {
          if (!forced) return;
          spot = options[0];
        }
        const [ax, ay, align] = spot;
        const x0 = align === "left" ? ax : align === "right" ? ax - w : ax - w / 2;
        placed.push(x0 - 2, ay - asc, x0 + w + 2, ay + desc);
        const [rest, faded] = org ? ORG_NAME_ALPHA : NAME_ALPHA;
        const alpha = forced ? 1 : lit(n) ? rest : mix(rest, faded, dim);
        ctx.textAlign = align;
        haloText(ctx, text, ax, ay, palette.text, alpha, palette);
      };
      for (const id of hover === selected ? [selected] : [hover, selected]) {
        const n = id ? byId.get(id) : null;
        if (n && !hidden.has(n.id)) label(n, true);
      }
      // vis runs from the least money to the most; names go the other way
      for (let i = vis.length - 1; i >= 0; i--) {
        const n = vis[i];
        if (n.id === hover || n.id === selected) continue;
        if (n.org || named.has(n.id)) label(n, false);
      }
      ctx.globalAlpha = 1;
    };

    const frame = (now: number) => {
      raf = 0;
      if (!alive) return;
      const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
      last = now;
      const moving = update(dt);
      draw();
      // Nothing moves by itself: the loop runs only while something is settling.
      if (moving && !document.hidden) raf = requestAnimationFrame(frame);
    };
    const invalidate = () => {
      if (!raf && alive) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };

    const local = (e: PointerEvent | WheelEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const setHover = (n: N | null, x = 0, y = 0) => {
      const id = n?.id ?? null;
      canvas.style.cursor = n ? "pointer" : pointer ? "grabbing" : "grab";
      if (n) {
        tip.textContent =
          n.kind === "opportunity"
            ? `${n.open ? "Open" : "Closed"} solicitation · posted ${day(n.posted, true)}`
            : `${money(n.total)} · ${plural(n.awards, "award")}`;
        tip.style.transform = `translate(${Math.min(x + 16, W - 240)}px, ${Math.max(8, y - 34)}px)`;
      }
      tip.style.opacity = n ? "1" : "0";
      if (ui.current.hover !== id) {
        ui.current.hover = id;
        invalidate();
      }
    };

    const onDown = (e: PointerEvent) => {
      const p = local(e);
      const n = nodeAt(p.x, p.y);
      canvas.setPointerCapture(e.pointerId);
      tween = null;
      vel.x = vel.y = 0;
      goal = { ...view };
      pointer = {
        node: n,
        sx: p.x,
        sy: p.y,
        ox: n ? n.x : view.tx,
        oy: n ? n.y : view.ty,
        lx: p.x,
        ly: p.y,
        lt: performance.now(),
        moved: false,
      };
      if (n) {
        // Direct neighbors will be pulled along on soft springs.
        springs = springs.filter((s) => s.n !== n);
        const held = new Set(springs.map((s) => s.n));
        for (const id of scene.current.near.get(n.id) ?? []) {
          const q = scene.current.byId.get(id);
          if (!q || held.has(q) || hidden.has(id) || springs.length > 60) continue;
          springs.push({ n: q, ox: q.x, oy: q.y, tx: q.x, ty: q.y, vx: 0, vy: 0 });
        }
      }
      canvas.style.cursor = "grabbing";
    };
    const onMove = (e: PointerEvent) => {
      const p = local(e);
      if (!pointer) return setHover(nodeAt(p.x, p.y), p.x, p.y);
      if (Math.hypot(p.x - pointer.sx, p.y - pointer.sy) > 4) pointer.moved = true;
      if (!pointer.moved) return;
      const now = performance.now();
      if (pointer.node) {
        const n = pointer.node;
        n.x = pointer.ox + (p.x - pointer.sx) / view.k;
        n.y = pointer.oy + (p.y - pointer.sy) / view.k;
        const dx = n.x - pointer.ox;
        const dy = n.y - pointer.oy;
        const around = scene.current.near.get(n.id);
        for (const s of springs) {
          if (!around?.has(s.n.id)) continue;
          s.tx = s.ox + dx * 0.55;
          s.ty = s.oy + dy * 0.55;
        }
        tip.style.opacity = "0";
      } else {
        const dtm = Math.max(1, now - pointer.lt) / 1000;
        vel.x = vel.x * 0.5 + ((p.x - pointer.lx) / dtm) * 0.5;
        vel.y = vel.y * 0.5 + ((p.y - pointer.ly) / dtm) * 0.5;
        touched = true;
        focused = null;
        view = clamp({ k: view.k, tx: pointer.ox + (p.x - pointer.sx), ty: pointer.oy + (p.y - pointer.sy) });
        goal = { ...view };
      }
      pointer.lx = p.x;
      pointer.ly = p.y;
      pointer.lt = now;
      invalidate();
    };
    const onUp = () => {
      const p = pointer;
      pointer = null;
      canvas.style.cursor = "grab";
      if (!p) return;
      const n = p.node;
      if (n && !p.moved) {
        const next = ui.current.selected === n.id ? null : n.id;
        select(next);
        // the camera moves only if the node or its neighbors would be out of
        // view or under the side card, and then as little as it can
        if (next) focusOn(next);
      } else if (!n && !p.moved) select(null);
      else if (!n && performance.now() - p.lt > 90) vel.x = vel.y = 0; // held still before letting go
      invalidate();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0022)), p.x, p.y);
    };
    const onKey = (e: KeyboardEvent) => {
      const pan = (dx: number, dy: number) => {
        tween = null;
        touched = true;
        focused = null;
        goal = clamp({ k: goal.k, tx: goal.tx + dx, ty: goal.ty + dy });
        invalidate();
      };
      if (e.key === "ArrowLeft") pan(80, 0);
      else if (e.key === "ArrowRight") pan(-80, 0);
      else if (e.key === "ArrowUp") pan(0, 80);
      else if (e.key === "ArrowDown") pan(0, -80);
      else if (e.key === "+" || e.key === "=") zoomAt(1.35);
      else if (e.key === "-") zoomAt(1 / 1.35);
      else if (e.key === "0") fit(true);
      else if (e.key === "Escape") select(null);
      else return;
      e.preventDefault();
    };
    const onLeave = () => !pointer && setHover(null);
    const onTheme = () => {
      palette = readPalette();
      invalidate();
    };
    const readFonts = () => {
      const s = getComputedStyle(document.documentElement);
      const display = `${s.getPropertyValue("--font-cormorant").trim() || "Georgia"}, Georgia, serif`;
      const reading = `${s.getPropertyValue("--font-garamond").trim() || "Georgia"}, Georgia, serif`;
      const sans = `${s.getPropertyValue("--font-inter").trim() || "system-ui"}, system-ui, sans-serif`;
      fonts = {
        name: `400 ${NAME_PX}px ${display}`,
        org: `400 ${ORG_PX}px ${sans}`,
        caption: `italic 400 ${CAPTION_PX}px ${reading}`,
      };
      widths.clear();
      captionWidths.clear();
    };

    resize();
    readFonts();
    inner.current = { invalidate, fit, refilter, settle };
    const mine = {
      fit,
      // an arrival from a link (`fly`) is the same short move as a click
      focusOn: (id: string, _fly: boolean) => {
        ui.current.selected = id;
        focusOn(id);
      },
      zoom: (f: number) => zoomAt(f),
    };
    api.current = mine;
    document.fonts?.ready.then(() => {
      if (!alive) return;
      readFonts();
      // the names and captions the fit measures have their real widths now
      settle();
    });
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("keydown", onKey);
    window.addEventListener("flock:theme", onTheme);
    // The rail folded or the legend opened (GraphExplorer.tsx): measure again,
    // and refit if the reader has not moved the camera, once the rail's
    // transition has run.
    const onChrome = () => {
      setTimeout(() => {
        measure();
        invalidate();
      }, 60);
      setTimeout(() => alive && settle(), 320);
    };
    window.addEventListener("graph:chrome", onChrome);
    // The canvas always matches its container times devicePixelRatio.
    // A new size refits an untouched map even while something is selected
    // (the card is allowed for then), and checks a focus.
    const ro = new ResizeObserver(() => {
      resize();
      if (focused && focused === ui.current.selected) settle();
      else if (touched || !scene.current.nodes.length) invalidate();
      else fit(false);
    });
    ro.observe(wrap);
    const onVisible = () => !document.hidden && invalidate();
    document.addEventListener("visibilitychange", onVisible);
    invalidate();

    return () => {
      alive = false;
      if (api.current === mine) api.current = NO_API;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("keydown", onKey);
      window.removeEventListener("flock:theme", onTheme);
      window.removeEventListener("graph:chrome", onChrome);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // One layout pass per graph. This effect comes after the canvas effect on
  // purpose: a layout that is already cached is shown at once, and the canvas
  // must be listening by then.
  useEffect(() => {
    if (!graph) return;
    let alive = true;
    const show = (laid: Scene) => {
      scene.current = laid;
      ui.current.hover = null;
      inner.current.refilter();
      inner.current.fit(false);
      out.current.onReady(true);
      // the takeaway line over the map is written once the graph is in: fit
      // around it when it has landed
      setTimeout(() => alive && inner.current.settle(), 250);
    };
    const cached = laidOut.get(graph);
    if (cached) show(cached);
    else
      layoutGraph(graph, () => alive).then((laid) => {
        if (!laid || !alive) return;
        laidOut.set(graph, laid);
        show(laid);
      });
    return () => {
      alive = false;
    };
  }, [graph]);

  useEffect(() => {
    inner.current.refilter();
  }, [selected, hidden, tags, query, motion]);

  return (
    <div ref={wrapRef} className="absolute inset-0">
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="application"
        aria-label="Funding graph. Drag to pan, scroll or plus and minus to zoom, arrow keys to move, zero to fit. Use search to find and select an entity."
        className={`absolute inset-0 h-full w-full cursor-grab touch-none outline-none transition-opacity duration-200 ${
          ready ? "opacity-100" : "opacity-0"
        }`}
      />
      <div
        ref={tipRef}
        className="tip left-0 top-0 opacity-0 transition-opacity duration-150"
      />
    </div>
  );
}
