"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { clientGet, type RecentItem } from "@/lib/api";
import { day, money } from "@/lib/format";
import { toneFor, type Tone } from "@/lib/art";
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

// The flock. Each bird is one recent award (a swallow in the accent, the color
// that always means money) or open solicitation (a swallow in the text color),
// drawn from the engraving pack's 8-frame sprite strips: side views that face
// right, mirrored when a bird heads left. Nearer birds are larger and more
// opaque, farther ones smaller, fainter and a little slower; an award's depth
// follows its dollar amount. Faster birds flap faster, and at random a bird
// holds a glide pose for a second or three. The strips come in two tones, and
// the flock is redrawn in the other one when the mode changes.
//
// Motion is boids (separation, alignment, cohesion) with a gentle pull toward
// the cursor. Flight stays close to level, and birds flow over or under the
// hero's text (elements marked data-flock-avoid). On a wide screen the flock
// keeps to the open sky in the upper right, beside the headline and above the
// village, wheeling back when it reaches the edge of that sky; on a phone,
// where there is no such room, it crosses the whole width. With motion off, a
// few birds hang frozen in a loose V in the hero's open sky.
//
// The flock belongs to the landing page's hero and to nothing else, and it is
// the only thing on the site that moves by itself. It scrolls with the page,
// like the engraving behind it, and it is faded out at the hero's bottom edge,
// so a bird is never drawn over the page below. Over the last 30% of the hero's scroll
// the birds leave: one after another they climb out of the top of the window,
// fanning out and fading as they go. The leaving is drawn on top of the flight,
// as a function of how far the page has scrolled, so it runs backwards exactly
// when the page scrolls back: the same birds come down into the same sky. Once
// the hero is off screen nothing is drawn and the loop stops. No other page has
// birds. The canvas sits between the engraving and the text and never takes
// pointer events itself.

// Flight
const SPEED = 44; // cruising speed of the nearest birds, px/s
const PACE_FAR = 0.76; // the farthest birds cruise at this share of SPEED
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
// The flock's own sky on a wide screen, as shares of the window: birds are
// steered back toward it, more firmly the further out they are.
const HOME = { x0: 0.5, x1: 1.02, y0: 0.13, y1: 0.56 };
const HOME_PULL = 0.5; // px/s2 per px outside the home sky
const HOME_EDGE = 90; // the pull starts this far inside its left and right edges
// Each bird also has its own place in that sky and is drawn back to it, weakly
// along its line of flight and more firmly up and down, so the flock stays
// spread over the sky and each bird patrols a stretch of it.
const PLACE_X = 0.06; // px/s2 per px
const PLACE_Y = 0.25;
const COHESION = 0.1; // boids: pull toward the neighbors' center...
const COHESION_HOME = 0.03; // ...weaker in the home sky, where it would ball the flock up
// Text avoidance
const PAD = 30; // clearance kept around a text block
const LOOK = 260; // a bird starts to rise or sink this far ahead of a block
const LANE = 130; // strength of that steer at the block's edge (px/s2)
const LANE_MIN = 50; // and at the far end of LOOK
const PUSH = 260; // push out of a block a bird is already inside
const NUDGE = 90; // push when a bird is about to enter a block
// Size and depth (0 = far, 1 = near)
const W_MIN = 26;
const W_MAX = 60;
const W_MAX_SMALL = 44; // on phones
const ALPHA_FAR = 0.45; // opacity of the farthest birds...
const ALPHA_NEAR = 0.95; // ...and of the nearest
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
const SMALL = 700;
const HOVER = 34; // pointer distance that picks a bird
const LEAVE_FOR = 0.7; // seconds a clicked bird takes to peel away
// Leaving with the hero
const FOLLOW = 1; // the flock moves up with the scroll, like the engraving: no parallax
const EXIT_FROM = 0.7; // the birds leave over the hero's scroll from here to 1
const EXIT_EASE = 7; // how quickly the drawn exit follows the scroll (1/s): a jump of the page still reads as flight
const EXIT_STAGGER = 0.4; // the last bird starts to leave this far into the exit
const EXIT_CLEAR = 150; // a bird that has left is at least this far above the window, px
const EXIT_SPREAD = 170; // and up to this far to one side of where it was, px
const EXIT_PITCH = 300; // nose-up while climbing, as px/s of climb per unit of exit per second
const EDGE_FADE = 96; // birds dissolve over this many px above the hero's bottom edge
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
  y1: 0.66,
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
    let sprites: Sprites | null = null;
    let tone: Tone | null = null; // the tone `sprites` are in
    let W = 0;
    let H = 0;
    let wMax = W_MAX;
    let birds: Bird[] = [];
    let order: Bird[] = []; // the same birds, far to near, for drawing
    let avoid: Box[] = []; // the hero's text blocks, in document coordinates
    let avoidAt = 0;
    // Where the page is, read once a frame (see readScroll).
    let scrolled = 0; // window.scrollY
    let off = 0; // how far the flock has been carried up with the scene, px
    let exit = 0; // where the scroll puts the exit: 0 in the hero .. 1 gone
    let exitNow = 0; // the exit as drawn: follows `exit` over a few frames
    let exitRate = 0; // its speed, per second (positive while leaving)
    let floor = 1e9; // the hero's bottom edge, in window coordinates
    let heroTop = 0;
    let heroTall = 0;
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

    // The scroll position and what follows from it. Bird positions are kept in
    // the flock's own space, which is the window when the page is at the top
    // and slides up by `off` as the hero scrolls away; everything drawn or
    // compared with the pointer is shifted by it. With motion off the frozen V
    // is laid out in window coordinates and moved by onScroll instead.
    const readScroll = () => {
      scrolled = Math.max(0, window.scrollY);
      if (!heroEl || !heroTall || live.current.path !== "/") {
        off = 0;
        exit = 0;
        exitNow = 0;
        exitRate = 0;
        floor = 1e9;
        return;
      }
      floor = heroTop + heroTall - scrolled;
      if (!live.current.motion) {
        off = 0;
        exit = 0;
        exitNow = 0;
        exitRate = 0;
        return;
      }
      off = scrolled * FOLLOW;
      const t = Math.max(0, Math.min(1, (scrolled / heroTall - EXIT_FROM) / (1 - EXIT_FROM)));
      exit = t * t * (3 - 2 * t);
    };

    const wanted = () => {
      // Only the landing page has birds: the flock lives in the hero.
      if (live.current.path !== "/") return 0;
      const all = itemsRef.current?.length ?? 0;
      if (!live.current.motion) return Math.min(all, W < SMALL ? V.countSmall : V.count);
      return Math.min(all, W < SMALL ? COUNT_SMALL : COUNT);
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
      const entering = item.is_new;
      const a = (Math.random() - 0.5) * 0.7;
      const depth = depthFor(item);
      const pace = PACE_FAR + (1 - PACE_FAR) * depth;
      const gliding = Math.random() < GLIDE_SHARE;
      const vx = Math.cos(a) * SPEED * pace * (0.7 + Math.random() * 0.3);
      const vy = Math.sin(a) * SPEED * pace * 0.5;
      return {
        item,
        idx: i,
        x: entering ? -60 - i * 46 : W < SMALL ? Math.random() * W : W * (HOME.x0 + Math.random() * (HOME.x1 - HOME.x0 - 0.04)),
        y: W < SMALL ? H * (0.12 + Math.random() * 0.5) : H * (HOME.y0 + Math.random() * (HOME.y1 - HOME.y0)),
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
      wMax = W < SMALL ? W_MAX_SMALL : W_MAX;
    };

    const refreshAvoid = (now: number) => {
      if (now - avoidAt < 350) return;
      avoidAt = now;
      watchHero();
      const y = window.scrollY;
      heroTop = heroEl ? heroEl.getBoundingClientRect().top + y : 0;
      heroTall = heroEl ? heroEl.offsetHeight : 0;
      // Only the hero's own words: the birds never reach the rest of the page.
      avoid = heroEl
        ? Array.from(heroEl.querySelectorAll<HTMLElement>("[data-flock-avoid]"))
            .map((el) => el.getBoundingClientRect())
            .filter((r) => r.width > 0)
            .map((r) => ({ left: r.left, right: r.right, top: r.top + y, bottom: r.bottom + y }))
        : [];
      if (birds.length !== wanted()) sync();
    };

    const step = (dt: number) => {
      const n = birds.length;
      // Text scrolls with the page and the flock at FOLLOW of it: this takes a
      // block from document coordinates into the flock's space.
      const shift = off - scrolled;
      const my = mouse.y + off;
      // Wings work harder on the way out and on the way back in.
      const effort = 1 + Math.min(1.6, Math.abs(exitRate) * 1.4);
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
          const pull = W < SMALL ? COHESION : COHESION_HOME;
          ax += (avx / near - b.vx) * 0.5 + (cx / near - b.x) * pull;
          ay += (avy / near - b.vy) * 0.5 + (cy / near - b.y) * pull;
        }
        ay += Math.sin(b.phase * 0.13 + i) * WANDER;
        if (W < SMALL) {
          // A light prevailing wind keeps the flock crossing the sky.
          ax += WIND;
        } else if (!b.entering) {
          // Wheel back toward the open sky in the upper right.
          const x0 = W * HOME.x0 + HOME_EDGE;
          const x1 = W * HOME.x1 - HOME_EDGE;
          if (b.x < x0) ax += (x0 - b.x) * HOME_PULL;
          else if (b.x > x1) ax -= (b.x - x1) * HOME_PULL;
          if (b.y > H * HOME.y1) ay -= (b.y - H * HOME.y1) * HOME_PULL;
          ax += (W * (HOME.x0 + (b.jx + 1) * 0.5 * (HOME.x1 - HOME.x0)) - b.x) * PLACE_X;
          ay += (H * (HOME.y0 + (b.jy + 1) * 0.5 * (HOME.y1 - HOME.y0)) - b.y) * PLACE_Y;
        }
        // Gentle attraction toward the cursor.
        if (mouse.over && exitNow < 0.3) {
          const dx = mouse.x - b.x;
          const dy = my - b.y;
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
          const T = r.top + shift - PAD;
          const B = r.bottom + shift + PAD;
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
        const full = SPEED * b.pace;
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
        const max = cruise * BURST;
        let sp = Math.hypot(b.vx, b.vy);
        if (sp > max) {
          b.vx *= max / sp;
          b.vy *= max / sp;
          sp = max;
        }
        b.x += b.vx * dt;
        b.y += b.vy * dt;

        // A bird that flies in from the left edge is an award that landed today.
        if (b.entering && b.x > 70) b.entering = false;
        if (W < SMALL) {
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
        const busy = exitNow > 0.02 && exitNow < 0.98; // leaving or arriving: nobody glides
        if (busy && b.glide !== null) b.poseT = 0;
        if (b.glide === null) {
          b.frame = (b.frame + dt * SPRITE.fps * (sp / full) * effort) % SPRITE.frames;
          if (b.poseT <= 0 && !busy && Math.floor(b.frame) === GLIDE_FRAME) {
            b.glide = Math.floor(Math.random() * GLIDE_COUNT);
            b.poseT = GLIDE_MIN + Math.random() * (GLIDE_MAX - GLIDE_MIN);
          }
        } else if (b.poseT <= 0) {
          b.glide = null;
          b.frame = GLIDE_FRAME;
          b.poseT = FLAP_MIN + Math.random() * (FLAP_MAX - FLAP_MIN);
        }
      }
    };

    // How far gone one bird is, 0 to 1. The birds do not leave together: each
    // has its own place in the queue (from its fixed jitter), and eases in and
    // out of its own climb.
    const away = (b: Bird) => {
      if (exitNow <= 0) return 0;
      const wait = EXIT_STAGGER * (b.jy + 1) * 0.5;
      const t = Math.max(0, Math.min(1, (exitNow * (1 + EXIT_STAGGER) - wait)));
      return t * t * (3 - 2 * t);
    };
    // The climb that goes with it, in px: enough to carry the bird from where
    // it is on screen to clear above the top of the window.
    const climb = (b: Bird, gone: number) => gone * (Math.max(0, b.y - off) + EXIT_CLEAR);

    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      if (!sprites || resting() || exitNow > 0.999) return;
      ctx.save();
      ctx.translate(0, -off);
      const span = wMax - W_MIN;
      for (let i = 0; i < order.length; i++) {
        const b = order[i];
        if (b.leaving >= LEAVE_FOR) continue;
        const gone = away(b);
        if (gone >= 1) continue;
        pen.x = b.x + b.jx * EXIT_SPREAD * gone;
        pen.y = b.y - climb(b, gone);
        pen.width = W_MIN + span * b.depth;
        pen.vx = b.face * Math.max(Math.abs(b.hx), 0.5);
        // nose up while it climbs away, down while it comes back
        pen.vy = b.hy - (gone > 0 ? exitRate * EXIT_PITCH : 0);
        pen.frame = b.frame;
        pen.award = b.item.kind === "award";
        pen.alpha =
          (ALPHA_FAR + (ALPHA_NEAR - ALPHA_FAR) * b.depth) * (b.leaving < 0 ? 1 : 1 - b.leaving / LEAVE_FOR) * (1 - gone);
        pen.glide = gone > 0 ? null : b.glide;
        drawSwallow(ctx, sprites, pen);
      }
      ctx.restore();
      // The scene ends at the hero's bottom edge. So do the birds: rub them
      // out toward that edge and wholly below it.
      if (floor < H + EDGE_FADE) {
        const top = floor - EDGE_FADE;
        const g = ctx.createLinearGradient(0, top, 0, floor);
        g.addColorStop(0, "rgba(0,0,0,0)");
        g.addColorStop(1, "rgba(0,0,0,1)");
        ctx.globalCompositeOperation = "destination-out";
        ctx.fillStyle = g;
        ctx.fillRect(0, top, W, Math.max(0, H - top));
        ctx.globalCompositeOperation = "source-over";
      }
    };

    const hover = () => {
      let best: Bird | null = null;
      let bd = HOVER;
      // A bird can be picked while it is in the hero and not on its way out.
      if (mouse.over && sprites && !resting() && exitNow < 0.3 && mouse.y < floor - EDGE_FADE * 0.5) {
        for (const b of birds) {
          if (away(b) > 0) continue;
          const d = Math.hypot(b.x - mouse.x, b.y - off - mouse.y);
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
        tip.style.transform = `translate(${x}px, ${Math.max(hovered.y - off - w * 0.5 - 26, 8)}px)`;
      }
    };

    const frame = (now: number) => {
      if (!alive) return;
      const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
      last = now;
      refreshAvoid(now);
      readScroll();
      const was = exitNow;
      exitNow += (exit - exitNow) * (1 - Math.exp(-dt * EXIT_EASE));
      if (Math.abs(exit - exitNow) < 0.0005) exitNow = exit;
      exitRate = (exitNow - was) / dt;
      step(dt);
      hover();
      draw();
      if (!live.current.motion || document.hidden) raf = 0;
      else if (birds.length) raf = requestAnimationFrame(frame);
      else raf = 0; // nothing to draw: no loop
    };

    // Motion off on the landing page: a loose V heading right, placed in the
    // open sky of the hero (or over the far hills), clear of the text, the
    // village and the navigation. It scrolls with the hero.
    const layoutV = () => {
      const n = order.length;
      if (!n) return;
      const hr = heroEl?.isConnected ? heroEl.getBoundingClientRect() : null;
      const top = hr ? hr.top : -window.scrollY;
      const tall = hr ? hr.height : H;
      const boxes: Box[] = [{ left: -1e5, right: 1e5, top: top - 1e5, bottom: top + V.nav }];
      heroEl?.querySelectorAll<HTMLElement>("[data-flock-avoid]").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.bottom > top && r.top < top + tall)
          boxes.push({ left: r.left - V.clear, right: r.right + V.clear, top: r.top - V.clear, bottom: r.bottom + V.clear });
      });
      // Still birds over the village's roofs and trees are lost in the drawing.
      heroEl?.querySelectorAll<HTMLElement>("[data-flock-village]").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0) boxes.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
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
      const pageY = window.scrollY;
      for (let k = 0; k < n; k++) {
        const b = order[n - 1 - k]; // the nearest bird leads
        const rank = (k + 1) >> 1;
        const side = k & 1 ? -1 : 1;
        b.x = leadX - rank * gapX + b.jx * gapX * V.loose;
        b.y = leadY + side * rank * gapY + b.jy * gapY * V.loose;
        b.docY = b.y + pageY;
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

    // Reduced motion / still: lay the birds out in the V, then draw one frame.
    const settle = () => {
      avoidAt = 0;
      refreshAvoid(performance.now());
      readScroll();
      layoutV();
      frozen = true;
      hover();
      draw();
    };

    let resettle = 0;
    kick.current = () => {
      avoidAt = 0;
      cancelAnimationFrame(raf);
      clearTimeout(resettle);
      raf = 0;
      frozen = false;
      refreshAvoid(performance.now());
      readScroll();
      sync(true);
      if (!sprites || !birds.length || resting()) {
        // Nothing to show yet, another page, or the hero is off screen: an
        // empty canvas and no loop. When the hero comes back the birds start
        // from gone and fly in, however the page got there.
        if (resting() && live.current.motion) exitNow = 1;
        exitRate = 0;
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
        readScroll();
        for (const b of birds) b.y = b.docY - scrolled;
        hover();
        draw();
      });
    };
    // No birds are drawn until the sprites are in. If they fail to load, none
    // are. The strips are drawn for one mode, so a change of mode loads the
    // other tone; the birds keep flying in the old one until it arrives.
    const loadTone = () => {
      const want = toneFor(document.documentElement.dataset.theme === "paper" ? "paper" : "dark");
      if (want === tone) return;
      tone = want;
      loadSprites(want).then(
        (s) => {
          if (!alive || tone !== want) return;
          sprites = s;
          kick.current();
        },
        () => {
          /* no sprites: the page still works without the flock */
          if (tone === want) tone = null;
        },
      );
    };
    const onTheme = () => loadTone();
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

    loadTone();

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
        className="pointer-events-none fixed inset-0 z-10 h-full w-full"
      />
      <div
        ref={tipRef}
        role="status"
        className="tip left-0 top-0 opacity-0 transition-opacity duration-200"
        style={{ position: "fixed" }}
      />
    </>
  );
}
