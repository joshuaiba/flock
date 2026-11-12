"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { clientGet, type RecentItem } from "@/lib/api";
import { day, money } from "@/lib/format";
import { drawBloom, readPalette, type Bloom } from "@/lib/paint";
import {
  drawSwallow,
  GLIDE_COUNT,
  GLIDE_FRAME,
  loadSprites,
  SPRITE,
  type Sprites,
  type Swallow,
} from "@/lib/sprites";
import { useStore } from "@/lib/store";

// The flock. Each bird is one recent award (the warm swallow with the
// terracotta throat) or open solicitation (the pale swallow), drawn from the
// art pack's 8-frame sprite strips: side views that face right, mirrored when a
// bird heads left. Nearer birds are larger and more opaque, farther ones
// smaller, fainter and a little slower; an award's depth follows its dollar
// amount. Faster birds flap faster, and at random a bird holds a glide pose for
// a second or three.
//
// Motion is boids (separation, alignment, cohesion) with a gentle pull toward
// the cursor. Flight stays close to level, and birds flow over or under text
// blocks (elements marked data-flock-avoid). With motion off, a few birds hang
// frozen in a loose V in the hero's open sky. The canvas sits between the
// painted ground and the text, never takes pointer events itself, and rests
// while the hero is off screen or the tab is hidden.

// Flight
const SPEED = 44; // cruising speed of the nearest birds, px/s
const PACE_FAR = 0.76; // the farthest birds cruise at this share of SPEED
const CALM_PACE = 0.6; // birds in the margins of a data page drift at this share
const BURST = 1.3; // top speed, relative to a bird's own cruising speed
const DRIVE = 0.4; // how firmly a bird returns to cruising speed (1/s)
const WIND = 2; // prevailing push to the right on the landing page (px/s2)
const WANDER = 10; // slow vertical wander on the landing page (px/s2)
const VY_LIMIT = 0.45; // |vy| limit as a share of cruising speed: about 25 degrees
const VY_STEER = 0.72; // the same limit while a bird is routing around text
const VY_DAMP = 0.5; // pull back to level flight (1/s)
const NEIGHBOR = 120; // boids: how far a bird sees
const SEPARATION = 54; // boids: closer than this, birds push apart
const TURN = 6; // how fast the drawn heading follows the velocity (1/s)
const FLIP_AT = 3; // px/s past zero before the sprite mirrors (stops flicker)
// Text avoidance
const PAD = 30; // clearance kept around a text block
const LOOK = 260; // a bird starts to rise or sink this far ahead of a block
const LANE = 130; // strength of that steer at the block's edge (px/s2)
const LANE_MIN = 50; // and at the far end of LOOK
const PUSH = 260; // push out of a block a bird is already inside
const NUDGE = 90; // push when a bird is about to enter a block
// Size and depth (0 = far, 1 = near)
const W_MIN = 28;
const W_MAX = 56;
const W_MAX_SMALL = 44; // on phones and in the margins of data pages
const ALPHA_FAR = 0.55; // opacity of the farthest birds; the nearest are opaque
// Wing beats and glides
const GLIDE_MIN = 1;
const GLIDE_MAX = 3;
const FLAP_MIN = 2.2;
const FLAP_MAX = 7.2;
// The share of birds gliding at any moment (0.3 with the durations above).
const GLIDE_SHARE = (GLIDE_MIN + GLIDE_MAX) / (GLIDE_MIN + GLIDE_MAX + FLAP_MIN + FLAP_MAX);
// Counts
const COUNT = 60;
const COUNT_SMALL = 22; // viewports narrower than SMALL
const COUNT_MARGIN = 12;
const SMALL = 700;
const HOVER = 34; // pointer distance that picks a bird
const LEAVE_FOR = 0.7; // seconds a clicked bird takes to peel away
// The frozen V shown when motion is off. Positions are shares of the window
// width and of the hero's height; lengths are in px.
const V = {
  count: 11,
  countSmall: 8,
  x: 0.64, // preferred place for the lead bird
  y: 0.3,
  x0: 0.3, // where the lead bird may go
  x1: 0.9,
  y0: 0.16,
  y1: 0.6,
  cols: 13, // grid of places tried
  rows: 9,
  dx: 0.046, // gap between ranks, as a share of the window width...
  dxMin: 34, // ...within these limits
  dxMax: 64,
  slope: 0.44, // each rank sits this far above or below the last, relative to dx
  shrink: [1, 0.8, 0.64], // tighter spacings tried when there is no clear place
  loose: 0.3, // jitter, relative to the spacing
  tilt: 0.1, // variation in pitch
  margin: 40, // room around the formation for the birds themselves
  clear: 20, // clearance from text
  nav: 88, // height kept free under the top of the hero for the navigation
  chainW: 230, // top-right corner kept free for the watchlist chain
  chainH: 320,
};

type Box = { left: number; right: number; top: number; bottom: number };

type Bird = {
  item: RecentItem;
  idx: number; // position in the fetched list
  x: number;
  y: number;
  vx: number;
  vy: number;
  hx: number; // smoothed velocity: the heading the sprite is drawn with
  hy: number;
  face: number; // 1 right, -1 left
  depth: number; // 0 far .. 1 near
  pace: number; // cruising speed relative to SPEED
  frame: number; // position in the sprite strip
  glide: number | null; // glide pose held, or null while flapping
  poseT: number; // seconds until the bird next changes between flapping and gliding
  phase: number; // wander clock
  jx: number; // fixed jitter in -1..1, for the frozen formation
  jy: number;
  docY: number; // y in the document, for the frozen formation
  slow: number; // 0..1, eases in while hovered
  entering: boolean;
  leaving: number; // seconds since clicked, -1 when not leaving
  fresh: boolean; // just spawned: not yet settled beside a data page
};

/** Bigger awards fly nearer (log scale, $100k far to $1B near); solicitations keep to the middle distance. */
function depthFor(item: RecentItem): number {
  if (item.kind !== "award") return 0.12 + Math.random() * 0.43;
  const amount = item.amount ?? 0;
  const size = amount > 0 ? Math.max(0, Math.min(1, (Math.log10(amount) - 5) / 4)) : 0.25;
  return Math.max(0, Math.min(1, 0.1 + 0.8 * size + (Math.random() - 0.5) * 0.24));
}

function label(item: RecentItem): string {
  const who = item.org_name ?? item.agency_name ?? "Unknown";
  if (item.kind === "award") return `${who} · ${money(item.amount)} · ${day(item.day, true)}`;
  return `${who} · open solicitation · ${day(item.day, true)}`;
}

export function Flock() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const path = usePathname();
  const router = useRouter();
  const { motion } = useStore();

  // Values the animation loop reads without restarting.
  const live = useRef({ path, motion, router });
  live.current = { path, motion, router };
  const itemsRef = useRef<RecentItem[] | null>(null);
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current!;
    const tip = tipRef.current!;
    const ctx = canvas.getContext("2d")!;
    let palette = readPalette();
    let sprites: Sprites | null = null;
    let W = 0;
    let H = 0;
    let wMax = W_MAX;
    let birds: Bird[] = [];
    let order: Bird[] = []; // the same birds, far to near, for drawing
    const ripples: Bloom[] = [];
    let avoid: Box[] = [];
    let avoidAt = 0;
    let column: { left: number; right: number } | null = null;
    const calm = () => live.current.path !== "/";
    const mouse = { x: -999, y: -999, over: false };
    let hovered: Bird | null = null;
    let raf = 0;
    let last = 0;
    let alive = true;
    let frozen = false; // the still formation is on screen
    let scrollTick = 0;
    // One scratch object handed to drawSwallow for every bird.
    const pen: Swallow = { x: 0, y: 0, width: W_MIN, vx: 1, vy: 0, frame: 0, award: true, alpha: 1, glide: null };

    // The landing page's hero: the flock rests while it is off screen.
    let heroEl: HTMLElement | null = null;
    let heroOn = true;
    const resting = () => live.current.path === "/" && !heroOn;
    const io =
      "IntersectionObserver" in window
        ? new IntersectionObserver((entries) => {
            if (!alive) return;
            for (const e of entries) {
              if (e.target !== heroEl || !heroEl.isConnected || e.isIntersecting === heroOn) continue;
              heroOn = e.isIntersecting;
              kick.current();
            }
          })
        : null;
    // The hero can mount a moment after the route changes, so this is called
    // again from the loop until it is found.
    const watchHero = () => {
      if (live.current.path !== "/") {
        if (heroEl) io?.unobserve(heroEl);
        heroEl = null;
        heroOn = true;
        return;
      }
      if (heroEl?.isConnected) return;
      if (heroEl) io?.unobserve(heroEl);
      heroEl = document.getElementById("hero");
      heroOn = true;
      if (heroEl) io?.observe(heroEl);
    };

    const wanted = () => {
      const p = live.current.path;
      if (p.startsWith("/graph")) return 0; // the graph draws its own birds along edges
      const all = itemsRef.current?.length ?? 0;
      if (p === "/") {
        if (!live.current.motion) return Math.min(all, W < SMALL ? V.countSmall : V.count);
        return Math.min(all, W < SMALL ? COUNT_SMALL : COUNT);
      }
      // Data screens stay calm: a few birds, kept to the margins beside the page.
      return column && column.left >= 110 ? Math.min(all, COUNT_MARGIN) : 0;
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const spawn = (item: RecentItem, i: number): Bird => {
      const entering = item.is_new && !calm();
      const a = (Math.random() - 0.5) * 0.7;
      const depth = depthFor(item);
      const pace = PACE_FAR + (1 - PACE_FAR) * depth;
      const gliding = Math.random() < GLIDE_SHARE;
      const vx = Math.cos(a) * SPEED * pace * (0.7 + Math.random() * 0.3);
      const vy = Math.sin(a) * SPEED * pace * 0.5;
      return {
        item,
        idx: i,
        x: calm()
          ? (i % 2 ? W - 20 - Math.random() * ((column?.left ?? 120) - 40) : 20 + Math.random() * ((column?.left ?? 120) - 40))
          : entering
            ? -60 - i * 46
            : Math.random() * W,
        y: H * (0.12 + Math.random() * 0.5),
        vx,
        vy,
        hx: vx,
        hy: vy,
        face: 1,
        depth,
        pace,
        frame: Math.random() * SPRITE.frames,
        glide: gliding ? Math.floor(Math.random() * GLIDE_COUNT) : null,
        poseT: gliding
          ? Math.random() * GLIDE_MAX
          : Math.random() * FLAP_MAX,
        phase: Math.random() * 6.28,
        jx: Math.random() * 2 - 1,
        jy: Math.random() * 2 - 1,
        docY: 0,
        slow: 0,
        entering,
        leaving: -1,
        fresh: true,
      };
    };

    const reorder = () => {
      order = birds.slice().sort((a, b) => a.depth - b.depth);
    };

    // Bird i is item i. `revive` also replaces birds that have flown off after a click.
    const sync = (revive = false) => {
      const items = itemsRef.current ?? [];
      const n = wanted();
      let k = 0;
      let changed = false;
      for (let i = 0; i < birds.length; i++) {
        const b = birds[i];
        if (b.idx >= n) continue;
        if (revive && b.leaving >= LEAVE_FOR) {
          birds[k++] = spawn(b.item, b.idx);
          changed = true;
        } else birds[k++] = b;
      }
      if (k !== birds.length) changed = true;
      birds.length = k;
      if (k < n) {
        const have = new Set<number>();
        for (const b of birds) have.add(b.idx);
        for (let i = 0; i < n; i++) if (!have.has(i)) birds.push(spawn(items[i], i));
        changed = true;
      }
      if (changed) reorder();
      wMax = W < SMALL || calm() ? W_MAX_SMALL : W_MAX;
      canvas.style.opacity = live.current.path === "/" ? "1" : "0.75";
    };

    const refreshAvoid = (now: number) => {
      if (now - avoidAt < 350) return;
      avoidAt = now;
      watchHero();
      avoid = Array.from(document.querySelectorAll<HTMLElement>("[data-flock-avoid]"))
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.bottom > -60 && r.top < H + 60 && r.width > 0);
      const col = calm() ? document.querySelector<HTMLElement>("[data-flock-column]") : null;
      const r = col?.getBoundingClientRect();
      column = r ? { left: r.left, right: r.right } : null;
      if (column) avoid.push({ left: column.left, right: column.right, top: -1e5, bottom: 1e5 });
      if (birds.length !== wanted()) sync();
    };

    const step = (dt: number) => {
      const n = birds.length;
      const quiet = calm();
      const turn = Math.min(1, dt * TURN);
      const ease = Math.min(1, dt * 6);
      for (let i = 0; i < n; i++) {
        const b = birds[i];
        if (b.leaving >= 0) {
          if (b.leaving >= LEAVE_FOR) continue; // gone, until the route changes
          // Peel off: climb away toward the top of the page.
          b.leaving += dt;
          b.vx += (W / 2 - b.x) * 3 * dt;
          b.vy += (-80 - b.y) * 3 * dt;
          b.x += b.vx * dt;
          b.y += b.vy * dt;
          b.hx = b.vx;
          b.hy = b.vy;
          b.face = b.vx < 0 ? -1 : 1;
          b.glide = null;
          b.frame = (b.frame + dt * SPRITE.fps * 1.6) % SPRITE.frames;
          continue;
        }
        let ax = 0;
        let ay = 0;
        let sx = 0;
        let sy = 0;
        let cx = 0;
        let cy = 0;
        let avx = 0;
        let avy = 0;
        let near = 0;
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const o = birds[j];
          if (o.leaving >= 0) continue;
          const dx = o.x - b.x;
          const dy = o.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > NEIGHBOR * NEIGHBOR) continue;
          const d = Math.sqrt(d2) || 1;
          if (d < SEPARATION) {
            sx -= (dx / d) * (SEPARATION - d);
            sy -= (dy / d) * (SEPARATION - d);
          }
          cx += o.x;
          cy += o.y;
          avx += o.vx;
          avy += o.vy;
          near++;
        }
        ax += sx * 1.5;
        ay += sy * 1.5;
        if (near) {
          ax += (avx / near - b.vx) * 0.5 + (cx / near - b.x) * 0.1;
          ay += (avy / near - b.vy) * 0.5 + (cy / near - b.y) * 0.1;
        }
        let inside = false;
        if (quiet) {
          // No wind beside a data page: wander, and turn back at the window edge.
          ax += Math.cos(b.phase * 0.11 + i * 1.7) * 7;
          ay += Math.sin(b.phase * 0.13 + i) * 9;
          if (b.x < 24) ax += (24 - b.x) * 2;
          if (b.x > W - 24) ax -= (b.x - (W - 24)) * 2;
          inside = !!column && b.x > column.left && b.x < column.right;
        } else {
          // A light prevailing wind keeps the flock crossing the sky.
          ax += WIND;
          ay += Math.sin(b.phase * 0.13 + i) * WANDER;
        }
        // Gentle attraction toward the cursor.
        if (mouse.over) {
          const dx = mouse.x - b.x;
          const dy = mouse.y - b.y;
          const d = Math.hypot(dx, dy);
          if (d > 30 && d < 340) {
            ax += (dx / d) * 14;
            ay += (dy / d) * 14;
          }
        }
        // Route around text. Flight is close to level, so a bird that has a
        // block ahead in its lane starts early and flows over or under it.
        let steer = false;
        for (let k = 0; k < avoid.length; k++) {
          const r = avoid[k];
          const L = r.left - PAD;
          const R = r.right + PAD;
          const T = r.top - PAD;
          const B = r.bottom + PAD;
          const wall = B - T > 1e4; // the page column: no way over or under
          const noUp = T < 56;
          const noDown = B > H - 56;
          if (b.x > L && b.x < R && b.y > T && b.y < B) {
            // Already inside: out by the nearest edge that leads somewhere.
            const dl = b.x - L;
            const dr = R - b.x;
            const du = noUp && !noDown ? 1e9 : b.y - T;
            const dd = noDown && !noUp ? 1e9 : B - b.y;
            const m = Math.min(dl, dr, du, dd);
            if (m === du) ay -= PUSH;
            else if (m === dd) ay += PUSH;
            else if (m === dl) ax -= PUSH;
            else ax += PUSH;
            steer = true;
          } else if (wall) {
            const px = b.x + b.vx * 0.9;
            if (px > L && px < R) ax += b.x <= L ? -NUDGE : NUDGE;
          } else if (b.y > T && b.y < B) {
            const gap = b.vx >= 0 ? L - b.x : b.x - R;
            if (gap > 0 && gap < LOOK) {
              let up = b.y < (T + B) / 2;
              if (noUp && !noDown) up = false;
              else if (noDown && !noUp) up = true;
              ay += (up ? -1 : 1) * (LANE_MIN + (LANE - LANE_MIN) * (1 - gap / LOOK));
              steer = true;
            }
          } else {
            // Above or below a block and about to drop into it.
            const px = b.x + b.vx * 0.9;
            const py = b.y + b.vy * 0.9;
            if (px > L && px < R && py > T && py < B) ay += b.y <= T ? -NUDGE : NUDGE;
          }
        }
        // Stay in the sky.
        if (b.y < 50) ay += (50 - b.y) * 1.2;
        if (b.y > H - 50) ay -= (b.y - (H - 50)) * 1.2;

        b.slow += ((b === hovered ? 1 : 0) - b.slow) * ease;
        const full = SPEED * b.pace * (quiet ? CALM_PACE : 1);
        const cruise = full * (1 - 0.85 * b.slow);
        // Hold cruising speed in whichever direction the bird is heading, and
        // come back to level flight.
        ax += ((b.vx < 0 ? -cruise : cruise) - b.vx) * DRIVE;
        ay -= b.vy * VY_DAMP;

        b.vx += ax * dt;
        b.vy += ay * dt;
        const lim = cruise * (steer ? VY_STEER : VY_LIMIT);
        if (b.vy > lim) b.vy = lim;
        else if (b.vy < -lim) b.vy = -lim;
        const max = cruise * (inside ? 5 : BURST);
        let sp = Math.hypot(b.vx, b.vy);
        if (sp > max) {
          b.vx *= max / sp;
          b.vy *= max / sp;
          sp = max;
        }
        b.x += b.vx * dt;
        b.y += b.vy * dt;

        if (b.entering && b.x > 70) {
          // A bird joining the flock means a new award landed today.
          b.entering = false;
          ripples.push({ x: b.x, y: b.y, t: 0 });
        }
        if (!quiet) {
          if (b.x > W + 50) b.x = -50;
          if (b.x < -50 && !b.entering) b.x = W + 50;
        }

        // The drawn heading trails the velocity, and mirrors once it has clearly turned.
        b.hx += (b.vx - b.hx) * turn;
        b.hy += (b.vy - b.hy) * turn;
        if (b.hx * b.face < -FLIP_AT) b.face = -b.face;
        b.phase += dt * 10;

        // Wing beats follow speed. Now and then, hold a glide for a moment; a
        // glide starts from the frame where the wings are flattest.
        b.poseT -= dt;
        if (b.glide === null) {
          b.frame = (b.frame + dt * SPRITE.fps * (sp / full)) % SPRITE.frames;
          if (b.poseT <= 0 && Math.floor(b.frame) === GLIDE_FRAME) {
            b.glide = Math.floor(Math.random() * GLIDE_COUNT);
            b.poseT = GLIDE_MIN + Math.random() * (GLIDE_MAX - GLIDE_MIN);
          }
        } else if (b.poseT <= 0) {
          b.glide = null;
          b.frame = GLIDE_FRAME;
          b.poseT = FLAP_MIN + Math.random() * (FLAP_MAX - FLAP_MIN);
        }
      }
      for (let i = 0; i < ripples.length; i++) ripples[i].t += dt;
    };

    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      if (!sprites || resting()) return;
      let kept = 0;
      for (let i = 0; i < ripples.length; i++) {
        if (drawBloom(ctx, ripples[i], palette.terracotta)) ripples[kept++] = ripples[i];
      }
      ripples.length = kept;
      const span = wMax - W_MIN;
      for (let i = 0; i < order.length; i++) {
        const b = order[i];
        if (b.leaving >= LEAVE_FOR) continue;
        pen.x = b.x;
        pen.y = b.y;
        pen.width = W_MIN + span * b.depth;
        pen.vx = b.face * Math.max(Math.abs(b.hx), 0.5);
        pen.vy = b.hy;
        pen.frame = b.frame;
        pen.award = b.item.kind === "award";
        pen.alpha = (ALPHA_FAR + (1 - ALPHA_FAR) * b.depth) * (b.leaving < 0 ? 1 : 1 - b.leaving / LEAVE_FOR);
        pen.glide = b.glide;
        drawSwallow(ctx, sprites, pen);
      }
    };

    const hover = () => {
      let best: Bird | null = null;
      let bd = HOVER;
      if (mouse.over && sprites && !resting()) {
        for (const b of birds) {
          const d = Math.hypot(b.x - mouse.x, b.y - mouse.y);
          if (d < bd && b.leaving < 0) {
            bd = d;
            best = b;
          }
        }
      }
      if (best !== hovered) {
        hovered = best;
        tip.textContent = best ? label(best.item) : "";
        tip.style.opacity = best ? "1" : "0";
        document.documentElement.style.cursor = best ? "pointer" : "";
      }
      if (hovered) {
        const w = W_MIN + (wMax - W_MIN) * hovered.depth;
        const x = Math.min(Math.max(hovered.x + w * 0.5 + 6, 8), W - tip.offsetWidth - 8);
        tip.style.transform = `translate(${x}px, ${Math.max(hovered.y - w * 0.5 - 26, 8)}px)`;
      }
    };

    const frame = (now: number) => {
      if (!alive) return;
      const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
      last = now;
      refreshAvoid(now);
      step(dt);
      hover();
      draw();
      if (!live.current.motion || document.hidden) raf = 0;
      else if (birds.length || ripples.length) raf = requestAnimationFrame(frame);
      else {
        raf = 0; // nothing to draw: no loop
        // A data page's column can land late, so look again now and then.
        if (calm() && !live.current.path.startsWith("/graph") && itemsRef.current?.length)
          resettle = window.setTimeout(() => kick.current(), 1000);
      }
    };

    // Motion off on the landing page: a loose V heading right, placed in the
    // open sky of the hero, clear of the text, the navigation and the corner
    // where the watchlist chain hangs. It scrolls with the hero.
    const layoutV = () => {
      const n = order.length;
      if (!n) return;
      const hr = heroEl?.isConnected ? heroEl.getBoundingClientRect() : null;
      const top = hr ? hr.top : -window.scrollY;
      const tall = hr ? hr.height : H;
      const boxes: Box[] = [
        { left: -1e5, right: 1e5, top: top - 1e5, bottom: top + V.nav },
        { left: W - (W < SMALL ? V.chainW * 0.6 : V.chainW), right: 1e5, top: top - 1e5, bottom: top + V.chainH },
      ];
      document.querySelectorAll<HTMLElement>("[data-flock-avoid]").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.bottom > top && r.top < top + tall)
          boxes.push({ left: r.left - V.clear, right: r.right + V.clear, top: r.top - V.clear, bottom: r.bottom + V.clear });
      });
      const ranks = Math.ceil((n - 1) / 2);
      const wantX = W * V.x;
      const wantY = top + tall * V.y;
      let bestOver = Infinity;
      let bestFar = Infinity;
      let leadX = wantX;
      let leadY = wantY;
      let gapX = 0;
      let gapY = 0;
      for (const shrink of V.shrink) {
        const dx = Math.max(V.dxMin, Math.min(V.dxMax, W * V.dx)) * shrink;
        const dy = dx * V.slope;
        const back = ranks * dx + V.margin;
        const half = ranks * dy + V.margin;
        for (let i = 0; i < V.cols; i++) {
          const cx = W * (V.x0 + ((V.x1 - V.x0) * i) / (V.cols - 1));
          for (let j = 0; j < V.rows; j++) {
            const cy = top + tall * (V.y0 + ((V.y1 - V.y0) * j) / (V.rows - 1));
            const l = cx - back;
            const r = cx + V.margin;
            const t = cy - half;
            const b = cy + half;
            // Area of the formation that is off the window or over something.
            let over = 0;
            if (l < 0) over += -l * (b - t);
            if (r > W) over += (r - W) * (b - t);
            for (const o of boxes) {
              const w = Math.min(r, o.right) - Math.max(l, o.left);
              const h = Math.min(b, o.bottom) - Math.max(t, o.top);
              if (w > 0 && h > 0) over += w * h;
            }
            const far = Math.hypot(cx - wantX, cy - wantY);
            if (over < bestOver || (over === bestOver && far < bestFar)) {
              bestOver = over;
              bestFar = far;
              leadX = cx;
              leadY = cy;
              gapX = dx;
              gapY = dy;
            }
          }
        }
        if (bestOver === 0) break; // a clear place at this spacing
      }
      const scrolled = window.scrollY;
      for (let k = 0; k < n; k++) {
        const b = order[n - 1 - k]; // the nearest bird leads
        const rank = (k + 1) >> 1;
        const side = k & 1 ? -1 : 1;
        b.x = leadX - rank * gapX + b.jx * gapX * V.loose;
        b.y = leadY + side * rank * gapY + b.jy * gapY * V.loose;
        b.docY = b.y + scrolled;
        b.vx = SPEED * b.pace;
        b.vy = b.vx * b.jx * V.tilt;
        b.hx = b.vx;
        b.hy = b.vy;
        b.face = 1;
        b.slow = 0;
        b.entering = false;
        b.leaving = -1;
      }
    };

    // Reduced motion / still: lay the birds out, then draw one frame. On the
    // landing page that is the V; beside a data page the flock is settled
    // off-screen first.
    const settle = () => {
      avoidAt = 0;
      refreshAvoid(performance.now());
      if (calm()) {
        // Warm up only when the window, the column or the birds have changed:
        // a repeat call just redraws, so settled birds do not jump.
        const key = `${W}|${H}|${column?.left}|${column?.right}`;
        if (key !== settledKey || birds.some((b) => b.fresh)) {
          for (const b of birds) if (b.entering) (b.entering = false), (b.x = Math.random() * W);
          for (let i = 0; i < 160; i++) step(1 / 30);
          for (const b of birds) b.fresh = false;
          settledKey = key;
        }
      } else {
        layoutV();
        frozen = true;
      }
      ripples.length = 0;
      hover();
      draw();
    };

    let resettle = 0;
    let settledKey = ""; // the geometry the calm flock was last settled for
    kick.current = () => {
      avoidAt = 0;
      cancelAnimationFrame(raf);
      clearTimeout(resettle);
      raf = 0;
      frozen = false;
      watchHero();
      sync(true);
      if (!sprites || resting()) {
        // Nothing to show yet, or the hero is off screen: an empty canvas, no loop.
        ripples.length = 0;
        hover();
        draw();
        return;
      }
      if (live.current.motion) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      } else {
        settle();
        // The next page's layout may land a moment after the route changes.
        resettle = window.setTimeout(settle, 700);
      }
    };

    const interactive = (t: EventTarget | null) =>
      t instanceof Element && !!t.closest("a,button,input,select,textarea,[data-flock-ignore]");

    const onMove = (e: PointerEvent) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      mouse.over = e.pointerType !== "touch" && !interactive(e.target);
      if (!raf) hover();
    };
    const onLeave = () => {
      mouse.over = false;
      if (!raf) hover();
    };
    const onClick = (e: MouseEvent) => {
      if (!hovered || interactive(e.target)) return;
      const b = hovered;
      // An award bird opens its recipient's page. A solicitation opens the graph
      // on its node, and an award with no recipient has no page or node to land
      // on, so it opens the graph as it is.
      const item = b.item;
      const to =
        item.kind !== "award"
          ? `/graph?focus=${encodeURIComponent(`opp:${item.id}`)}`
          : item.org_id == null
            ? "/graph"
            : `/entity/${item.org_id}`;
      // Already on that page: the bird stays where it is. Sending it off would
      // lose it until the next change of page, for a link that leads nowhere new.
      if (to === live.current.path) return;
      const go = () => live.current.router.push(to);
      hovered = null;
      tip.style.opacity = "0";
      document.documentElement.style.cursor = "";
      if (raf) {
        // The bird peels away, then the page opens.
        ripples.push({ x: b.x, y: b.y, t: 0 });
        b.leaving = 0;
        setTimeout(go, 520);
      } else go();
    };
    const onResize = () => {
      resize();
      kick.current();
    };
    // The frozen formation belongs to the hero, so it moves with the page.
    const onScroll = () => {
      if (!frozen || raf || scrollTick) return;
      scrollTick = requestAnimationFrame(() => {
        scrollTick = 0;
        if (!frozen || raf) return;
        const scrolled = window.scrollY;
        for (const b of birds) b.y = b.docY - scrolled;
        hover();
        draw();
      });
    };
    const onTheme = () => {
      palette = readPalette();
      if (!raf) draw();
    };
    const onVisible = () => {
      if (!document.hidden) kick.current();
    };

    resize();
    window.addEventListener("pointermove", onMove);
    document.documentElement.addEventListener("pointerleave", onLeave);
    window.addEventListener("click", onClick);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("flock:theme", onTheme);
    document.addEventListener("visibilitychange", onVisible);

    // No birds are drawn until the sprites are in. If they fail to load, none are.
    loadSprites().then(
      (s) => {
        if (!alive) return;
        sprites = s;
        kick.current();
      },
      () => {
        /* no sprites: the page still works without the flock */
      },
    );

    const ac = new AbortController();
    clientGet<RecentItem[]>(`recent?limit=${COUNT}`, ac.signal)
      .then((items) => {
        itemsRef.current = items;
        kick.current();
      })
      .catch(() => {
        /* no data service: the page still works without the flock */
      });

    return () => {
      alive = false;
      clearTimeout(resettle);
      ac.abort();
      io?.disconnect();
      cancelAnimationFrame(raf);
      cancelAnimationFrame(scrollTick);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("click", onClick);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("flock:theme", onTheme);
      document.removeEventListener("visibilitychange", onVisible);
      document.documentElement.style.cursor = "";
    };
  }, []);

  // Density follows the screen; still/moving restarts the loop.
  useEffect(() => {
    kick.current();
  }, [path, motion]);

  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-10 h-full w-full transition-opacity duration-700"
      />
      <div
        ref={tipRef}
        role="status"
        className="fig paper-card pointer-events-none fixed left-0 top-0 z-30 whitespace-nowrap px-3 py-1 opacity-0 !shadow-none transition-opacity duration-200"
      />
    </>
  );
}
