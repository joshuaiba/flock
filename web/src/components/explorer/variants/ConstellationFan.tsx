"use client";

import { useMemo } from "react";
import { moneyRound, plural } from "@/lib/format";
import { byDollars, type Link, type Model, type Named } from "@/lib/flows";
import { useWidth } from "../parts";

// Variant under comparison (?viz=fan): the same neighborhood as a left-to-right
// fan. The selected party on the left, who it trades with in a middle column,
// who else they trade with in a right column. Every name is set flat.

export function ConstellationFan({
  model,
  who,
  center,
  hops,
  onCenter,
}: {
  model: Model;
  who: Map<string, Named>;
  center: string | null;
  hops: 1 | 2;
  onCenter: (id: string) => void;
}) {
  const [frame, measured] = useWidth<HTMLDivElement>(980);
  const width = Math.max(720, measured);
  const fan = useMemo(() => {
    if (!center) return null;
    const ties = new Map<string, Link[]>();
    for (const l of model.ac.values()) {
      (ties.get(l.source) ?? ties.set(l.source, []).get(l.source)!).push(l);
      (ties.get(l.target) ?? ties.set(l.target, []).get(l.target)!).push(l);
    }
    const other = (l: Link, id: string) => (l.source === id ? l.target : l.source);
    const first = (ties.get(center) ?? []).slice().sort(byDollars).slice(0, 10);
    const seen = new Set([center, ...first.map((l) => other(l, center))]);
    const rows: { id: string; link: Link; kids: { id: string; link: Link }[] }[] = first.map((l) => {
      const id = other(l, center);
      const kids =
        hops === 2
          ? (ties.get(id) ?? [])
              .slice()
              .sort(byDollars)
              .filter((t) => !seen.has(other(t, id)))
              .slice(0, 4)
              .map((t) => ({ id: other(t, id), link: t }))
          : [];
      kids.forEach((k) => seen.add(k.id));
      return { id, link: l, kids };
    });
    return rows;
  }, [model, center, hops]);
  if (!fan || !center) return null;
  const label = (id: string) => who.get(id)?.label ?? id;
  const rowsTotal = fan.reduce((s, r) => s + Math.max(1, r.kids.length), 0);
  const pitch = 20;
  const height = Math.max(420, rowsTotal * pitch + 60);
  const x0 = 150;
  const x1 = Math.round(width * 0.42);
  const x2 = Math.round(width * 0.7);
  const cy = height / 2;
  const max = Math.max(1, ...fan.map((r) => r.link.dollars));
  let y = 40;
  const curve = (xa: number, ya: number, xb: number, yb: number) =>
    `M${xa} ${ya}C${(xa + xb) / 2} ${ya} ${(xa + xb) / 2} ${yb} ${xb} ${yb}`;
  return (
    <div className="ex-scroll" ref={frame}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-label={`Neighborhood of ${label(center)} as a fan.`}
        className="ex-star"
        style={{ maxWidth: "100%", height: "auto" }}
      >
        {fan.map((r) => {
          const span = Math.max(1, r.kids.length) * pitch;
          const ry = y + span / 2;
          const kids = r.kids.map((k, j) => ({ ...k, y: y + j * pitch + pitch / 2 }));
          y += span;
          return (
            <g key={r.id}>
              <path
                d={curve(x0 + 26, cy, x1 - 8, ry)}
                className="ex-edge1"
                style={{ strokeWidth: 1 + 4.5 * Math.sqrt(r.link.dollars / max) }}
              />
              {kids.map((k) => (
                <path key={k.id} d={curve(x1 + 8, ry, x2 - 6, k.y)} className="ex-edge2" />
              ))}
              <g
                role="button"
                tabIndex={0}
                aria-label={label(r.id)}
                onClick={() => onCenter(r.id)}
                style={{ cursor: "pointer" }}
              >
                <circle cx={x1} cy={ry} r={6} className="ex-star-agency" />
                <text x={x1 + 12} y={ry - 7} className="ex-starlabel ex-starlabel-1 ex-halo">
                  {label(r.id)}
                </text>
                <text x={x1 + 12} y={ry + 8} className="ex-edgelabel ex-halo">
                  {moneyRound(r.link.dollars)} · {plural(r.link.awards.length, "award")}
                </text>
              </g>
              {kids.map((k) => (
                <g
                  key={k.id}
                  role="button"
                  tabIndex={0}
                  aria-label={label(k.id)}
                  onClick={() => onCenter(k.id)}
                  style={{ cursor: "pointer" }}
                >
                  <circle cx={x2} cy={k.y} r={2.5} className="ex-star-company" />
                  <text x={x2 + 9} y={k.y + 4} className="ex-starlabel">
                    {label(k.id)}
                  </text>
                </g>
              ))}
            </g>
          );
        })}
        <circle cx={x0} cy={cy} r={22} className="ex-center-disk" />
        <circle cx={x0} cy={cy} r={7} className="ex-center-core" />
        <text x={x0} y={cy + 46} textAnchor="middle" className="ex-centername ex-halo" style={{ fontSize: 20 }}>
          {label(center)}
        </text>
      </svg>
    </div>
  );
}
