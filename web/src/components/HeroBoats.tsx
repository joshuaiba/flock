"use client";

import { useEffect, useRef } from "react";
import { Art } from "./Art";

// The two boats on the hero's lake. They are layers inside the scene's own
// box, so they keep their places on the water at any size. Both bob; the
// sailboat also drifts slowly across the lake. All of it is CSS (hero.css):
// this component only holds the animations while nobody can see them, when
// the hero has scrolled off screen or the tab is hidden. With motion off (the
// OS setting, or Motion: Off in the Display menu) nothing runs at all and both
// boats sit where the design puts them. In Classic the painted boats take the
// engraved ones' places, with the same sizes and the same motion.

export function HeroBoats() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let onScreen = true;
    const sync = () => el.toggleAttribute("data-paused", !onScreen || document.hidden);
    const io =
      "IntersectionObserver" in window
        ? new IntersectionObserver((entries) => {
            onScreen = entries[entries.length - 1].isIntersecting;
            sync();
          })
        : null;
    io?.observe(el.closest(".hero") ?? el);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      io?.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  return (
    <div ref={root} className="hero-boats">
      <div className="hero-boat hero-rowboat">
        <Art name="hero/rowboat" classic="classic/hero/rowboat" sizes="max(8.2vw, 74px)" className="hero-bob" />
      </div>
      {/* Nearer the viewer than the rowboat, so it passes in front of it. */}
      <div className="hero-boat hero-sailboat">
        <Art name="hero/sailboat" classic="classic/hero/sailboat" sizes="max(6.6vw, 60px)" className="hero-bob" />
      </div>
    </div>
  );
}
