"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { clientGet, type RecentItem } from "@/lib/api";
import { day, money } from "@/lib/format";
import { drawBird, drawBloom, readPalette, type Bloom } from "@/lib/paint";
import { useStore } from "@/lib/store";

// The murmuration. Each bird is one recent award (warm: terracotta, or faded
// red for the largest) or open solicitation (pale), painted as a small
// brushstroke swallow. Classic boids (separation, alignment, cohesion) with a
// gentle pull toward the cursor and an avoidance zone around text blocks
// (elements marked data-flock-avoid). The canvas sits between the painted
// ground and the text, and never takes pointer events itself.

type Bird = {
  item: RecentItem;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  phase: number;
  scale: number;
  slow: number; // 0..1, eases in while hovered
  entering: boolean;
  leaving: number; // seconds since clicked, -1 when not leaving
};

const SPEED = 44;
const MIN_SPEED = 16;

function scaleFor(item: RecentItem): number {
  if (item.kind !== "award" || !item.amount) return 0.95;
  return Math.max(0.9, Math.min(1.6, 0.9 + (Math.log10(item.amount) - 5) * 0.17));
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
    let W = 0;
    let H = 0;
    let birds: Bird[] = [];
    let ripples: Bloom[] = [];
    let avoid: { left: number; right: number; top: number; bottom: number }[] = [];
    let avoidAt = 0;
    let column: { left: number; right: number } | null = null;
    const calm = () => live.current.path !== "/";
    const mouse = { x: -999, y: -999, over: false };
    let hovered: Bird | null = null;
    let raf = 0;
    let last = 0;
    let alive = true;

    const wanted = () => {
      const p = live.current.path;
      if (p.startsWith("/graph")) return 0; // the graph draws its own birds along edges
      const all = itemsRef.current?.length ?? 0;
      if (p === "/") return Math.min(all, W < 700 ? 30 : 60);
      // Data screens stay calm: a few birds, kept to the margins beside the page.
      return column && column.left >= 110 ? Math.min(all, 12) : 0;
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
      const a = (Math.random() - 0.5) * 0.9;
      return {
        item,
        x: calm()
          ? (i % 2 ? W - 20 - Math.random() * ((column?.left ?? 120) - 40) : 20 + Math.random() * ((column?.left ?? 120) - 40))
          : entering
            ? -60 - i * 46
            : Math.random() * W,
        y: H * (0.12 + Math.random() * 0.5),
        vx: Math.cos(a) * SPEED * (0.6 + Math.random() * 0.4),
        vy: Math.sin(a) * SPEED * 0.5,
        angle: a,
        phase: Math.random() * 6.28,
        scale: scaleFor(item),
        slow: 0,
        entering,
        leaving: -1,
      };
    };

    const sync = () => {
      const items = itemsRef.current ?? [];
      const n = wanted();
      if (birds.length > n) birds.length = n;
      for (let i = birds.length; i < n; i++) birds.push(spawn(items[i], i));
      canvas.style.opacity = live.current.path === "/" ? "1" : "0.75";
    };

    const refreshAvoid = (now: number) => {
      if (now - avoidAt < 350) return;
      avoidAt = now;
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
      for (let i = 0; i < n; i++) {
        const b = birds[i];
        if (b.leaving >= 0) {
          // Peel off: climb away toward the graph link.
          b.leaving += dt;
          b.vx += (W / 2 - b.x) * 3 * dt;
          b.vy += (-80 - b.y) * 3 * dt;
          b.x += b.vx * dt;
          b.y += b.vy * dt;
          b.angle = Math.atan2(b.vy, b.vx);
          b.phase += dt * 16;
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
          const dx = o.x - b.x;
          const dy = o.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > 110 * 110) continue;
          const d = Math.sqrt(d2) || 1;
          if (d < 44) {
            sx -= (dx / d) * (44 - d);
            sy -= (dy / d) * (44 - d);
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
        if (calm()) {
          // No wind beside a data page: wander, and turn back at the window edge.
          ax += Math.cos(b.phase * 0.11 + i * 1.7) * 7;
          ay += Math.sin(b.phase * 0.13 + i) * 9;
          if (b.x < 24) ax += (24 - b.x) * 2;
          if (b.x > W - 24) ax -= (b.x - (W - 24)) * 2;
          inside = !!column && b.x > column.left && b.x < column.right;
        } else {
          // A light prevailing wind keeps the flock crossing the sky.
          ax += 5;
          ay += Math.sin(b.phase * 0.13 + i) * 4;
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
        // Route around text blocks: push out of the padded rect, and look ahead.
        for (const r of avoid) {
          for (const look of [0, 0.9]) {
            const px = b.x + b.vx * look;
            const py = b.y + b.vy * look;
            const pad = 30;
            if (px < r.left - pad || px > r.right + pad || py < r.top - pad || py > r.bottom + pad)
              continue;
            const dl = px - (r.left - pad);
            const dr = r.right + pad - px;
            const du = py - (r.top - pad);
            const dd = r.bottom + pad - py;
            const m = Math.min(dl, dr, du, dd);
            const f = look ? 90 : 260;
            if (m === du) ay -= f;
            else if (m === dd) ay += f;
            else if (m === dl) ax -= f;
            else ax += f;
          }
        }
        // Stay in the sky.
        if (b.y < 50) ay += (50 - b.y) * 1.2;
        if (b.y > H - 50) ay -= (b.y - (H - 50)) * 1.2;

        b.vx += ax * dt;
        b.vy += ay * dt;
        b.slow += ((b === hovered ? 1 : 0) - b.slow) * Math.min(1, dt * 6);
        const max = SPEED * (inside ? 5 : 1) * (1 - 0.85 * b.slow);
        const sp = Math.hypot(b.vx, b.vy) || 1;
        const clamped = Math.max(Math.min(sp, max), Math.min(MIN_SPEED, max));
        b.vx = (b.vx / sp) * clamped;
        b.vy = (b.vy / sp) * clamped;
        b.x += b.vx * dt;
        b.y += b.vy * dt;

        if (b.entering && b.x > 70) {
          // A bird joining the flock means a new award landed today.
          b.entering = false;
          ripples.push({ x: b.x, y: b.y, t: 0 });
        }
        if (!calm()) {
          if (b.x > W + 50) b.x = -50;
          if (b.x < -50 && !b.entering) b.x = W + 50;
        }

        let da = Math.atan2(b.vy, b.vx) - b.angle;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        b.angle += da * Math.min(1, dt * 5);
        b.phase += dt * (6 + clamped * 0.1);
      }
      birds = birds.filter((b) => b.leaving < 0.7);
      for (const r of ripples) r.t += dt;
    };

    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      ripples = ripples.filter((r) => drawBloom(ctx, r, palette.terracotta));
      for (const b of birds) {
        const award = b.item.kind === "award";
        const big = award && (b.item.amount ?? 0) >= 5e7;
        drawBird(
          ctx,
          b.x,
          b.y,
          b.angle,
          // mostly gliding, with a quick beat now and then
          0.55 + 0.45 * Math.sin(b.phase) * Math.max(0, Math.sin(b.phase * 0.23)),
          b.scale * (W < 700 ? 0.8 : 1),
          award ? (big ? palette.pompeii : palette.terracotta) : palette.paleBird,
          award ? 0.9 : 0.7,
        );
      }
    };

    const hover = () => {
      let best: Bird | null = null;
      let bd = 34;
      if (mouse.over) {
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
        const x = Math.min(Math.max(hovered.x + 18, 8), W - tip.offsetWidth - 8);
        tip.style.transform = `translate(${x}px, ${Math.max(hovered.y - 34, 8)}px)`;
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
      if (live.current.motion && !document.hidden) raf = requestAnimationFrame(frame);
      else raf = 0;
    };

    // Reduced motion / still: settle the flock off-screen, then draw one frame.
    const settle = () => {
      avoidAt = 0;
      refreshAvoid(performance.now());
      for (const b of birds) if (b.entering) (b.entering = false), (b.x = Math.random() * W);
      for (let i = 0; i < 160; i++) step(1 / 30);
      ripples = [];
      hover();
      draw();
    };

    let resettle = 0;
    kick.current = () => {
      avoidAt = 0;
      sync();
      cancelAnimationFrame(raf);
      clearTimeout(resettle);
      raf = 0;
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
      const id = b.item.kind === "award" ? `org:${b.item.org_id}` : `opp:${b.item.id}`;
      ripples.push({ x: b.x, y: b.y, t: 0 });
      b.leaving = 0;
      hovered = null;
      tip.style.opacity = "0";
      document.documentElement.style.cursor = "";
      const go = () => live.current.router.push(`/graph?focus=${encodeURIComponent(id)}`);
      if (live.current.motion) setTimeout(go, 520);
      else go();
    };
    const onResize = () => {
      resize();
      kick.current();
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
    window.addEventListener("flock:theme", onTheme);
    document.addEventListener("visibilitychange", onVisible);

    const ac = new AbortController();
    clientGet<RecentItem[]>("recent?limit=60", ac.signal)
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
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("click", onClick);
      window.removeEventListener("resize", onResize);
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
        style={{ viewTransitionName: "flock" }}
      />
      <div
        ref={tipRef}
        role="status"
        className="fig paper-card pointer-events-none fixed left-0 top-0 z-30 whitespace-nowrap px-3 py-1 opacity-0 !shadow-none transition-opacity duration-200"
      />
    </>
  );
}
