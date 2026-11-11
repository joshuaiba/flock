"use client";

import Matter from "matter-js";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, ViewTransition } from "react";
import { medallionFor } from "@/lib/art";
import { chainRing, MAX_PINS, useStore, type Pin } from "@/lib/store";
import { MedallionImg } from "./Art";

// The watchlist: up to five painted medallions hanging from a fine gold chain
// anchored top right. Real physics (Matter.js): the chain is a rope of small
// links joined by distance constraints, medallions are clipped to its ring. Drag one and
// it swings and collides; pull it well clear of the ring and let go, and it
// falls off-screen and leaves the watchlist. Click (or Enter) opens the entity;
// Delete removes it. Everything also works with motion off.

const R = 27; // medallion radius
const LINKS = 11;
const LINK = 6; // spacing of the chain links
const UNCLIP = 190; // pull a medallion this far from the ring and its tether lets go

type CoinBody = { body: Matter.Body; tether: Matter.Constraint | null; pin: Pin };

export function Chain() {
  const { pins, unpin, motion } = useStore();
  const router = useRouter();
  const path = usePathname();
  const svgRef = useRef<SVGSVGElement>(null);
  const els = useRef(new Map<number, HTMLDivElement>());
  const [hot, setHot] = useState(false);

  const live = useRef({ motion, unpin, router });
  live.current = { motion, unpin, router };
  const sim = useRef<{
    setPins: (p: Pin[]) => void;
    grab: (id: number, e: React.PointerEvent) => void;
    wake: () => void;
  } | null>(null);

  useEffect(() => {
    const { Engine, Bodies, Body, Composite, Constraint } = Matter;
    const engine = Engine.create({ gravity: { x: 0, y: 1.1 } });
    const world = engine.world;
    const ghost = { group: -1, category: 2, mask: 0 }; // links and ring touch nothing
    const anchorAt = () => ({ x: window.innerWidth - (window.innerWidth < 700 ? 44 : 70), y: -6 });

    let a = anchorAt();
    const links: Matter.Body[] = [];
    let prev: Matter.Body | null = null;
    for (let i = 0; i < LINKS; i++) {
      const b = Bodies.circle(a.x, a.y + LINK * (i + 1), 2, {
        collisionFilter: ghost,
        frictionAir: 0.04,
        density: 0.002,
      });
      Composite.add(
        world,
        Constraint.create(
          prev
            ? { bodyA: prev, bodyB: b, length: LINK, stiffness: 0.95 }
            : { pointA: { ...a }, bodyB: b, length: LINK, stiffness: 0.95 },
        ),
      );
      links.push(b);
      prev = b;
    }
    const ring = Bodies.circle(a.x, a.y + LINK * LINKS + 10, 8, {
      collisionFilter: ghost,
      frictionAir: 0.04,
      density: 0.004,
    });
    const top = world.constraints[0];
    Composite.add(world, [
      ...links,
      ring,
      Constraint.create({ bodyA: prev!, bodyB: ring, length: 10, stiffness: 0.95 }),
    ]);

    const coins = new Map<number, CoinBody>();
    let drag: { id: number; c: Matter.Constraint; sx: number; sy: number; t: number; moved: boolean } | null =
      null;
    let raf = 0;
    let quietFrames = 0;
    let alive = true;

    const tether = (body: Matter.Body, i: number) =>
      Constraint.create({
        bodyA: ring,
        bodyB: body,
        pointB: { x: 0, y: -R + 2 },
        length: 20 + (i % 3) * 13,
        stiffness: 0.6,
        damping: 0.06,
      });

    const render = () => {
      const svg = svgRef.current;
      if (svg) {
        const circles = svg.querySelectorAll("circle");
        links.forEach((b, i) => {
          circles[i]?.setAttribute("cx", b.position.x.toFixed(1));
          circles[i]?.setAttribute("cy", b.position.y.toFixed(1));
        });
        circles[LINKS]?.setAttribute("cx", ring.position.x.toFixed(1));
        circles[LINKS]?.setAttribute("cy", ring.position.y.toFixed(1));
        const lines = svg.querySelectorAll("line");
        let i = 0;
        for (const o of coins.values()) {
          const l = lines[i++];
          if (!l) break;
          const c = Math.cos(o.body.angle);
          const s = Math.sin(o.body.angle);
          l.setAttribute("x1", ring.position.x.toFixed(1));
          l.setAttribute("y1", ring.position.y.toFixed(1));
          l.setAttribute("x2", (o.body.position.x + s * (R - 2)).toFixed(1));
          l.setAttribute("y2", (o.body.position.y - c * (R - 2)).toFixed(1));
          l.style.opacity = o.tether ? "1" : "0";
        }
      }
      for (const [id, o] of coins) {
        const el = els.current.get(id);
        if (!el) continue;
        el.style.transform = `translate(${(o.body.position.x - R).toFixed(1)}px, ${(o.body.position.y - R).toFixed(1)}px)`;
        const inner = el.firstElementChild as HTMLElement | null;
        if (inner) inner.style.rotate = `${o.body.angle.toFixed(3)}rad`;
      }
      chainRing.x = ring.position.x;
      chainRing.y = ring.position.y;
      chainRing.ready = true;
    };

    const tick = () => {
      Engine.update(engine, 1000 / 60);
      for (const [id, o] of coins) {
        const p = o.body.position;
        if (o.tether && drag?.id === id && Math.hypot(p.x - ring.position.x, p.y - ring.position.y) > UNCLIP) {
          Composite.remove(world, o.tether);
          o.tether = null;
        }
        // Thrown clear of the screen: off the watchlist.
        if (!o.tether && drag?.id !== id) {
          const out = p.y > window.innerHeight + 80 || p.x < -80 || p.x > window.innerWidth + 80 || p.y < -200;
          if (out) live.current.unpin(id);
        }
      }
    };

    const loop = () => {
      if (!alive) return;
      tick();
      render();
      let energy = drag ? 1 : 0;
      for (const b of world.bodies) energy += b.speed;
      quietFrames = energy < 0.06 ? quietFrames + 1 : 0;
      raf = quietFrames < 40 && !document.hidden ? requestAnimationFrame(loop) : 0;
    };

    const wake = () => {
      quietFrames = 0;
      if (!live.current.motion) {
        // Physics settles instantly.
        for (let i = 0; i < 500; i++) tick();
        for (const b of world.bodies) Body.setVelocity(b, { x: 0, y: 0 });
        render();
      } else if (!raf) raf = requestAnimationFrame(loop);
    };

    const setPins = (next: Pin[]) => {
      for (const [id, o] of coins) {
        if (next.some((p) => p.id === id)) continue;
        Composite.remove(world, o.body);
        if (o.tether) Composite.remove(world, o.tether);
        coins.delete(id);
      }
      next.forEach((pin, i) => {
        if (coins.has(pin.id)) return (coins.get(pin.id)!.pin = pin);
        const body = Bodies.circle(ring.position.x - 30 + i * 22, ring.position.y + 46 + (i % 2) * 18, R, {
          restitution: 0.45,
          frictionAir: 0.018,
          friction: 0.02,
          density: 0.0012,
        });
        const t = tether(body, i);
        Composite.add(world, [body, t]);
        coins.set(pin.id, { body, tether: t, pin });
      });
      wake();
    };

    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      drag.c.pointA = { x: e.clientX, y: e.clientY };
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6) drag.moved = true;
      wake();
    };
    const onUp = () => {
      if (!drag) return;
      const { id, c, moved, t } = drag;
      Composite.remove(world, c);
      drag = null;
      const o = coins.get(id);
      if (!moved && performance.now() - t < 500) live.current.router.push(`/entity/${id}`);
      else if (o && !o.tether) {
        const p = o.body.position;
        // Dropped back near the ring: clip it on again.
        if (Math.hypot(p.x - ring.position.x, p.y - ring.position.y) < 120) {
          o.tether = tether(o.body, coins.size);
          Composite.add(world, o.tether);
        }
      }
      wake();
    };
    const grab = (id: number, e: React.PointerEvent) => {
      const o = coins.get(id);
      if (!o) return;
      if (!live.current.motion) {
        drag = null;
        return;
      }
      (e.target as Element).setPointerCapture?.(e.pointerId);
      const c = Constraint.create({
        pointA: { x: e.clientX, y: e.clientY },
        bodyB: o.body,
        pointB: { x: e.clientX - o.body.position.x, y: e.clientY - o.body.position.y },
        length: 0,
        stiffness: 0.12,
        damping: 0.12,
      });
      Composite.add(world, c);
      drag = { id, c, sx: e.clientX, sy: e.clientY, t: performance.now(), moved: false };
      wake();
    };
    const onResize = () => {
      a = anchorAt();
      top.pointA = { ...a };
      wake();
    };
    const onHot = (e: Event) => setHot((e as CustomEvent<boolean>).detail);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("resize", onResize);
    window.addEventListener("flock:chain-hot", onHot);
    sim.current = { setPins, grab, wake };
    wake();

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("flock:chain-hot", onHot);
      Engine.clear(engine);
      sim.current = null;
      chainRing.ready = false;
    };
  }, []);

  useEffect(() => {
    sim.current?.setPins(pins);
  }, [pins, motion]);

  // The medallion for the entity you are looking at morphs into that page's header.
  const viewing = path.startsWith("/entity/") ? Number(path.split("/")[2]) : null;

  return (
    <div
      className="pointer-events-none fixed inset-0 z-40 overflow-hidden"
      role="region"
      aria-label={`Watchlist, ${pins.length} of ${MAX_PINS} pinned`}
    >
      <svg ref={svgRef} className="absolute inset-0 h-full w-full" aria-hidden="true">
        {pins.map((p) => (
          <line key={p.id} stroke="var(--gold)" strokeWidth={1.1} />
        ))}
        {Array.from({ length: LINKS }, (_, i) => (
          <circle key={i} r={2.3} cy={-20} fill="none" stroke="var(--gold)" strokeWidth={1.1} />
        ))}
        <circle
          r={8}
          cy={-20}
          fill="none"
          stroke={hot ? "var(--cypress)" : "var(--gold)"}
          strokeWidth={hot ? 3 : 1.8}
          style={{ transition: "stroke 0.2s, stroke-width 0.2s" }}
        />
      </svg>
      {pins.map((p) => {
        const coin = (
          <button
            type="button"
            className="pointer-events-auto block h-full w-full cursor-grab touch-none select-none rounded-full p-0 shadow-[0_7px_14px_-7px_rgb(40_30_22/0.6)] active:cursor-grabbing"
            aria-label={`${p.name}. Open entity page. Press Delete to remove from watchlist.`}
            onPointerDown={(e) => sim.current?.grab(p.id, e)}
            onClick={(e) => {
              // Pointer clicks are handled on release (so drags don't navigate).
              if (e.detail === 0 || !motion) router.push(`/entity/${p.id}`);
            }}
            onKeyDown={(e) => {
              if (e.key === "Delete" || e.key === "Backspace") unpin(p.id);
            }}
          >
            <MedallionImg name={medallionFor(p.tag, p.kind)} size={R * 2} className="pointer-events-none" />
          </button>
        );
        return (
          <div
            key={p.id}
            ref={(el) => {
              if (el) els.current.set(p.id, el);
              else els.current.delete(p.id);
            }}
            className="group absolute left-0 top-0"
            style={{ width: R * 2, height: R * 2, transform: "translate(-200px,-200px)" }}
          >
            <div className="h-full w-full">
              {viewing === p.id ? coin : (
                <ViewTransition name={`coin-${p.id}`} share="coin-morph">
                  {coin}
                </ViewTransition>
              )}
            </div>
            <span className="paper-card pointer-events-none absolute right-0 top-full mt-1.5 whitespace-nowrap px-2.5 py-0.5 text-[0.95rem] opacity-0 !shadow-none transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
              {p.name}
            </span>
            <button
              type="button"
              onClick={() => unpin(p.id)}
              aria-label={`Remove ${p.name} from watchlist`}
              className="pointer-events-auto absolute -right-1 -top-1 text-sm leading-none grid h-5 w-5 cursor-pointer place-items-center rounded-full border border-frame bg-card text-muted opacity-0 transition-opacity hover:text-ink focus:opacity-100 group-hover:opacity-100"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
