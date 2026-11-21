"use client";

import { chord as d3chord, ribbon as d3ribbon } from "d3-chord";
import { arc as d3arc } from "d3-shape";
import { useMemo } from "react";
import { moneyRound } from "@/lib/format";
import { byDollars, namedCompanies, OTHERS, pct, type Model, type Named } from "@/lib/flows";
import { Hatch, useSvgId, useWidth } from "../parts";

// Variant under comparison (?viz=chord): the same dollars as a chord diagram.
// Agencies on the left arc, recipients on the right, a ribbon for each pair.
// Missions have no place in it: a chord shows one relation, not a chain.

export function FlowChord({
  model,
  who,
  selected,
  onSelect,
}: {
  model: Model;
  who: Map<string, Named>;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [frame, measured] = useWidth<HTMLDivElement>(980);
  const size = Math.max(560, Math.min(700, measured));
  const hatch = useSvgId("vc");
  const { groups, ribbons, ids } = useMemo(() => {
    const named = namedCompanies(model, 4, 11);
    const agencies = [...model.agencies.values()].sort(byDollars).map((t) => t.id);
    const companies = [...named]
      .map((id) => model.companies.get(id)!)
      .sort(byDollars)
      .map((t) => t.id);
    const ids = [...agencies, ...companies.reverse(), OTHERS];
    const at = new Map(ids.map((id, i) => [id, i]));
    const matrix = ids.map(() => ids.map(() => 0));
    for (const l of model.ac.values()) {
      const i = at.get(l.source)!;
      const j = at.get(named.has(l.target) ? l.target : OTHERS)!;
      matrix[i][j] += l.dollars;
      matrix[j][i] += l.dollars;
    }
    const layout = d3chord().padAngle(0.035)(matrix);
    return {
      groups: layout.groups,
      ribbons: [...layout].filter((c) => c.source.index < agencies.length !== c.target.index < agencies.length),
      ids,
    };
  }, [model]);
  const r = size / 2 - 150;
  const arc = d3arc<{ startAngle: number; endAngle: number }>()
    .innerRadius(r)
    .outerRadius(r + 8);
  const ribbon = d3ribbon<unknown, { startAngle: number; endAngle: number }>().radius(r - 2);
  const label = (id: string) => (id === OTHERS ? "All other companies" : (who.get(id)?.label ?? id));
  return (
    <div className="ex-scroll" ref={frame}>
      <svg
        viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`}
        width={size}
        height={size}
        role="img"
        aria-label={`Chord diagram of ${moneyRound(model.total)} between agencies and recipients.`}
        className={`ex-flow ${selected ? "ex-flow-focus" : ""}`}
        style={{ margin: "0 auto" }}
      >
        <defs>
          <Hatch id={hatch} />
        </defs>
        {ribbons.map((c, i) => {
          const a = ids[c.source.index];
          const b = ids[c.target.index];
          const on = selected === a || selected === b;
          return (
            <path
              key={i}
              d={ribbon(c as never) as unknown as string}
              className={`ex-band ${on ? "ex-band-on" : ""}`}
              style={{ fill: on ? undefined : `url(#${hatch})`, animation: "none" }}
            >
              <title>{`${label(a)} and ${label(b)}: ${moneyRound(c.source.value)}`}</title>
            </path>
          );
        })}
        {groups.map((g) => {
          const id = ids[g.index];
          const mid = (g.startAngle + g.endAngle) / 2;
          const x = Math.sin(mid) * (r + 16);
          const y = -Math.cos(mid) * (r + 16);
          const on = selected === id;
          return (
            <g
              key={id}
              className={`ex-node ${on ? "ex-node-on" : ""}`}
              role="button"
              tabIndex={0}
              aria-label={label(id)}
              onClick={() => id !== OTHERS && onSelect(on ? null : id)}
            >
              <path d={arc(g) ?? ""} className="ex-bar" />
              {g.endAngle - g.startAngle > 0.035 && (
                <text x={x} y={y + 4} textAnchor={Math.sin(mid) >= 0 ? "start" : "end"} className="ex-label">
                  {label(id)}
                  <tspan className="ex-pct" dx="6">
                    {pct(g.value / 2, model.total)}
                  </tspan>
                </text>
              )}
              <title>{`${label(id)}: ${moneyRound(g.value / 2)}`}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
