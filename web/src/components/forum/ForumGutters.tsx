"use client";

import { useEffect, useRef } from "react";
import { Art } from "@/components/Art";
import { OliveBranch } from "./Olive";
import "./gutters.css";

/** The Forum's margin art: engraved figures in the side gutters, fixed to
 *  the bottom of the window so they stay put while the data scrolls. They are
 *  behind the content, never under it: each one stops short of the content
 *  column and fades toward it, so no line crosses a number.
 *
 *  - "figures" (default): Nike in the left margin, Athena in the right. Both
 *    are drawn facing the content and are not mirrored.
 *  - "trophy": a Roman trophy of arms in each margin, the right one mirrored.
 *  - "olive": a tall olive branch in each margin, the right one mirrored.
 *
 *  The figures need a wide margin, so they show from 1500px; from 1400px to
 *  1499px the olive branches take their place, and below 1400px there is no
 *  art (gutters.css). The column is the element marked `data-forum-column`:
 *  its edges are measured (and measured again when it or the window resizes),
 *  so the art follows the column wherever it sits. */
export function ForumGutters({ variant = "figures" }: { variant?: "figures" | "trophy" | "olive" }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    const column = document.querySelector<HTMLElement>("[data-forum-column]");
    if (!el || !column) return;
    const measure = () => {
      // The column's content box: its padding is not content.
      const r = column.getBoundingClientRect();
      const cs = getComputedStyle(column);
      el.style.setProperty("--col-left", `${r.left + parseFloat(cs.paddingLeft)}px`);
      el.style.setProperty("--col-right", `${r.right - parseFloat(cs.paddingRight)}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(column);
    ro.observe(document.documentElement);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const olive = (
    <>
      <OliveBranch className="gutter gutter-olive gutter-l" />
      <OliveBranch className="gutter gutter-olive gutter-r gutter-mirror" />
    </>
  );
  return (
    <div ref={root} className="gutters" data-variant={variant} aria-hidden="true">
      {variant === "figures" && (
        <>
          <Art name="figures/nike" sizes="505px" className="gutter gutter-figure gutter-nike gutter-l" />
          <Art name="figures/athena" sizes="330px" className="gutter gutter-figure gutter-athena gutter-r" />
        </>
      )}
      {variant === "trophy" && (
        <>
          <Art name="figures/trophy" sizes="340px" className="gutter gutter-figure gutter-trophy gutter-l" />
          <Art name="figures/trophy" sizes="340px" className="gutter gutter-figure gutter-trophy gutter-r gutter-mirror" />
        </>
      )}
      {/* The olive branches: the variant of their own, and the stand-in for
          the figures at medium widths. */}
      {variant === "olive" ? olive : <div className="gutters-fallback">{olive}</div>}
    </div>
  );
}
