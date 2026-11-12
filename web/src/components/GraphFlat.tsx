"use client";

import { useEffect, useRef } from "react";
import type { Graph } from "@/lib/api";
import { medallionUrl, type MedallionName } from "@/lib/art";
import { day, money, plural, truncate } from "@/lib/format";
import { layoutGraph, type L, type N, type Scene } from "@/lib/graphLayout";
import { drawBloom, readPalette, type Bloom } from "@/lib/paint";
import { drawSwallow, loadSprites, SPRITE, type Sprites } from "@/lib/sprites";
import { chainRing, useStore } from "@/lib/store";
import { tagLabel } from "@/lib/tags";
import { NO_API, type GraphViewProps } from "./GraphView";

// The flat view of the graph. Nodes are the medallions from the illustration
// pack, drawn as textures on one canvas and sized on a sqrt scale of dollars:
// the column is an agency or office, the other five are companies by category,
// and solicitations are the same medallions, small and faint. Award edges are
// tapered brushstrokes in faded Pompeian red, weight by amount; every other
// edge is a thin ink line. The ground is plain parchment with paper grain.
//
// The layout is computed once (lib/graphLayout.ts) and never moves on its own.
// The camera is smooth: inertial panning, zoom toward the cursor, 500ms eased
// moves when focusing. Rendering culls to the viewport, draws each medallion
// from a pre-scaled copy near its on-screen size, and drops edge detail when
// zoomed out, so large graphs stay fluid.
//
// What is shown is decided outside (GraphExplorer.tsx): this view is handed the
// graph, the ids the filters hide, the selection and the search text, and
// shares them with the 3D view.

type View = { k: number; tx: number; ty: number };
type Spring = { n: N; ox: number; oy: number; tx: number; ty: number; vx: number; vy: number };
type GBird = {
  from: { x: number; y: number };
  fromNode: N | null;
  to: N | null;
  t: number;
  dur: number;
  wait: number;
  phase: number;
  /** seconds since it landed */
  rest: number;
  /** the way it was facing when it landed: 1 right, -1 left */
  face: number;
};

const MAX_K = 3.5;

// Medallion textures. Each image is loaded once and pre-scaled to a ladder of
// sizes, each half the one above. One strip per size holds all six medallions
// side by side, so nodes drawn at the same size share a single texture. A node
// is drawn from the smallest strip that covers its on-screen diameter in device
// pixels: the full-size art is never resampled during a frame.
const MEDALLIONS: MedallionName[] = ["column", "laurel", "wing", "anchor", "compass", "shield"];
const CELL = Object.fromEntries(MEDALLIONS.map((name, i) => [name, i])) as Record<MedallionName, number>;
const MIPS = [12, 24, 48, 96, 192, 384]; // cell sizes in device pixels; each must be half the next
const SOURCE = 512; // which file the ladder is built from
const PAD = 2; // transparent gutter around each cell, so neighbors never bleed
const MIN_R = 2.5; // the smallest a medallion is drawn, in CSS pixels

// Medallion opacity. Solicitations are fainter than everything else, and closed
// ones fainter than open ones. At dusk the art is drawn as it is, a touch dimmer.
const OPEN_ALPHA = 0.72;
const CLOSED_ALPHA = 0.4;
const DUSK_ALPHA = 0.9;
const FADED = 0.2; // what non-neighbors dim to while a node is hovered or selected

// Edge opacity at rest, before the crowding and hover adjustments.
const INK_EDGE_ALPHA = 0.35;
const AWARD_EDGE_ALPHA = 0.5;
const INK_EDGE_WIDTH = 0.8;

// The swallows that carry awards along edges.
const BIRD_WIDTH = 26; // drawn width of a sprite cell, in CSS pixels
const BIRD_ALPHA = 0.95;
const BIRD_LIFT = 8; // how far above a medallion a bird comes to rest
const BIRD_FADE = 1.2; // seconds a landed bird takes to fade

type Atlas = { strips: CanvasImageSource[] };
let atlasPending: Promise<Atlas> | null = null;

/** Load the six medallions and build the strips (once, shared between visits). */
function loadAtlas(): Promise<Atlas> {
  atlasPending ??= Promise.all(
    MEDALLIONS.map(
      (name) =>
        new Promise<HTMLImageElement | null>((resolve) => {
          const img = new Image();
          img.decoding = "async";
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = medallionUrl(name, SOURCE);
        }),
    ),
  ).then(async (images) => {
    if (images.some((img) => !img)) atlasPending = null; // try again on the next visit
    const canvases: HTMLCanvasElement[] = [];
    for (let level = MIPS.length - 1; level >= 0; level--) {
      const size = MIPS[level];
      const step = size + PAD * 2;
      const c = document.createElement("canvas");
      c.width = step * MEDALLIONS.length;
      c.height = step;
      const g = c.getContext("2d")!;
      g.imageSmoothingQuality = "high";
      const above = canvases[level + 1];
      images.forEach((img, i) => {
        const x = i * step + PAD;
        if (above) {
          // an exact halving of the strip above: a clean box filter in every browser
          const big = MIPS[level + 1];
          g.drawImage(above, i * (big + PAD * 2) + PAD, PAD, big, big, x, PAD, size, size);
        } else if (img) g.drawImage(img, x, PAD, size, size);
        else {
          // the file did not load: a blank plaster disc keeps the node on the map
          g.fillStyle = "#ede4d3";
          g.strokeStyle = "#7a6b5c";
          g.lineWidth = size / 40;
          g.beginPath();
          g.arc(x + size / 2, PAD + size / 2, size * 0.47, 0, Math.PI * 2);
          g.fill();
          g.stroke();
        }
      });
      canvases[level] = c;
    }
    // Bitmaps are immutable, so the browser uploads each strip to the GPU once.
    const strips = await Promise.all(
      canvases.map((c): Promise<CanvasImageSource> | CanvasImageSource =>
        typeof createImageBitmap === "function" ? createImageBitmap(c).catch(() => c) : c,
      ),
    );
    return { strips };
  });
  return atlasPending;
}

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

export function GraphFlat({ graph, hidden, tags, selected, query, ready, api, onSelect, onReady }: GraphViewProps) {
  const { motion, pin } = useStore();
  const pinRef = useRef(pin);
  pinRef.current = pin;

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const scene = useRef<Scene>(EMPTY);
  const ui = useRef({ selected, hidden, tags, query, hover: null as string | null, motion });
  const inner = useRef({
    invalidate: () => {},
    fit: (_animate: boolean) => {},
    refilter: () => {},
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
    let fonts = { serif: "serif", caps: "serif" };
    let atlas: Atlas | null = null; // nothing is drawn until the medallions have loaded
    let sprites: Sprites | null = null;
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

    let hidden: ReadonlySet<string> = ui.current.hidden;
    let live = new Set<string>(); // categories that still have a member on the map
    let matches: Set<string> | null = null;
    let dim = 0; // 0..1: how far non-neighbors have faded
    let blooms: Bloom[] = [];
    let springs: Spring[] = [];
    let obstacles: number[] = [];
    const birds: GBird[] = Array.from({ length: 5 }, (_, i) => ({
      from: { x: 0, y: 0 },
      fromNode: null,
      to: null,
      t: 0,
      dur: 1,
      wait: 1 + i * 1.4,
      phase: i,
      rest: BIRD_FADE,
      face: 1,
    }));
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
      hot: boolean;
    } = null;

    const wide = () => W > 900;
    /** The part of the canvas not covered by the rail, nav or panel. */
    const room = () =>
      wide()
        ? { l: 300, t: 76, r: ui.current.selected ? 404 : 48, b: 56 }
        : { l: 24, t: 170, r: 24, b: 30 };

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
    /** Medallions grow with zoom, but more slowly than the space between them. */
    const zs = () => Math.min(Math.pow(view.k, 0.7), view.k * 1.45);

    /** A node's drawn radius in CSS pixels. */
    const rad = (n: N, z: number) => Math.max(MIN_R, n.r * z);

    /** Rail and panel rectangles, so labels are never drawn underneath them. */
    const measure = () => {
      obstacles = [];
      const base = canvas.getBoundingClientRect();
      for (const el of host.querySelectorAll<HTMLElement>("[data-obstacle]")) {
        const r = el.getBoundingClientRect();
        obstacles.push(r.left - base.left - 6, r.top - base.top - 6, r.right - base.left + 6, r.bottom - base.top + 6);
      }
    };

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

    const fitTarget = (): View => {
      const b = scene.current.bounds;
      const p = room();
      const bw = Math.max(b.x1 - b.x0, 200);
      const bh = Math.max(b.y1 - b.y0, 200);
      // One scale for both axes: the graph keeps its natural proportions.
      const k = Math.min(1.5, ((W - p.l - p.r) / bw) * 0.94, ((H - p.t - p.b) / bh) * 0.94);
      return {
        k,
        tx: p.l + (W - p.l - p.r) / 2 - ((b.x0 + b.x1) / 2) * k,
        ty: p.t + (H - p.t - p.b) / 2 - ((b.y0 + b.y1) / 2) * k,
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
      const t = fitTarget();
      fitK = t.k;
      moveTo(t, animate);
    };

    /** Center a node with its neighborhood in view, not zoomed in until it feels cramped. */
    const focusOn = (id: string, fly: boolean) => {
      const n = scene.current.byId.get(id);
      if (!n) return;
      const p = { ...room(), r: wide() ? 404 : 24 };
      let hx = 140;
      let hy = 110;
      for (const o of scene.current.near.get(id) ?? []) {
        const q = scene.current.byId.get(o);
        if (!q || hidden.has(o)) continue;
        hx = Math.max(hx, Math.abs(q.x - n.x) + 70);
        hy = Math.max(hy, Math.abs(q.y - n.y) + 70);
      }
      const aw = (W - p.l - p.r) / 2;
      const ah = (H - p.t - p.b) / 2;
      const k = Math.max(Math.max(fitK, 0.4), Math.min(1.35, aw / hx, ah / hy));
      moveTo({ k, tx: p.l + aw - n.x * k, ty: p.t + ah - n.y * k }, true);
      if (fly && ui.current.motion) {
        birds[0] = { from: { x: -40, y: H * 0.25 }, fromNode: null, to: n, t: 0, dur: 1.6, wait: 0, phase: 0, rest: 0, face: 1 };
      } else if (fly) blooms.push({ x: n.x, y: n.y, t: 0 });
    };

    const zoomAt = (f: number, px = W / 2, py = H / 2) => {
      tween = null;
      vel.x = vel.y = 0;
      const k = Math.max(fitK * 0.5, Math.min(MAX_K, goal.k * f));
      goal = clamp({ k, tx: px - ((px - goal.tx) / goal.k) * k, ty: py - ((py - goal.ty) / goal.k) * k });
      invalidate();
    };

    const refilter = () => {
      const { nodes } = scene.current;
      hidden = ui.current.hidden;
      live = new Set();
      for (const n of nodes) if (!n.org && n.tag && !hidden.has(n.id)) live.add(n.tag);
      const q = ui.current.query;
      matches = q ? new Set(nodes.filter((n) => n.nameLower.includes(q)).map((n) => n.id)) : null;
      setTimeout(measure, 60);
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

    /** Advance camera, springs and fades. Returns true while anything is still moving. */
    const update = (dt: number): boolean => {
      let moving = false;
      if (tween) {
        tween.t = Math.min(1, tween.t + dt / 0.5);
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

      const want = ui.current.hover || ui.current.selected || matches ? 1 : 0;
      if (Math.abs(want - dim) > 0.004) {
        dim += (want - dim) * (1 - Math.exp(-dt * 11));
        moving = true;
      } else dim = want;

      for (const b of blooms) b.t += dt;
      return moving || blooms.length > 0;
    };

    // Reused per frame, so drawing thousands of edges and nodes allocates nothing.
    const eb: number[][] = Array.from({ length: 10 }, () => []);
    const nb: N[][] = Array.from({ length: MIPS.length * 2 }, () => []);
    const vis: N[] = [];
    const placed: number[] = [];

    const place = (x0: number, y0: number, x1: number, y1: number) => {
      // labels keep a margin from the edge of the view and its hairline frame
      if (x0 < 30 || y0 < 30 || x1 > W - 30 || y1 > H - 26) return false;
      for (let i = 0; i < obstacles.length; i += 4)
        if (x0 < obstacles[i + 2] && x1 > obstacles[i] && y0 < obstacles[i + 3] && y1 > obstacles[i + 1]) return false;
      for (let i = 0; i < placed.length; i += 4)
        if (x0 < placed[i + 2] && x1 > placed[i] && y0 < placed[i + 3] && y1 > placed[i + 1]) return false;
      placed.push(x0, y0, x1, y1);
      return true;
    };

    const draw = (dt: number) => {
      const { nodes, links, near } = scene.current;
      const k = view.k;
      const z = zs();
      const { selected, hover } = ui.current;
      const fid = hover ?? selected; // the node whose neighborhood is lit
      const around = fid ? near.get(fid) : null;
      const lit = (n: N) => (fid ? n.id === fid || !!around?.has(n.id) : matches ? matches.has(n.id) : true);
      const faded = 1 - (1 - FADED) * dim; // non-neighbors dim to about 20%
      const spacing = ctx as CanvasRenderingContext2D & { letterSpacing: string };

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (!atlas) return; // the map appears whole, once its medallions have loaded

      // 1. Edges. Buckets 0-2: awards lit, by weight; 3-5: awards faded;
      //    6/7: other lit solid/dashed; 8/9: other faded solid/dashed.
      for (const b of eb) b.length = 0;
      let onScreen = 0;
      for (let i = 0; i < links.length; i++) {
        const l = links[i];
        if (hidden.has(l.source.id) || hidden.has(l.target.id)) continue;
        const x1 = sx(l.source), y1 = sy(l.source), x2 = sx(l.target), y2 = sy(l.target);
        if ((x1 < 0 && x2 < 0) || (x1 > W && x2 > W) || (y1 < 0 && y2 < 0) || (y1 > H && y2 > H)) continue;
        const on = fid
          ? l.source.id === fid || l.target.id === fid
          : matches
            ? matches.has(l.source.id) || matches.has(l.target.id)
            : true;
        onScreen++;
        if (l.kind === "award") eb[(on ? 0 : 3) + (l.w < 1.4 ? 0 : l.w < 2.7 ? 1 : 2)].push(i);
        else eb[(on ? 6 : 8) + (l.kind === "issued" ? 0 : 1)].push(i);
      }
      // Zoomed out, or with a great many edges in view, strokes become plain
      // lines; up close they are tapered brushstrokes with a slight bow.
      const plain = k < 0.5 || onScreen > 1400;
      ctx.lineCap = "round";
      for (let b = 0; b < 10; b++) {
        const list = eb[b];
        if (!list.length) continue;
        const award = b < 6;
        const on = award ? b < 3 : b < 8;
        const rest = award ? AWARD_EDGE_ALPHA : INK_EDGE_ALPHA;
        // hovered edges brighten; the others fade with the rest of the map
        // a great many edges in view are drawn fainter, so they read as a haze, not a tangle
        const crowd = fid ? 1 : Math.min(1, Math.sqrt(900 / Math.max(onScreen, 1)));
        ctx.globalAlpha = on ? rest * crowd + (fid ? (award ? 0.38 : 0.26) * dim : 0) : rest * faded * crowd;
        ctx.beginPath();
        if (award && !plain) {
          for (const i of list) {
            const l = links[i];
            const x1 = sx(l.source), y1 = sy(l.source), x2 = sx(l.target), y2 = sy(l.target);
            const len = Math.hypot(x2 - x1, y2 - y1) || 1;
            const nx = -(y2 - y1) / len;
            const ny = (x2 - x1) / len;
            const ws = (1 + l.w * 1.6) * z * 0.5; // half-width at the source
            const wt = ws * 0.22; // tapering toward the recipient
            const bow = len * 0.05;
            const cx = (x1 + x2) / 2 + nx * bow;
            const cy = (y1 + y2) / 2 + ny * bow;
            const wm = (ws + wt) / 2;
            ctx.moveTo(x1 + nx * ws, y1 + ny * ws);
            ctx.quadraticCurveTo(cx + nx * wm, cy + ny * wm, x2 + nx * wt, y2 + ny * wt);
            ctx.lineTo(x2 - nx * wt, y2 - ny * wt);
            ctx.quadraticCurveTo(cx - nx * wm, cy - ny * wm, x1 - nx * ws, y1 - ny * ws);
            ctx.closePath();
          }
          ctx.fillStyle = palette.pompeii;
          ctx.fill();
        } else {
          for (const i of list) {
            const l = links[i];
            ctx.moveTo(sx(l.source), sy(l.source));
            ctx.lineTo(sx(l.target), sy(l.target));
          }
          ctx.strokeStyle = award ? palette.pompeii : palette.ink;
          ctx.lineWidth = award ? Math.max(0.5, (0.5 + (b % 3) * 0.9) * z) : INK_EDGE_WIDTH;
          ctx.setLineDash(!award && b % 2 === 1 ? [3, 4] : []);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // 2. Blooms where a bird has landed.
      blooms = blooms.filter((b) => drawBloom(ctx, { x: sx(b), y: sy(b), t: b.t, seed: (b.x + b.y) % 6.28 }, palette.terracotta));

      // 3. Medallions. Nodes in view are sorted into buckets by pre-scaled strip
      //    (faded ones first, then lit), so each run of draws shares one texture.
      const top = MIPS.length - 1;
      for (const list of nb) list.length = 0;
      vis.length = 0;
      for (const n of nodes) {
        if (hidden.has(n.id)) continue;
        const x = sx(n), y = sy(n), r = rad(n, z), m = r + 4;
        if (x + m < 0 || x - m > W || y + m < 0 || y - m > H) continue;
        vis.push(n);
        const px = r * 2 * dpr; // on-screen diameter in device pixels
        let level = 0;
        while (level < top && MIPS[level] < px) level++;
        nb[(lit(n) ? MIPS.length : 0) + level].push(n);
      }
      const dusk = palette.night ? DUSK_ALPHA : 1;
      for (let b = 0; b < nb.length; b++) {
        const list = nb[b];
        if (!list.length) continue;
        const level = b % MIPS.length;
        const strip = atlas.strips[level];
        const size = MIPS[level];
        const step = size + PAD * 2;
        const base = (b < MIPS.length ? faded : 1) * dusk;
        for (const n of list) {
          const r = rad(n, z);
          ctx.globalAlpha = n.kind === "opportunity" ? base * (n.open ? OPEN_ALPHA : CLOSED_ALPHA) : base;
          ctx.drawImage(strip, CELL[n.medallion] * step + PAD, PAD, size, size, sx(n) - r, sy(n) - r, r * 2, r * 2);
        }
      }
      // the selected and hovered medallions get a thin cypress ring
      for (const id of hover === selected ? [selected] : [selected, hover]) {
        const n = id && scene.current.byId.get(id);
        if (!n || hidden.has(n.id)) continue;
        ctx.globalAlpha = 1;
        ctx.strokeStyle = palette.cypress;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sx(n), sy(n), rad(n, z) + 2.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      // 4. Swallows along award edges: money moving from agency to company.
      //    Without the sprites nothing flies, so nothing lands and blooms either.
      if (ui.current.motion && sprites) {
        for (const b of birds) {
          if (b.wait > 0) {
            b.wait -= dt;
            b.rest += dt;
            // just landed: the bird holds a glide above the medallion and fades away
            if (sprites && b.to && b.rest < BIRD_FADE && !hidden.has(b.to.id))
              drawSwallow(ctx, sprites, {
                x: sx(b.to),
                y: sy(b.to) - rad(b.to, z) - BIRD_LIFT,
                width: BIRD_WIDTH,
                vx: b.face,
                vy: 0,
                frame: 0,
                award: true,
                glide: 0,
                alpha: BIRD_ALPHA * (1 - b.rest / BIRD_FADE),
              });
            if (b.wait <= 0) {
              let pick: L | null = null;
              for (let tries = 0; tries < 24 && links.length; tries++) {
                const l = links[Math.floor(Math.random() * links.length)];
                if (l.kind !== "award" || hidden.has(l.source.id) || hidden.has(l.target.id)) continue;
                const x = sx(l.target), y = sy(l.target);
                if (x < 0 || x > W || y < 0 || y > H) continue;
                pick = l;
                break;
              }
              if (pick) {
                const d = Math.hypot(sx(pick.target) - sx(pick.source), sy(pick.target) - sy(pick.source));
                Object.assign(b, {
                  fromNode: pick.source,
                  to: pick.target,
                  t: 0,
                  dur: Math.max(1.5, Math.min(4.5, d / 85)),
                });
              } else b.wait = 2;
            }
            continue;
          }
          if (!b.to) continue;
          b.t += dt / b.dur;
          b.phase += dt * SPRITE.fps;
          const ax = b.fromNode ? sx(b.fromNode) : b.from.x;
          const ay = b.fromNode ? sy(b.fromNode) : b.from.y;
          const dx = sx(b.to) - ax;
          const dy = sy(b.to) - rad(b.to, z) - BIRD_LIFT - ay;
          const t = Math.min(1, b.t);
          const e = t * t * (3 - 2 * t);
          const len = Math.hypot(dx, dy) || 1;
          // the path bows to one side; the bird heads along its tangent
          const bow = Math.min(36, len * 0.16);
          const arc = Math.sin(e * Math.PI) * bow;
          const turn = (Math.cos(e * Math.PI) * bow * Math.PI) / len;
          const vx = dx - dy * turn;
          const vy = dy + dx * turn;
          b.face = vx < 0 ? -1 : 1;
          if (sprites)
            drawSwallow(ctx, sprites, {
              x: ax + dx * e - (dy / len) * arc,
              y: ay + dy * e + (dx / len) * arc,
              width: BIRD_WIDTH,
              vx,
              vy,
              frame: b.phase,
              award: true,
              alpha: BIRD_ALPHA,
            });
          if (b.t >= 1) {
            blooms.push({ x: b.to.x, y: b.to.y, t: 0 }); // landed
            b.wait = 2.5 + Math.random() * 5;
            b.rest = 0;
            b.fromNode = null;
          }
        }
      }

      // 5. Labels. Category names first, then entity names by importance; a label
      //    is only drawn where it overlaps nothing already placed.
      placed.length = 0;
      // medallions are obstacles too: a name never sits on top of another node
      for (const n of vis) {
        const r = n.r * z;
        if (r < 3.5) continue;
        placed.push(sx(n) - r, sy(n) - r, sx(n) + r, sy(n) + r);
      }
      ctx.textBaseline = "top";
      ctx.textAlign = "center";
      ctx.lineJoin = "round";
      ctx.font = `11px ${fonts.caps}`;
      spacing.letterSpacing = "2.4px";
      ctx.fillStyle = palette.muted;
      for (const g of scene.current.regions) {
        if (g.n < 2 || (ui.current.tags.size && !ui.current.tags.has(g.tag)) || !live.has(g.tag)) continue;
        const text = tagLabel(g.tag).toUpperCase();
        const w = ctx.measureText(text).width;
        const x = sx(g), y = g.top * k + view.ty - 30;
        if (!place(x - w / 2 - 6, y - 3, x + w / 2 + 6, y + 15)) continue;
        ctx.globalAlpha = 0.9 - 0.5 * dim;
        ctx.fillText(text, x, y);
      }
      spacing.letterSpacing = "0px";
      ctx.font = `15.5px ${fonts.serif}`;
      // Density follows zoom: only the largest medallions are named from afar.
      const minR = k < 0.4 ? 17 : k < 0.6 ? 12.5 : k < 0.95 ? 8.5 : 0;
      let budget = 90;
      const label = (n: N, forced: boolean) => {
        if (budget <= 0) return;
        const text = truncate(n.name, forced ? 60 : 34);
        if (!n.labelWidth) n.labelWidth = ctx.measureText(truncate(n.name, 34)).width;
        const w = forced ? ctx.measureText(text).width : n.labelWidth;
        const r = rad(n, z);
        // below, above, right, then left of the medallion: the first spot that is free
        let x = sx(n);
        let y = sy(n) + r + 5;
        if (!place(x - w / 2 - 4, y - 1, x + w / 2 + 4, y + 17)) {
          y = sy(n) - r - 23;
          if (!place(x - w / 2 - 4, y - 1, x + w / 2 + 4, y + 17)) {
            y = sy(n) - 9;
            x = sx(n) + r + 8 + w / 2;
            if (!place(x - w / 2 - 4, y - 1, x + w / 2 + 4, y + 17)) {
              x = sx(n) - r - 8 - w / 2;
              if (!place(x - w / 2 - 4, y - 1, x + w / 2 + 4, y + 17)) return;
            }
          }
        }
        budget--;
        const strong = n.id === selected || n.id === hover;
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = palette.paper;
        ctx.lineWidth = 3.5;
        ctx.strokeText(text, x, y);
        ctx.fillStyle = strong ? palette.cypress : palette.ink;
        ctx.globalAlpha = 1;
        ctx.fillText(text, x, y);
      };
      for (const id of hover === selected ? [selected] : [hover, selected]) {
        const n = id && scene.current.byId.get(id);
        if (n && !hidden.has(n.id)) label(n, true);
      }
      for (const n of vis) {
        if (n.id === hover || n.id === selected || !lit(n)) continue;
        const focusLabel = (fid || matches) && n.kind !== "opportunity";
        if (!focusLabel && (n.kind === "opportunity" || (n.r * z < minR && n.rank > 11))) continue;
        label(n, false);
      }
      ctx.globalAlpha = 1;
    };

    const frame = (now: number) => {
      raf = 0;
      if (!alive) return;
      const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
      last = now;
      const moving = update(dt);
      draw(dt);
      if ((moving || ui.current.motion) && !document.hidden) raf = requestAnimationFrame(frame);
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
    const setHot = (p: NonNullable<typeof pointer>, hot: boolean) => {
      if (p.hot === hot) return;
      p.hot = hot;
      window.dispatchEvent(new CustomEvent("flock:chain-hot", { detail: hot }));
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
        hot: false,
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
        // Over the chain's ring, the medallion can be dropped onto the watchlist.
        const close = chainRing.ready && Math.hypot(e.clientX - chainRing.x, e.clientY - chainRing.y) < 110;
        setHot(pointer, close && n.kind !== "opportunity");
        tip.style.opacity = "0";
      } else {
        const dtm = Math.max(1, now - pointer.lt) / 1000;
        vel.x = vel.x * 0.5 + ((p.x - pointer.lx) / dtm) * 0.5;
        vel.y = vel.y * 0.5 + ((p.y - pointer.ly) / dtm) * 0.5;
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
        if (next) focusOn(next, false);
        tip.style.opacity = "0"; // the camera is about to move out from under it
      } else if (!n && !p.moved) select(null);
      else if (n && p.hot) {
        pinRef.current({ id: Number(n.id.split(":")[1]), name: n.name, tag: n.tag, kind: n.kind });
        // pinned: the medallion and its neighbors spring back to where they were
        springs.push({ n, ox: p.ox, oy: p.oy, tx: p.ox, ty: p.oy, vx: 0, vy: 0 });
        for (const s of springs) {
          s.tx = s.ox;
          s.ty = s.oy;
        }
      } else if (!n && performance.now() - p.lt > 90) vel.x = vel.y = 0; // held still before letting go
      setHot(p, false);
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
      fonts = {
        serif: `${s.getPropertyValue("--font-garamond").trim() || "Georgia"}, Georgia, serif`,
        caps: `${s.getPropertyValue("--font-cinzel").trim() || "Georgia"}, Georgia, serif`,
      };
      for (const n of scene.current.nodes) n.labelWidth = 0;
    };

    resize();
    readFonts();
    inner.current = { invalidate, fit, refilter };
    const mine = {
      fit,
      focusOn: (id: string, fly: boolean) => {
        ui.current.selected = id;
        focusOn(id, fly);
      },
      zoom: (f: number) => zoomAt(f),
    };
    api.current = mine;
    document.fonts?.ready.then(() => {
      readFonts();
      invalidate();
    });
    loadAtlas().then((a) => {
      atlas = a;
      invalidate();
    });
    loadSprites().then(
      (s) => (sprites = s),
      () => {}, // without the sprites the graph simply has no birds
    );
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("keydown", onKey);
    window.addEventListener("flock:theme", onTheme);
    // The canvas always matches its container times devicePixelRatio.
    const ro = new ResizeObserver(() => {
      resize();
      invalidate();
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
        className={`absolute inset-0 h-full w-full cursor-grab touch-none outline-none transition-opacity duration-700 ${
          ready ? "opacity-100" : "opacity-0"
        }`}
      />
      {/* Paper grain: above the canvas, below the controls. */}
      <div className="grain grain-local" aria-hidden="true" />
      <div
        ref={tipRef}
        className="fig paper-card pointer-events-none absolute left-0 top-0 whitespace-nowrap px-3 py-1 opacity-0 !shadow-none transition-opacity duration-150"
      />
    </div>
  );
}
