"use client";

import { useLayoutEffect, useRef } from "react";

/** The digest types on, line by line, the first time it is opened each week. */
export function Letter({ week, children }: { week: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const key = `flock.report.${week}`;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, "1");
    } catch {
      return;
    }
    const quiet =
      document.documentElement.hasAttribute("data-still") ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!quiet) ref.current?.classList.add("typing");
  }, [week]);
  return <div ref={ref}>{children}</div>;
}
