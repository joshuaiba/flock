"use client";

import { AnimatePresence, motion as m } from "motion/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clientGet, type Graph, type GraphNode } from "@/lib/api";
import { day, money, plural, truncate } from "@/lib/format";
import { layoutGraph, stressGraph, type L, type N, type Scene } from "@/lib/graphLayout";
import { entityIcon, iconPath, tagLabel, TAGS, washColor } from "@/lib/icons";
import { drawBird, drawBloom, hexA, mix, readPalette, type Bloom } from "@/lib/paint";
import { chainRing, useStore } from "@/lib/store";
import { Empty } from "./Empty";
import { Icon } from "./Icon";
import { PinButton } from "./PinButton";

// The graph explorer, drawn as an old painted map. Nodes are medallions (soft
// fill, thin sepia ring: solid for companies, double for agencies, dashed for
// solicitations) with an engraved glyph. Award edges are tapered brushstrokes in
// faded Pompeian red, weight by amount. Categories sit on watercolor washes.
//
// The layout is computed once (lib/graphLayout.ts) and never moves on its own.
// The camera is smooth: inertial panning, zoom toward the cursor, 500ms eased
// moves when focusing. Rendering culls to the viewport and drops edge detail
// when zoomed out, so large graphs stay fluid.

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
};

const WINDOWS = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
];
const MAX_K = 3.5;
const EMPTY: Scene = {
  nodes: [],
  links: [],
  washes: [],
  regions: [],
  near: new Map(),
  byId: new Map(),
  bounds: { x0: 0, y0: 0, x1: 1, y1: 1 },
};

export function GraphExplorer() {
  const params = useSearchParams();
  const focus = params.get("focus");
  const stress = process.env.NODE_ENV !== "production" ? Number(params.get("stress")) || 0 : 0;
  const { motion, pin } = useStore();
  const pinRef = useRef(pin);
  pinRef.current = pin;

  const [days, setDays] = useState(90);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const scene = useRef<Scene>(EMPTY);
  const ui = useRef({ selected, tags, query: "", hover: null as string | null, motion });
  const api = useRef({
    invalidate: () => {},
    fit: (_animate: boolean) => {},
    focusOn: (_id: string, _fly: boolean) => {},
    zoom: (_f: number) => {},
    refilter: () => {},
  });
  const focused = useRef<string | null>(null);

  ui.current.selected = selected;
  ui.current.tags = tags;
  ui.current.query = query.trim().toLowerCase();
  ui.current.motion = motion;

  // Data, then one layout pass.
  useEffect(() => {
    let alive = true;
    const ac = new AbortController();
    setFailed(false);
    setReady(false);
    (stress ? Promise.resolve(stressGraph(stress)) : clientGet<Graph>(`graph?days=${days}`, ac.signal))
      .then(async (g) => {
        const laid = await layoutGraph(g, () => alive);
        if (!laid || !alive) return;
        scene.current = laid;
        setGraph(g);
        api.current.refilter();
        api.current.fit(false);
        setReady(true);
      })
      .catch((e) => {
        if (alive && e.name !== "AbortError") setFailed(true);
      });
    return () => {
      alive = false;
      ac.abort();
    };
  }, [days, stress]);

  // A bird clicked on the landing page lands on its node here.
  useEffect(() => {
    if (!graph || !ready || !focus || focused.current === focus) return;
    if (scene.current.byId.has(focus)) {
      focused.current = focus;
      setSelected(focus);
      ui.current.selected = focus;
      requestAnimationFrame(() => api.current.focusOn(focus, true));
    } else if (days < 365) setDays(365); // older than the window: widen it once
  }, [graph, ready, focus, days]);

  useEffect(() => {
    api.current.refilter();
  }, [selected, tags, query, motion, graph]);

  // Canvas
  useEffect(() => {
    const wrap = wrapRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const tip = tipRef.current!;
    let palette = readPalette();
    let fonts = { serif: "serif", caps: "serif" };
    let washes = new Map<string, HTMLCanvasElement>();
    let fills = new Map<string, string>();
    const glyphs = new Map<string, Path2D>();
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

    let hidden = new Set<string>();
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

    const wash = (tag: string) => {
      let c = washes.get(tag);
      if (c) return c;
      c = document.createElement("canvas");
      c.width = c.height = 128;
      const g = c.getContext("2d")!;
      const grad = g.createRadialGradient(64, 64, 6, 64, 64, 64);
      const color = washColor(tag);
      const a = palette.night ? 0.17 : 0.34;
      grad.addColorStop(0, hexA(color, a));
      grad.addColorStop(0.55, hexA(color, a * 0.55));
      grad.addColorStop(0.85, hexA(color, a * 0.2));
      grad.addColorStop(1, hexA(color, 0));
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
      washes.set(tag, c);
      return c;
    };
    const fillOf = (n: N) => {
      const key = n.kind === "opportunity" ? "opp" : (n.tag ?? "none");
      let f = fills.get(key);
      if (!f) {
        f =
          key === "opp"
            ? palette.marble
            : mix(palette.night ? palette.card : palette.marble, washColor(n.tag), palette.night ? 0.6 : 0.62);
        fills.set(key, f);
      }
      return f;
    };
    const glyph = (n: N) => {
      const name = entityIcon(n.tag, n.kind);
      let p = glyphs.get(name);
      if (!p) glyphs.set(name, (p = new Path2D(iconPath(name))));
      return p;
    };

    /** Rail and panel rectangles, so labels are never drawn underneath them. */
    const measure = () => {
      obstacles = [];
      const base = canvas.getBoundingClientRect();
      for (const el of wrap.querySelectorAll<HTMLElement>("[data-obstacle]")) {
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
        birds[0] = { from: { x: -40, y: H * 0.25 }, fromNode: null, to: n, t: 0, dur: 1.6, wait: 0, phase: 0 };
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
      const { nodes, near } = scene.current;
      const t = ui.current.tags;
      hidden = new Set();
      if (t.size) {
        for (const n of nodes) if (!n.org && !n.tags.some((x) => t.has(x))) hidden.add(n.id);
        // an agency stays only while it still connects to something shown
        for (const n of nodes) {
          if (!n.org) continue;
          let any = false;
          for (const o of near.get(n.id) ?? []) {
            const q = scene.current.byId.get(o);
            if (q && !q.org && !hidden.has(o)) {
              any = true;
              break;
            }
          }
          if (!any) hidden.add(n.id);
        }
      }
      const q = ui.current.query;
      matches = q ? new Set(nodes.filter((n) => n.nameLower.includes(q)).map((n) => n.id)) : null;
      setTimeout(measure, 60);
      invalidate();
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

    // Reused per frame, so drawing thousands of edges allocates nothing.
    const eb: number[][] = Array.from({ length: 10 }, () => []);
    const placed: number[] = [];

    const place = (x0: number, y0: number, x1: number, y1: number) => {
      // labels stay clear of the border ornament
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
      const faded = 1 - 0.8 * dim; // non-neighbors dim to about 20%
      const spacing = ctx as CanvasRenderingContext2D & { letterSpacing: string };

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      wrap.style.backgroundPosition = `${view.tx % 96}px ${view.ty % 96}px`;

      // 1. Regions: watercolor washes, like provinces on an old painted map.
      for (const w of scene.current.washes) {
        const x = sx(w);
        const y = sy(w);
        const r = w.r * k;
        if (x + r < 0 || x - r > W || y + r < 0 || y - r > H) continue;
        if (ui.current.tags.size && !ui.current.tags.has(w.tag)) continue;
        ctx.drawImage(wash(w.tag), x - r, y - r, r * 2, r * 2);
      }

      // 2. Edges. Buckets 0-2: awards lit, by weight; 3-5: awards faded;
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
        const rest = award ? 0.5 : 0.24;
        // hovered edges brighten; the others fade with the rest of the map
        // a great many edges in view are drawn fainter, so they read as a wash, not a tangle
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
          ctx.lineWidth = award ? Math.max(0.5, (0.5 + (b % 3) * 0.9) * z) : 0.8;
          ctx.setLineDash(!award && b % 2 === 1 ? [3, 4] : []);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // 3. Blooms where a bird has landed.
      blooms = blooms.filter((b) => drawBloom(ctx, { x: sx(b), y: sy(b), t: b.t, seed: (b.x + b.y) % 6.28 }, palette.terracotta));

      // 4. Medallions. Two passes (faded, then lit), batched by fill and ring style.
      const vis: N[] = [];
      for (const n of nodes) {
        if (hidden.has(n.id)) continue;
        const x = sx(n), y = sy(n), r = n.r * z + 4;
        if (x + r < 0 || x - r > W || y + r < 0 || y - r > H) continue;
        vis.push(n);
      }
      const TAU = Math.PI * 2;
      for (const pass of [0, 1]) {
        const group = vis.filter((n) => (lit(n) ? 1 : 0) === pass);
        if (!group.length) continue;
        const alpha = pass ? 1 : faded;
        const byFill = new Map<string, N[]>();
        for (const n of group) {
          const f = fillOf(n);
          let a = byFill.get(f);
          if (!a) byFill.set(f, (a = []));
          a.push(n);
        }
        ctx.globalAlpha = alpha;
        for (const [f, list] of byFill) {
          ctx.fillStyle = f;
          ctx.beginPath();
          for (const n of list) {
            const r = Math.max(2.2, n.r * z);
            ctx.moveTo(sx(n) + r, sy(n));
            ctx.arc(sx(n), sy(n), r, 0, TAU);
          }
          ctx.fill();
        }
        // rings: solid (company), double (agency, office), dashed (solicitation)
        ctx.strokeStyle = palette.ink;
        ctx.lineWidth = Math.max(0.7, Math.min(1.3, z));
        ctx.globalAlpha = alpha * 0.78;
        ctx.beginPath();
        for (const n of group) {
          if (n.kind === "opportunity") continue;
          const r = Math.max(2.2, n.r * z);
          ctx.moveTo(sx(n) + r, sy(n));
          ctx.arc(sx(n), sy(n), r, 0, TAU);
          if (n.org && r > 5) {
            const inner = r - Math.max(2, r * 0.2);
            ctx.moveTo(sx(n) + inner, sy(n));
            ctx.arc(sx(n), sy(n), inner, 0, TAU);
          }
        }
        ctx.stroke();
        ctx.setLineDash([2.5, 2.5]);
        ctx.beginPath();
        for (const n of group) {
          if (n.kind !== "opportunity") continue;
          const r = Math.max(2.2, n.r * z);
          ctx.moveTo(sx(n) + r, sy(n));
          ctx.arc(sx(n), sy(n), r, 0, TAU);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // engraved glyphs, once a medallion is large enough to carry one
      let engraved = 0;
      ctx.strokeStyle = palette.ink;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const n of vis) {
        const r = n.r * z;
        if (r < 9 || engraved > 180) continue;
        engraved++;
        const s = (r * (n.org ? 1.0 : 1.25)) / 24;
        ctx.globalAlpha = (lit(n) ? 1 : faded) * 0.62;
        ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (sx(n) - 12 * s), dpr * (sy(n) - 12 * s));
        ctx.lineWidth = 1.1 / s;
        ctx.stroke(glyph(n));
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // the hovered and selected medallions get a cypress ring
      for (const id of [selected, hover]) {
        const n = id && scene.current.byId.get(id);
        if (!n || hidden.has(n.id)) continue;
        ctx.globalAlpha = 1;
        ctx.strokeStyle = palette.cypress;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx(n), sy(n), Math.max(2.2, n.r * z) + 3, 0, TAU);
        ctx.stroke();
      }

      // 5. Swallows along award edges: money moving from agency to company.
      if (ui.current.motion) {
        for (const b of birds) {
          if (b.wait > 0) {
            b.wait -= dt;
            if (b.to && !hidden.has(b.to.id))
              drawBird(ctx, sx(b.to), sy(b.to) - b.to.r * z - 5, -0.35, 0.02, 0.62, palette.ink, 0.75);
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
          b.phase += dt * 10;
          const ax = b.fromNode ? sx(b.fromNode) : b.from.x;
          const ay = b.fromNode ? sy(b.fromNode) : b.from.y;
          const bx = sx(b.to), by = sy(b.to) - b.to.r * z - 5;
          const t = Math.min(1, b.t);
          const e = t * t * (3 - 2 * t);
          const len = Math.hypot(bx - ax, by - ay) || 1;
          const arc = Math.sin(e * Math.PI) * Math.min(36, len * 0.16);
          drawBird(
            ctx,
            ax + (bx - ax) * e + (-(by - ay) / len) * arc,
            ay + (by - ay) * e + ((bx - ax) / len) * arc,
            Math.atan2(by - ay, bx - ax) + Math.cos(e * Math.PI) * 0.3,
            0.25 + 0.75 * Math.abs(Math.sin(b.phase)),
            0.7,
            palette.ink,
            0.8,
          );
          if (b.t >= 1) {
            blooms.push({ x: b.to.x, y: b.to.y, t: 0 }); // landed
            b.wait = 2.5 + Math.random() * 5;
            b.fromNode = null;
          }
        }
      }

      // 6. Labels. Region names first, then entity names by importance; a label
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
        if (g.n < 2 || (ui.current.tags.size && !ui.current.tags.has(g.tag))) continue;
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
      const minR = k < 0.4 ? 15 : k < 0.6 ? 11 : k < 0.95 ? 7.5 : 0;
      let budget = 90;
      const label = (n: N, forced: boolean) => {
        if (budget <= 0) return;
        const text = truncate(n.name, forced ? 60 : 34);
        if (!n.labelWidth) n.labelWidth = ctx.measureText(truncate(n.name, 34)).width;
        const w = forced ? ctx.measureText(text).width : n.labelWidth;
        const r = Math.max(2.2, n.r * z);
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
        setSelected(next);
        ui.current.selected = next;
        if (next) focusOn(next, false);
        tip.style.opacity = "0"; // the camera is about to move out from under it
      } else if (!n && !p.moved) setSelected(null);
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
      else if (e.key === "Escape") setSelected(null);
      else return;
      e.preventDefault();
    };
    const onLeave = () => !pointer && setHover(null);
    const onTheme = () => {
      palette = readPalette();
      washes = new Map();
      fills = new Map();
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
    api.current = { invalidate, fit, focusOn, zoom: zoomAt, refilter };
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

  const select = useCallback((id: string) => {
    setSelected(id);
    ui.current.selected = id;
    api.current.focusOn(id, false);
  }, []);

  // Derived UI
  const present = useMemo(() => {
    const s = new Set<string>();
    graph?.nodes.forEach((n) => n.tags.forEach((t) => s.add(t)));
    return [...TAGS.filter((t) => s.has(t)), ...[...s].filter((t) => !TAGS.includes(t)).sort()];
  }, [graph]);

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !graph) return [];
    return graph.nodes
      .filter((n) => n.name.toLowerCase().includes(q))
      .sort((a, b) => b.total - a.total)
      .slice(0, 7);
  }, [graph, query]);

  const detail = useMemo(() => {
    if (!graph || !selected) return null;
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const node = byId.get(selected);
    if (!node) return null;
    const around = new Map<string, { node: GraphNode; amount: number; kind: string }>();
    for (const e of graph.edges) {
      const other = e.source === selected ? e.target : e.target === selected ? e.source : null;
      const o = other && byId.get(other);
      if (!o) continue;
      const cur = around.get(o.id) ?? { node: o, amount: 0, kind: e.kind };
      cur.amount += e.amount;
      if (e.kind === "award") cur.kind = "award";
      around.set(o.id, cur);
    }
    return { node, around: [...around.values()].sort((a, b) => b.amount - a.amount).slice(0, 5) };
  }, [graph, selected]);

  const toggleTag = (t: string) =>
    setTags((was) => {
      const next = new Set(was);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  const empty = ready && graph && graph.nodes.length === 0;
  const caps = "font-caps text-[0.66rem] uppercase tracking-[0.14em]";

  return (
    <div ref={wrapRef} className="graticule fixed inset-0 z-20 overflow-hidden bg-paper">
      {/* A fine rule and laurel sprigs at the lower corners; labels keep clear of it. */}
      <div aria-hidden className="pointer-events-none absolute inset-3 rounded-sm border border-hair text-muted">
        <Icon name="company" size={30} className="absolute -bottom-2 -left-2 bg-paper opacity-70" />
        <Icon name="company" size={30} className="absolute -bottom-2 -right-2 bg-paper opacity-70" />
      </div>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="application"
        aria-label="Funding graph. Drag to pan, scroll or plus and minus to zoom, arrow keys to move, zero to fit. Use search to find and select an entity."
        className={`absolute inset-0 h-full w-full cursor-grab touch-none outline-none transition-opacity duration-700 ${
          ready ? "opacity-100" : "opacity-0"
        }`}
      />
      <div
        ref={tipRef}
        className="fig paper-card pointer-events-none absolute left-0 top-0 whitespace-nowrap px-3 py-1 opacity-0 !shadow-none transition-opacity duration-150"
      />

      {!ready && !failed && (
        <p className="note pointer-events-none absolute inset-0 grid place-items-center">drawing the map…</p>
      )}
      {failed && (
        <div className="absolute inset-0 grid place-items-center">
          <Empty title="The flock is out of sight">
            The data service is not answering. Start it with <code>uv run python -m pipeline.api.dev</code>.
          </Empty>
        </div>
      )}
      {empty && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <Empty title="Nothing landed in this window">Try a longer stretch of time.</Empty>
        </div>
      )}

      {/* Left rail */}
      <aside
        data-obstacle
        aria-label="Graph filters"
        className="absolute left-3 right-3 top-[4.5rem] flex flex-col gap-4 md:left-7 md:right-auto md:top-20 md:w-64"
      >
        <div>
          <label className="marble flex w-full cursor-text items-center gap-2 rounded-full px-4 py-1.5">
            <Icon name="gps-denied-nav" size={16} className="shrink-0 text-muted" />
            <span className="sr-only">Search the graph</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a company or agency"
              className="w-full bg-transparent text-[1.05rem] text-ink outline-none placeholder:italic placeholder:text-muted"
              type="search"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          {query.trim() && (
            <div className="paper-card mt-2 overflow-hidden p-2">
              {hits.length ? (
                <ul>
                  {hits.map((h) => (
                    <li key={h.id}>
                      <button
                        type="button"
                        onClick={() => select(h.id)}
                        className="flex w-full cursor-pointer items-center gap-2.5 rounded px-2 py-1 text-left hover:bg-hair"
                      >
                        <Icon name={entityIcon(h.tag, h.kind)} size={18} className="shrink-0 text-cypress" />
                        <span className="truncate">{h.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-2 py-1.5 italic text-muted">No one by that name in this window.</p>
              )}
            </div>
          )}
        </div>

        <div className="hidden md:block">
          <p className="label mb-2">Categories</p>
          <div className="grid grid-cols-5 gap-2">
            {present.map((t) => (
              <button
                key={t}
                type="button"
                title={tagLabel(t)}
                aria-label={tagLabel(t)}
                aria-pressed={tags.has(t)}
                onClick={() => toggleTag(t)}
                className={`marble coin aspect-square cursor-pointer transition-transform duration-500 hover:-translate-y-0.5 ${
                  tags.has(t) ? "!text-cypress outline outline-[1.5px] outline-offset-2 outline-cypress" : ""
                }`}
              >
                <Icon name={t} fallback="opportunity" size={22} />
              </button>
            ))}
          </div>
          <p className="mt-2.5 min-h-[3em] text-[0.98rem] italic leading-snug text-muted">
            {tags.size ? [...tags].map(tagLabel).join(", ") : "All categories"}
            {tags.size > 0 && (
              <button type="button" onClick={() => setTags(new Set())} className="ml-2 cursor-pointer not-italic underline">
                clear
              </button>
            )}
          </p>
        </div>

        <div>
          <p className="label mb-2 hidden md:block">Window</p>
          <div className="marble inline-flex rounded-full p-1" role="group" aria-label="Time window">
            {WINDOWS.map((w) => (
              <button
                key={w.days}
                type="button"
                aria-pressed={days === w.days}
                onClick={() => setDays(w.days)}
                className={`cursor-pointer rounded-full px-3 py-0.5 transition-colors ${caps} ${
                  days === w.days ? "bg-card text-ink shadow-[0_0_0_1px_var(--frame)]" : "text-muted hover:text-ink"
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* Legend and zoom */}
      <div className="absolute bottom-7 left-12 hidden items-center gap-5 text-[0.95rem] italic text-muted md:flex">
        <span className="flex items-center gap-2">
          <span className="h-3.5 w-3.5 rounded-full border border-ink/70 bg-marble" /> company
        </span>
        <span className="flex items-center gap-2">
          <span className="grid h-4 w-4 place-items-center rounded-full border border-ink/70 bg-marble">
            <span className="h-2 w-2 rounded-full border border-ink/70" />
          </span>
          agency
        </span>
        <span className="flex items-center gap-2">
          <span className="h-3.5 w-3.5 rounded-full border border-dashed border-ink/70 bg-marble" /> solicitation
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block h-[3px] w-6 rounded-full bg-pompeii" /> dollars awarded
        </span>
      </div>
      <div className="marble absolute bottom-6 right-12 flex items-center rounded-full p-1">
        <button type="button" className="h-7 w-7 cursor-pointer rounded-full hover:bg-hair" aria-label="Zoom out" onClick={() => api.current.zoom(1 / 1.4)}>
          −
        </button>
        <button type="button" className={`h-7 cursor-pointer rounded-full px-2 hover:bg-hair ${caps}`} onClick={() => api.current.fit(true)}>
          fit
        </button>
        <button type="button" className="h-7 w-7 cursor-pointer rounded-full hover:bg-hair" aria-label="Zoom in" onClick={() => api.current.zoom(1.4)}>
          +
        </button>
      </div>

      {/* Right panel */}
      <AnimatePresence>
        {detail && (
          <m.aside
            key={detail.node.id}
            data-obstacle
            aria-label={detail.node.name}
            initial={motion ? { opacity: 0, x: 36 } : false}
            animate={{ opacity: 1, x: 0 }}
            exit={motion ? { opacity: 0, x: 24, transition: { duration: 0.15 } } : { opacity: 0 }}
            transition={{ type: "spring", stiffness: 170, damping: 26 }}
            className="paper-card absolute inset-x-3 bottom-16 max-h-[55vh] overflow-y-auto p-6 md:inset-x-auto md:bottom-auto md:right-7 md:top-48 md:max-h-[calc(100vh-15.5rem)] md:w-[22rem]"
          >
            <div className="flex items-start gap-3">
              <Icon name={entityIcon(detail.node.tag, detail.node.kind)} size={30} className="mt-1 shrink-0 text-cypress" />
              <div className="min-w-0">
                <p className="label">{detail.node.kind === "opportunity" ? "solicitation" : detail.node.kind}</p>
                <h2 className="mt-1 text-[1.6rem]">{detail.node.name}</h2>
              </div>
              <button type="button" onClick={() => setSelected(null)} aria-label="Close" className="-mr-1 -mt-1 ml-auto cursor-pointer p-1 text-muted hover:text-ink">
                ×
              </button>
            </div>

            {detail.node.kind === "opportunity" ? (
              <dl className="fig mt-4 grid grid-cols-2 gap-y-1">
                <dt className="text-muted">Posted</dt>
                <dd className="text-right">{day(detail.node.posted)}</dd>
                <dt className="text-muted">Closes</dt>
                <dd className="text-right">{day(detail.node.closes)}</dd>
                <dt className="text-muted">Status</dt>
                <dd className="text-right">{detail.node.open ? "Open" : "Closed"}</dd>
              </dl>
            ) : (
              <dl className="fig mt-4 grid grid-cols-2 gap-y-1">
                <dt className="text-muted">Awarded, {WINDOWS.find((w) => w.days === days)?.label}</dt>
                <dd className="text-right text-pompeii">{money(detail.node.total)}</dd>
                <dt className="text-muted">Awards</dt>
                <dd className="text-right">{detail.node.awards}</dd>
                {detail.node.uei && (
                  <>
                    <dt className="text-muted">UEI</dt>
                    <dd className="text-right">{detail.node.uei}</dd>
                  </>
                )}
              </dl>
            )}

            {detail.node.tags.length > 0 && (
              <p className="mt-3 italic text-muted">{detail.node.tags.map(tagLabel).join(", ")}</p>
            )}

            {detail.around.length > 0 && (
              <>
                <p className="label mt-5">Connected to</p>
                <ul className="mt-1">
                  {detail.around.map((a) => (
                    <li key={a.node.id} className="flex items-baseline gap-3 border-b border-hair py-1.5 last:border-0">
                      <button type="button" onClick={() => select(a.node.id)} className="min-w-0 flex-1 cursor-pointer truncate text-left hover:text-cypress">
                        {a.node.name}
                      </button>
                      <span className="fig shrink-0 text-muted">
                        {a.kind === "award" ? money(a.amount) : a.kind.replace("_", " ")}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-2">
              {detail.node.kind === "opportunity" ? (
                detail.node.url && (
                  <a className="marble pill" href={detail.node.url} target="_blank" rel="noreferrer">
                    read the notice ↗
                  </a>
                )
              ) : (
                <>
                  <PinButton
                    entity={{
                      id: Number(detail.node.id.split(":")[1]),
                      name: detail.node.name,
                      tag: detail.node.tag,
                      kind: detail.node.kind,
                    }}
                  />
                  <Link className="marble pill" href={`/entity/${detail.node.id.split(":")[1]}`}>
                    specimen sheet →
                  </Link>
                </>
              )}
            </div>
          </m.aside>
        )}
      </AnimatePresence>
      <span className="sr-only" aria-live="polite">
        {ready && graph ? `${graph.nodes.length} entities, last ${days} days` : "Drawing the map"}
      </span>
    </div>
  );
}
