"use client";

import { useEffect, useRef } from "react";
import { useStore } from "@/lib/store";

// Classic's scroll parallax. While the hero scrolls away, its painted sky
// moves at 0.15 of the page's speed and the leafy frame at 0.6. This writes
// one number on the hero, --sy (how far the page has scrolled, in px), and
// hero.css turns it into transforms. In Dark and Paper, and with motion off,
// it does nothing and --sy is not set.

export function HeroParallax() {
  const mark = useRef<HTMLSpanElement>(null);
  const { theme, motion } = useStore();
  const on = theme === "classic" && motion;

  useEffect(() => {
    const hero = mark.current?.closest<HTMLElement>(".hero");
    if (!hero || !on) return;
    let raf = 0;
    const write = () => {
      raf = 0;
      // Past the hero's own height nothing of it is on screen.
      const y = Math.max(0, Math.min(window.scrollY, hero.offsetHeight));
      hero.style.setProperty("--sy", y.toFixed(1));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(write);
    };
    write();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      hero.style.removeProperty("--sy");
    };
  }, [on]);

  return <span ref={mark} hidden />;
}
