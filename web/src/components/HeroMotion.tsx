"use client";

import { useEffect, useRef } from "react";
import { useStore } from "@/lib/store";

// The hero's script: scroll and mouse parallax (three numbers written on the
// section, read by hero.css), the water shimmer (an SVG displacement filter
// whose noise field slides slowly), and the pause switch for when the hero is
// off screen or the tab is hidden. With motion off none of it runs and the
// hero is a still composition.

/** 1 = the brief's speeds (sky 0.1x, midground 0.3x, lake 0.4x, frame 0.6x of
 *  the scroll). Lower is gentler; 0 turns scroll parallax off. */
const SCROLL_GAIN = 1;
/** How quickly the layers follow the mouse, per frame (0 to 1). */
const MOUSE_EASE = 0.07;

// Water shimmer. The noise is stretched wide and thin (see baseFrequency), and
// only shifts pixels sideways, so reflections wobble horizontally.
const SHIMMER_FREQ = "0.004 0.06";
const SHIMMER_SCALE = 5; // px of displacement, peak to peak (brief: 4 to 6)
const SHIMMER_OCTAVES = 2;
const SHIMMER_FPS = 24; // the ripple is slow; the filter need not run at 60
// The noise field slides sideways and, a little, up and down. Two periods that
// never line up, so the water is never quite still. Keep the reach inside the
// filter's margins (4% of the lake's width, 10% of its height).
const DRIFT_X = { px: 34, seconds: 37 };
const DRIFT_Y = { px: 7, seconds: 13 };
/** If animating the filter slows the page, switch to the fallback (a still lake
 *  sliding 2px) for the rest of the visit. The test compares frame times with
 *  the ripple held still against frame times with it moving, so a display that
 *  simply refreshes slowly (30Hz, battery saver) keeps the shimmer. */
const AUTO_FALLBACK = true;
const PROBE_BASE_FRAMES = 30; // ripple held still: what this display can do
const PROBE_FRAMES = 90; // ripple moving
const SLOW_RATIO = 1.25; // moving may cost this much more than still...
const SLOW_SLACK_MS = 2; // ...plus this, before the fallback takes over

export function HeroMotion({ shimmer }: { shimmer: boolean }) {
  const svg = useRef<SVGSVGElement>(null);
  const offset = useRef<SVGFEOffsetElement>(null);
  const { motion } = useStore();

  useEffect(() => {
    const hero = svg.current?.closest<HTMLElement>("#hero");
    const fe = offset.current;
    if (!hero) return;

    const rest = () => {
      hero.style.setProperty("--sy", "0");
      hero.style.setProperty("--mx", "0");
      hero.style.setProperty("--my", "0");
      fe?.setAttribute("dx", "0");
      fe?.setAttribute("dy", "0");
    };
    if (!motion) {
      rest();
      hero.removeAttribute("data-paused");
      return;
    }

    let raf = 0;
    let onScreen = true;
    let rippling = shimmer && !!fe && hero.dataset.shimmer === "filter";
    let last = 0;
    let clock = 0; // seconds of running time: stops while paused
    let rippleAt = -1;
    let sy = -1;
    let mx = 0;
    let my = 0;
    let tx = 0;
    let ty = 0;
    // frame-time probe for the automatic fallback
    let probeFrames = 0;
    let baseMs = 0;
    let probeMs = 0;

    const running = () => onScreen && !document.hidden;

    const frame = (now: number) => {
      raf = 0;
      if (!running()) return;
      const dt = last ? Math.min(now - last, 250) : 16;
      last = now;
      clock += dt / 1000;

      const y = Math.max(0, window.scrollY) * SCROLL_GAIN;
      if (y !== sy) {
        sy = y;
        hero.style.setProperty("--sy", y.toFixed(1));
      }

      const settling = Math.abs(tx - mx) > 0.002 || Math.abs(ty - my) > 0.002;
      if (settling) {
        mx += (tx - mx) * MOUSE_EASE;
        my += (ty - my) * MOUSE_EASE;
        hero.style.setProperty("--mx", mx.toFixed(4));
        hero.style.setProperty("--my", my.toFixed(4));
      }

      if (rippling && fe) {
        // Measure once, after the page has settled (3s in): first with the
        // ripple held still, then with it moving.
        const probing = AUTO_FALLBACK && clock > 3 && probeFrames < PROBE_BASE_FRAMES + PROBE_FRAMES && dt < 250;
        const holding = probing && probeFrames < PROBE_BASE_FRAMES;
        if (!holding && clock - rippleAt >= 1 / SHIMMER_FPS) {
          rippleAt = clock;
          fe.setAttribute("dx", (DRIFT_X.px * Math.sin((clock / DRIFT_X.seconds) * 2 * Math.PI)).toFixed(2));
          fe.setAttribute("dy", (DRIFT_Y.px * Math.sin((clock / DRIFT_Y.seconds) * 2 * Math.PI)).toFixed(2));
        }
        if (probing) {
          if (holding) baseMs += dt;
          else probeMs += dt;
          probeFrames++;
          if (probeFrames === PROBE_BASE_FRAMES + PROBE_FRAMES) {
            const still = baseMs / PROBE_BASE_FRAMES;
            const moving = probeMs / PROBE_FRAMES;
            if (moving > still * SLOW_RATIO + SLOW_SLACK_MS) {
              rippling = false;
              hero.dataset.shimmer = "sway";
            }
          }
        }
      }

      if (rippling || settling) raf = requestAnimationFrame(frame);
    };
    const kick = () => {
      if (!raf && running()) {
        last = 0;
        raf = requestAnimationFrame(frame);
      }
    };
    const sync = () => {
      hero.toggleAttribute("data-paused", !running());
      kick();
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      // Layers lean away from the pointer, like looking around a stage set.
      tx = -((e.clientX / window.innerWidth) * 2 - 1);
      ty = -((e.clientY / window.innerHeight) * 2 - 1);
      kick();
    };
    const io = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      sync();
    });
    io.observe(hero);
    window.addEventListener("scroll", kick, { passive: true });
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("visibilitychange", sync);
    sync();

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener("scroll", kick);
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("visibilitychange", sync);
      hero.removeAttribute("data-paused");
    };
  }, [motion, shimmer]);

  // The filter is always in the page (hero.css applies it only when the hero
  // says data-shimmer="filter"). Turbulence -> slide -> keep only the red
  // channel as a sideways push (green pinned to 0.5 = no vertical push, so the
  // horizon stays a straight line) -> displace the lake.
  return (
    <svg ref={svg} width="0" height="0" aria-hidden="true" focusable="false" style={{ position: "absolute" }}>
      <defs>
        <filter id="hero-shimmer" x="-4%" y="-10%" width="108%" height="120%" colorInterpolationFilters="sRGB">
          <feTurbulence
            type="fractalNoise"
            baseFrequency={SHIMMER_FREQ}
            numOctaves={SHIMMER_OCTAVES}
            seed="7"
            result="noise"
          />
          <feOffset ref={offset} in="noise" dx="0" dy="0" result="drift" />
          <feColorMatrix
            in="drift"
            type="matrix"
            values="1 0 0 0 0  0 0 0 0 0.5  0 0 0 0 0  0 0 0 0 1"
            result="push"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="push"
            scale={SHIMMER_SCALE}
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
    </svg>
  );
}
