"use client";

import { cluster, hierarchy, type HierarchyPointNode } from "d3-hierarchy";
import { curveBundle, lineRadial } from "d3-shape";
import { useMemo } from "react";
import { moneyRound } from "@/lib/format";
import { byDollars, missionLabel, type Model, type Named } from "@/lib/flows";
import { useWidth } from "../parts";

// Variant under comparison (?viz=bundled): hierarchical edge bundling (Holten).
// Agencies and companies sit on one circle, companies grouped by mission, and
// each agency -> company tie is a thin line pulled toward the tree between
// them, so many ties gather into a few cords.

type Leaf = { id: string; children?: Leaf[] };

export function FlowBundled({
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
  const size = Math.max(600, Math.min(760, measured));
  const r = size / 2 - 140;
  const { leaves, lines } = useMemo(() => {
    const primary = new Map<string, string>();
    const best = new Map<string, number>();
    for (const l of model.mc.values())
      if (l.dollars > (best.get(l.target) ?? -1)) (best.set(l.target, l.dollars), primary.set(l.target, l.source));
    const top = [...model.companies.values()].sort(byDollars).slice(0, 90);
    const groups = new Map<string, Leaf[]>();
    for (const t of top) {
      const m = primary.get(t.id) ?? "tag:other";
      (groups.get(m) ?? groups.set(m, []).get(m)!).push({ id: t.id });
    }
    const root: Leaf = {
      id: "root",
      children: [
        { id: "agencies", children: [...model.agencies.values()].sort(byDollars).map((t) => ({ id: t.id })) },
        ...[...groups].map(([id, children]) => ({ id, children })),
      ],
    };
    const tree = cluster<Leaf>().size([Math.PI * 2, r])(hierarchy(root));
    const at = new Map<string, HierarchyPointNode<Leaf>>();
    tree.leaves().forEach((n) => at.set(n.data.id, n));
    const line = lineRadial<HierarchyPointNode<Leaf>>()
      .curve(curveBundle.beta(0.85))
      .radius((d) => d.y)
      .angle((d) => d.x);
    const max = Math.max(1, ...[...model.ac.values()].map((l) => l.dollars));
    const lines = [...model.ac.values()]
      .filter((l) => at.has(l.source) && at.has(l.target))
      .map((l) => ({
        key: l.key,
        source: l.source,
        target: l.target,
        dollars: l.dollars,
        d: line(at.get(l.source)!.path(at.get(l.target)!)) ?? "",
        w: 0.5 + 3.5 * Math.sqrt(l.dollars / max),
      }));
    return { leaves: tree.leaves(), lines };
  }, [model, r]);
  const label = (id: string) => who.get(id)?.label ?? id;
  return (
    <div className="ex-scroll" ref={frame}>
      <svg
        viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`}
        width={size}
        height={size}
        role="img"
        aria-label={`Bundled edges for ${moneyRound(model.total)} between agencies and the 90 largest recipients.`}
        className="ex-star"
        style={{ margin: "0 auto" }}
      >
        {lines.map((l) => {
          const on = selected === l.source || selected === l.target;
          return (
            <path
              key={l.key}
              d={l.d}
              fill="none"
              stroke={on ? "var(--accent-light)" : "var(--accent)"}
              strokeWidth={l.w}
              opacity={selected ? (on ? 0.95 : 0.06) : 0.32}
            >
              <title>{`${label(l.source)} to ${label(l.target)}: ${moneyRound(l.dollars)}`}</title>
            </path>
          );
        })}
        {leaves.map((n) => {
          const id = n.data.id;
          const deg = (n.x * 180) / Math.PI - 90;
          const flip = n.x >= Math.PI;
          const agency = who.get(id)?.kind !== "company";
          return (
            <g
              key={id}
              transform={`rotate(${deg}) translate(${n.y + 6},0)`}
              role="button"
              tabIndex={0}
              aria-label={label(id)}
              onClick={() => onSelect(selected === id ? null : id)}
              style={{ cursor: "pointer" }}
            >
              <circle r={agency ? 3.5 : 1.8} fill={agency ? "var(--accent)" : "var(--text)"} />
              <text
                x={flip ? -8 : 8}
                y={3}
                textAnchor={flip ? "end" : "start"}
                transform={flip ? "rotate(180)" : undefined}
                style={{
                  fontSize: agency ? 11 : 8.5,
                  fill: selected === id ? "var(--accent-light)" : agency ? "var(--text)" : "var(--muted)",
                }}
              >
                {label(id).slice(0, 26)}
              </text>
              <title>{`${who.get(id)?.full ?? id}${n.parent && n.parent.data.id.startsWith("tag:") ? ` · ${missionLabel(n.parent.data.id.slice(4))}` : ""}`}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
