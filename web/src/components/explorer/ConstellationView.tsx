"use client";

import { useMemo, useState } from "react";
import { moneyRound, plural } from "@/lib/format";
import { layoutConstellation, type Model, type Named, type StarEdge, type StarNode } from "@/lib/flows";
import type { Fresh } from "./FlowView";
import { Hatch, TickRing, useSvgId, useTip, useWidth } from "./parts";

// The constellation: one company or agency at the center and its neighborhood
// on two fixed rings. Ring 1 is who it trades dollars with (edge width is the
// dollars, the label rides the edge); ring 2, at two hops, is who else those
// parties trade with. Everything else in the window is ghosted behind, faint
// but still nameable on hover. Clicking any node, ghost or not, re-centers.
//
// Positions come from rank alone (lib/flows.ts layoutConstellation): no
// simulation runs, so the picture is the same on every load.

const NARROW = 640;

export function ConstellationView({
  model,
  who,
  center,
  hops,
  onCenter,
  fresh,
  gen,
  missions,
}: {
  model: Model;
  who: Map<string, Named>;
  center: string | null;
  hops: 1 | 2;
  onCenter: (id: string) => void;
  fresh: Fresh;
  gen: number;
  /** the center's missions, set along the arc over its name */
  missions: string[];
}) {
  const [frame, measured] = useWidth<HTMLDivElement>(980);
  const width = Math.max(NARROW, measured);
  const height = Math.round(Math.min(740, Math.max(540, width * 0.74)));
  const { tip, show, hide } = useTip();
  const [hover, setHover] = useState<string | null>(null);
  const hatch = useSvgId("ch");
  const arc = useSvgId("ca");
  const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
  const edgeId = useSvgId("ce");

  const star = useMemo(
    () =>
      center
        ? layoutConstellation(model, who, center, hops, { width, height })
        : layoutConstellation(model, who, "", hops, { width, height }),
    [model, who, center, hops, width, height],
  );
  const c = star.center;
  const centerIsCompany = c?.kind === "company";
  const ring1Word = centerIsCompany ? "paying agencies" : "companies paid";
  const ring2Word = centerIsCompany ? "funded alongside" : "co-funders";

  const near = (id: string | null, e: StarEdge) => !!id && (e.source === id || e.target === id);
  const quiet = (n: StarNode) =>
    !!hover && hover !== n.id && !star.edges.some((e) => near(hover, e) && (e.source === n.id || e.target === n.id));
  const isFreshEdge = (e: StarEdge) => !!fresh && e.awards.length > 0 && e.awards.every((a) => fresh.awards.has(a.id));

  const nodeNote = (n: StarNode) => (
    <>
      <strong>{n.more ? n.label : (who.get(n.id)?.full ?? n.label)}</strong>
      <span className="ex-tip-row">
        <span className="money">{moneyRound(n.dollars)}</span>
        <span>
          {plural(n.awards, "award")}
          {n.ring === 1 && c ? ` with ${c.label}` : n.via ? ` via ${who.get(n.via)?.label ?? ""}` : ""}
        </span>
      </span>
      {!n.more && <span className="ex-tip-hint">Click to re-center</span>}
    </>
  );

  const nodeMark = (n: StarNode) => {
    const agency = n.kind !== "company";
    if (n.more) return <circle cx={n.x} cy={n.y} r={3} className="ex-star-more" />;
    return agency ? (
      <>
        {n.ring === 1 && <TickRing cx={n.x} cy={n.y} r={n.r + 3} n={22} len={3} />}
        <circle cx={n.x} cy={n.y} r={n.ring === 1 ? n.r : 4.5} className="ex-star-agency" />
        {n.ring === 1 && <circle cx={n.x} cy={n.y} r={3.4} className="ex-star-core" />}
      </>
    ) : (
      <circle
        cx={n.x}
        cy={n.y}
        r={n.r}
        className={n.ring === 1 ? "ex-star-company ex-star-company-1" : "ex-star-company"}
      />
    );
  };

  const labelProps = (n: StarNode) => {
    // Names read outward from the center: to the right on the right half, to
    // the left on the left, and above or below near the poles.
    const cos = Math.cos(n.angle);
    const sin = Math.sin(n.angle);
    const off = n.r + (n.kind !== "company" && n.ring === 1 ? 10 : 7);
    if (Math.abs(cos) < 0.3)
      return { x: n.x, y: n.y + (sin < 0 ? -(off + 3) : off + 12), textAnchor: "middle" as const };
    return {
      x: n.x + (cos > 0 ? off : -off),
      y: n.y + 4.5,
      textAnchor: cos > 0 ? ("start" as const) : ("end" as const),
    };
  };
  // The ring captions ride the foot of each ring, in the sector kept free.
  const foot = (rx: number, ry: number) => {
    const a = (34 * Math.PI) / 180;
    return `M${(star.cx - Math.sin(a) * rx).toFixed(1)} ${(star.cy + Math.cos(a) * ry).toFixed(1)}A${rx} ${ry} 0 0 0 ${(star.cx + Math.sin(a) * rx).toFixed(1)} ${(star.cy + Math.cos(a) * ry).toFixed(1)}`;
  };

  return (
    <div className="ex-scroll" ref={frame}>
      <svg
        viewBox={`0 0 ${star.width} ${star.height}`}
        width={star.width}
        height={star.height}
        role="img"
        aria-label={
          c
            ? `Neighborhood of ${c.label}: ${star.nodes.filter((n) => n.ring === 1 && !n.more).length} ${ring1Word} on the first ring, edges sized by dollars${hops === 2 ? `, and ${star.nodes.filter((n) => n.ring === 2).length} ${ring2Word} on the second ring` : ""}; the rest of the window is ghosted.`
            : "Constellation: choose a company or an agency to see its neighborhood."
        }
        className={`ex-star ${hover ? "ex-star-focus" : ""} ${fresh ? "ex-star-fresh" : ""}`}
        style={{ maxWidth: measured >= NARROW ? "100%" : undefined, height: measured >= NARROW ? "auto" : undefined }}
      >
        <defs>
          <Hatch id={hatch} gap={4} weight={0.7} opacity={0.34} />
        </defs>

        {/* the rest of the window, ghosted */}
        <g className="ex-ghosts">
          {star.ghosts.map((g) => (
            <g
              key={g.id}
              role="button"
              tabIndex={-1}
              aria-label={`${g.label}: re-center`}
              onClick={() => onCenter(g.id)}
              onPointerMove={(e) =>
                show(
                  e,
                  <>
                    <strong>{who.get(g.id)?.full ?? g.label}</strong>
                    <span className="ex-tip-hint">Outside this neighborhood · click to re-center</span>
                  </>,
                )
              }
              onPointerLeave={hide}
            >
              <circle cx={g.x} cy={g.y} r={9} className="ex-hit" />
              <circle cx={g.x} cy={g.y} r={g.r} className="ex-ghost" />
            </g>
          ))}
        </g>

        {c && (
          <>
            <circle cx={star.cx} cy={star.cy} r={star.r1} className="ex-hop" />
            <path id={`${arc}1`} d={foot(star.r1 - 5, star.r1 - 5)} fill="none" />
            <text className="ex-hoplabel ex-halo">
              <textPath href={`#${arc}1`} startOffset="50%" textAnchor="middle">
                1 hop · {ring1Word}
              </textPath>
            </text>
            {hops === 2 && (
              <>
                <ellipse cx={star.cx} cy={star.cy} rx={star.r2x} ry={star.r2y} className="ex-hop" />
                <path id={`${arc}2`} d={foot(star.r2x - 5, star.r2y - 5)} fill="none" />
                <text className="ex-hoplabel ex-halo">
                  <textPath href={`#${arc}2`} startOffset="50%" textAnchor="middle">
                    2 hops · {ring2Word}
                  </textPath>
                </text>
              </>
            )}

            <g key={`${gen}:${c.id}:${hops}`}>
              {star.edges
                .filter((e) => e.ring === 2)
                .map((e) => (
                  <path
                    key={`${e.key}:${e.extra ? "x" : ""}`}
                    d={e.d}
                    className={`ex-edge2 ${e.extra ? "ex-edge2-extra" : ""} ${near(hover, e) ? "ex-edge-hot" : ""} ${isFreshEdge(e) ? "ex-edge-fresh" : ""}`}
                  />
                ))}
              {star.edges
                .filter((e) => e.ring === 1)
                .map((e, i) => (
                  <g
                    key={e.key}
                    className={`${near(hover, e) ? "ex-edge-hot" : ""} ${isFreshEdge(e) ? "ex-edge-fresh" : ""}`}
                  >
                    <path id={`${edgeId}${i}`} d={e.d} className="ex-edge1-base" style={{ strokeWidth: e.width }} />
                    <path
                      d={e.d}
                      pathLength={1}
                      className="ex-edge1 ex-ink"
                      style={{ strokeWidth: e.width, animationDelay: `${(0.15 + i * 0.22).toFixed(2)}s` }}
                    />
                  </g>
                ))}
            </g>

            {/* edge labels ride the first few edges; the rest say theirs on hover */}
            {star.edges
              .filter((e) => e.ring === 1)
              .map((e, i) =>
                i < 6 ? (
                  <text key={e.key} className="ex-edgelabel ex-halo" dy={-7}>
                    <textPath
                      href={`#${edgeId}${i}`}
                      startOffset={e.d.startsWith(`M${star.cx.toFixed(1)} `) ? "62%" : "38%"}
                      textAnchor="middle"
                    >
                      {moneyRound(e.dollars)} · {plural(e.awards.length, "award")}
                    </textPath>
                  </text>
                ) : null,
              )}

            {star.nodes.map((n) => {
              const lp = labelProps(n);
              const newcomer = !!fresh && fresh.companies.has(n.id);
              return (
                <g
                  key={n.id}
                  className={`ex-starnode ex-starnode-${n.ring} ${quiet(n) ? "ex-quiet" : ""}`}
                  role={n.more ? undefined : "button"}
                  tabIndex={n.more ? undefined : 0}
                  aria-label={
                    n.more
                      ? undefined
                      : `${who.get(n.id)?.full ?? n.label}: ${moneyRound(n.dollars)}, ${plural(n.awards, "award")}. Re-center on it.`
                  }
                  onClick={() => !n.more && onCenter(n.id)}
                  onKeyDown={(e) => {
                    if (!n.more && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      onCenter(n.id);
                    }
                  }}
                  onPointerEnter={() => setHover(n.id)}
                  onPointerMove={(e) => show(e, nodeNote(n))}
                  onPointerLeave={() => {
                    setHover(null);
                    hide();
                  }}
                >
                  <circle cx={n.x} cy={n.y} r={Math.max(11, n.r + 5)} className="ex-hit" />
                  {nodeMark(n)}
                  {newcomer && <circle cx={n.x} cy={n.y} r={n.r + 4} className="ex-newring" />}
                  {(n.labeled || hover === n.id) && (
                    <text {...lp} className={`ex-starlabel ex-starlabel-${n.ring} ex-halo`}>
                      {cut(n.label, n.ring === 1 ? 24 : 22)}
                    </text>
                  )}
                </g>
              );
            })}

            {/* the center: a hatched disk in a tick ring, its name beneath */}
            <g className="ex-center">
              <TickRing cx={star.cx} cy={star.cy} r={31} n={48} len={4} className="ex-tickring ex-tickring-strong" />
              <circle cx={star.cx} cy={star.cy} r={27} className="ex-center-disk" />
              <circle cx={star.cx} cy={star.cy} r={20} style={{ fill: `url(#${hatch})` }} className="ex-center-hatch" />
              <circle cx={star.cx} cy={star.cy} r={7} className="ex-center-core" />
              <text x={star.cx} y={star.cy + 64} textAnchor="middle" className="ex-centername ex-halo">
                {cut(c.label, 30)}
              </text>
              <text x={star.cx} y={star.cy + 82} textAnchor="middle" className="ex-centersub ex-halo">
                {c.kind === "company" ? "Company" : c.kind === "office" ? "Office" : "Agency"} · {moneyRound(c.dollars)}
              </text>
              {missions.length > 0 && (
                <text x={star.cx} y={star.cy + 101} textAnchor="middle" className="ex-centerarc ex-halo">
                  {missions.slice(0, 2).join(" · ")}
                </text>
              )}
            </g>
          </>
        )}
      </svg>
      {tip}
    </div>
  );
}
