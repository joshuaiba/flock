"use client";

import { useEffect, useRef } from "react";
import type { Graph } from "@/lib/api";
import { day, money, plural, truncate } from "@/lib/format";
import { layoutGraph, type N, type Scene } from "@/lib/graphLayout";
import { readPalette } from "@/lib/paint";
import { useStore } from "@/lib/store";
import { tagLabel } from "@/lib/tags";
import { NO_API, type GraphViewProps } from "./GraphView";

// The flat view of the graph. Nodes are plain marks in the text color, drawn
// on one canvas: a filled dot sized on a sqrt scale of dollars for a company,
// a ring for an agency or office, a small diamond for a solicitation. Award
// edges are lines in the accent (the one color, and it means dollars awarded),
// weight by amount; every other edge is a faint dotted line in the text color.
// The ground is the plain page.
//
// The layout is computed once (lib/graphLayout.ts) and never moves on its own.
// Nothing here animates by itself: the canvas redraws only while the reader
// pans, zooms or drags, or while a short camera move answers a click. The
// camera is smooth: inertial panning, zoom toward the cursor, eased moves when
// focusing. Rendering culls to the viewport and draws each kind of mark as one
// path, so large graphs stay fluid.
//
// What is shown is decided outside (GraphExplorer.tsx): this view is handed the
// graph, the ids the filters hide, the selection and the search text, and
// shares them with the 3D view.

type View = { k: number; tx: number; ty: number };
type Spring = { n: N; ox: number; oy: number; tx: number; ty: number; vx: number; vy: number };

const MAX_K = 3.5;
const MIN_R = 2; // the smallest a mark is drawn, in CSS pixels
const MOVE_S = 0.4; // seconds a camera move takes

// Mark opacity. Marks are opaque, so no edge shows through a dot; closed
// solicitations are fainter than open ones.
const MARK_ALPHA = 1;
const CLOSED_ALPHA = 0.5;
const FADED = 0.3; // what non-neighbors dim to while a node is hovered or selected

// Edge opacity at rest, before the crowding and hover adjustments.
const OTHER_EDGE_ALPHA = 0.38;
const AWARD_EDGE_ALPHA = 0.55;
const OTHER_EDGE_WIDTH = 1;
const DOTS = [1, 4]; // the dotted line of an edge that is not an award

// Name labels: companies in the display serif, agencies and offices in the
// interface face, categories smaller and quieter.
const NAME_PX = 17;
const ORG_PX = 12.5;
const REGION_PX = 11;

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
    let fonts = { name: `500 ${NAME_PX}px serif`, org: `${ORG_PX}px sans-serif`, region: `${REGION_PX}px sans-serif` };
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
    let springs: Spring[] = [];
    let obstacles: number[] = [];
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

    const wide = () => W > 900;
    /** The part of the canvas not covered by the rail, nav or panel. */
    const room = () =>
      wide()
        ? { l: 304, t: 76, r: ui.current.selected ? 356 : 48, b: 64 }
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
    /** Marks grow with zoom, but more slowly than the space between them. */
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
      const p = { ...room(), r: wide() ? 356 : 24 };
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
      // An arrival from a link (`fly`) is the same short move as a click.
      void fly;
      moveTo({ k, tx: p.l + aw - n.x * k, ty: p.t + ah - n.y * k }, true);
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

      const want = ui.current.hover || ui.current.selected || matches ? 1 : 0;
      if (Math.abs(want - dim) > 0.004) {
        dim += (want - dim) * (1 - Math.exp(-dt * 11));
        moving = true;
      } else dim = want;
      return moving;
    };

    // Reused per frame, so drawing thousands of edges and nodes allocates nothing.
    const eb: number[][] = Array.from({ length: 8 }, () => []);
    // marks by shape, lit and faded: dots, rings, open diamonds, closed diamonds
    const nb: N[][] = Array.from({ length: 8 }, () => []);
    const vis: N[] = [];
    const placed: number[] = [];

    const place = (x0: number, y0: number, x1: number, y1: number) => {
      // labels keep a margin from the edge of the view
      if (x0 < 16 || y0 < 16 || x1 > W - 16 || y1 > H - 16) return false;
      for (let i = 0; i < obstacles.length; i += 4)
        if (x0 < obstacles[i + 2] && x1 > obstacles[i] && y0 < obstacles[i + 3] && y1 > obstacles[i + 1]) return false;
      for (let i = 0; i < placed.length; i += 4)
        if (x0 < placed[i + 2] && x1 > placed[i] && y0 < placed[i + 3] && y1 > placed[i + 1]) return false;
      placed.push(x0, y0, x1, y1);
      return true;
    };

    const draw = () => {
      const { nodes, links, near } = scene.current;
      const k = view.k;
      const z = zs();
      const { selected, hover } = ui.current;
      const fid = hover ?? selected; // the node whose neighborhood is lit
      const around = fid ? near.get(fid) : null;
      const lit = (n: N) => (fid ? n.id === fid || !!around?.has(n.id) : matches ? matches.has(n.id) : true);
      const faded = 1 - (1 - FADED) * dim; // non-neighbors dim to about 30%

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // 1. Edges. Buckets 0-2: awards lit, by weight; 3-5: awards faded;
      //    6: other lit; 7: other faded.
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
        else eb[on ? 6 : 7].push(i);
      }
      // With a great many edges in view, the dotted ones are drawn solid: a
      // dash pattern on thousands of short lines costs more than it shows.
      const plain = onScreen > 1400;
      ctx.lineCap = "round";
      // a great many edges in view are drawn fainter, so they read as a haze, not a tangle
      const crowd = fid ? 1 : Math.min(1, Math.sqrt(900 / Math.max(onScreen, 1)));
      for (let b = 0; b < 8; b++) {
        const list = eb[b];
        if (!list.length) continue;
        const award = b < 6;
        const on = award ? b < 3 : b === 6;
        const rest = award ? AWARD_EDGE_ALPHA : OTHER_EDGE_ALPHA;
        // the edges of the node in focus brighten; the others fade with the rest of the map
        ctx.globalAlpha = on ? rest * crowd + (fid ? (award ? 0.4 : 0.3) * dim : 0) : rest * faded * crowd;
        ctx.beginPath();
        for (const i of list) {
          const l = links[i];
          ctx.moveTo(sx(l.source), sy(l.source));
          ctx.lineTo(sx(l.target), sy(l.target));
        }
        ctx.strokeStyle = award ? palette.accent : palette.text;
        ctx.lineWidth = award ? Math.max(0.75, (0.7 + (b % 3) * 0.9) * z) : OTHER_EDGE_WIDTH;
        ctx.setLineDash(award || plain ? [] : DOTS);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // 2. Marks. Nodes in view are sorted into buckets by shape (faded ones
      //    first, then lit), so each bucket is one path.
      for (const list of nb) list.length = 0;
      vis.length = 0;
      for (const n of nodes) {
        if (hidden.has(n.id)) continue;
        const x = sx(n), y = sy(n), m = rad(n, z) + 6;
        if (x + m < 0 || x - m > W || y + m < 0 || y - m > H) continue;
        vis.push(n);
        const shape = n.kind === "company" ? 0 : n.kind === "opportunity" ? (n.open ? 2 : 3) : 1;
        nb[(lit(n) ? 4 : 0) + shape].push(n);
      }
      ctx.lineJoin = "miter";
      for (let b = 0; b < nb.length; b++) {
        const list = nb[b];
        if (!list.length) continue;
        const shape = b % 4;
        const alpha = (b < 4 ? faded : 1) * (shape === 3 ? CLOSED_ALPHA : MARK_ALPHA);
        if (shape === 0) {
          // a company: a filled dot
          ctx.globalAlpha = alpha;
          ctx.fillStyle = palette.text;
          ctx.beginPath();
          for (const n of list) {
            const x = sx(n), y = sy(n), r = rad(n, z);
            ctx.moveTo(x + r, y);
            ctx.arc(x, y, r, 0, Math.PI * 2);
          }
          ctx.fill();
          continue;
        }
        // A ring or a diamond is an outline: the page color inside it first,
        // so no edge shows through, then the stroke.
        const trace = () => {
          ctx.beginPath();
          for (const n of list) {
            const x = sx(n), y = sy(n), r = rad(n, z);
            if (shape === 1) {
              ctx.moveTo(x + r, y);
              ctx.arc(x, y, r, 0, Math.PI * 2);
            } else {
              ctx.moveTo(x, y - r);
              ctx.lineTo(x + r, y);
              ctx.lineTo(x, y + r);
              ctx.lineTo(x - r, y);
              ctx.closePath();
            }
          }
        };
        trace();
        ctx.globalAlpha = 1;
        ctx.fillStyle = palette.bg;
        ctx.fill();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = palette.text;
        ctx.lineWidth = shape === 1 ? 1.5 : 1.25;
        ctx.stroke();
        if (shape === 1) {
          // an agency's ring carries a second, finer ring inside it
          ctx.beginPath();
          for (const n of list) {
            const x = sx(n), y = sy(n), r = rad(n, z) * 0.52;
            if (r < 2.5) continue;
            ctx.moveTo(x + r, y);
            ctx.arc(x, y, r, 0, Math.PI * 2);
          }
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
      // the selected and hovered nodes get a thin ring, a little clear of the mark
      for (const id of hover === selected ? [selected] : [selected, hover]) {
        const n = id && scene.current.byId.get(id);
        if (!n || hidden.has(n.id)) continue;
        ctx.globalAlpha = id === selected ? 1 : 0.6;
        ctx.strokeStyle = palette.text;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.arc(sx(n), sy(n), rad(n, z) + 5, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // 3. Labels. Category names first, then entity names by importance; a label
      //    is only drawn where it overlaps nothing already placed.
      placed.length = 0;
      // marks are obstacles too: a name never sits on top of another node
      for (const n of vis) {
        const r = n.r * z;
        if (r < 3.5) continue;
        placed.push(sx(n) - r, sy(n) - r, sx(n) + r, sy(n) + r);
      }
      ctx.textBaseline = "top";
      ctx.textAlign = "center";
      ctx.lineJoin = "round";
      ctx.font = fonts.region;
      ctx.fillStyle = palette.muted;
      for (const g of scene.current.regions) {
        if (g.n < 2 || (ui.current.tags.size && !ui.current.tags.has(g.tag)) || !live.has(g.tag)) continue;
        const text = tagLabel(g.tag);
        const w = ctx.measureText(text).width;
        const x = sx(g), y = g.top * k + view.ty - 28;
        if (!place(x - w / 2 - 6, y - 3, x + w / 2 + 6, y + 15)) continue;
        ctx.globalAlpha = 0.8 - 0.45 * dim;
        ctx.fillText(text, x, y);
      }
      // Density follows zoom: only the largest nodes are named from afar.
      const minR = k < 0.4 ? 13 : k < 0.6 ? 9.5 : k < 0.95 ? 6.5 : 0;
      let budget = 90;
      const label = (n: N, forced: boolean, alpha: number) => {
        if (budget <= 0) return;
        // a company in the display serif, an agency or office in the interface face
        ctx.font = n.org || n.kind === "opportunity" ? fonts.org : fonts.name;
        const tall = n.org || n.kind === "opportunity" ? ORG_PX + 3 : NAME_PX + 1;
        const text = truncate(n.name, forced ? 60 : 34);
        if (!n.labelWidth) n.labelWidth = ctx.measureText(truncate(n.name, 34)).width;
        const w = forced ? ctx.measureText(text).width : n.labelWidth;
        const r = rad(n, z);
        // A company's name sits beside its dot (right, left, below, above); an
        // agency's sits under its ring (below, above, right, left). The first
        // spot that is free.
        const side = (dir: number): [number, number] => [sx(n) + dir * (r + 9 + w / 2), sy(n) - tall / 2];
        const spots: [number, number][] = n.org
          ? [[sx(n), sy(n) + r + 6], [sx(n), sy(n) - r - tall - 5], side(1), side(-1)]
          : [side(1), side(-1), [sx(n), sy(n) + r + 6], [sx(n), sy(n) - r - tall - 5]];
        const spot = spots.find(([x, y]) => place(x - w / 2 - 4, y - 1, x + w / 2 + 4, y + tall));
        if (!spot) return;
        const [x, y] = spot;
        budget--;
        ctx.globalAlpha = 0.9 * alpha;
        ctx.strokeStyle = palette.bg;
        ctx.lineWidth = 3.5;
        ctx.strokeText(text, x, y);
        ctx.fillStyle = n.org || n.kind === "opportunity" ? palette.muted : palette.text;
        if (forced) ctx.fillStyle = palette.text;
        ctx.globalAlpha = alpha;
        ctx.fillText(text, x, y);
      };
      for (const id of hover === selected ? [selected] : [hover, selected]) {
        const n = id && scene.current.byId.get(id);
        if (n && !hidden.has(n.id)) label(n, true, 1);
      }
      const focused = !!fid || !!matches;
      // the node in focus and its neighbors are named first, then the rest, dimmed
      for (const n of vis) {
        if (n.id === hover || n.id === selected || !focused || !lit(n) || n.kind === "opportunity") continue;
        label(n, false, 1);
      }
      for (const n of vis) {
        if (n.id === hover || n.id === selected || (focused && lit(n))) continue;
        if (n.kind === "opportunity" || (n.r * z < minR && n.rank > 11)) continue;
        label(n, false, focused ? Math.max(faded, 0.45) : 1);
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
      const sans = `${s.getPropertyValue("--font-inter").trim() || "system-ui"}, system-ui, sans-serif`;
      fonts = { name: `500 ${NAME_PX}px ${display}`, org: `${ORG_PX}px ${sans}`, region: `${REGION_PX}px ${sans}` };
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
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("keydown", onKey);
    window.addEventListener("flock:theme", onTheme);
    // The rail folded or the legend opened (GraphExplorer.tsx): measure again.
    const onChrome = () => {
      setTimeout(measure, 60);
      setTimeout(invalidate, 80);
    };
    window.addEventListener("graph:chrome", onChrome);
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
