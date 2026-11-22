"use client";

import { useMemo, useState } from "react";
import { moneyRound, plural } from "@/lib/format";
import { layoutSankey, OTHERS, pct, type Model, type Named, type SankeyBand, type SankeyNode } from "@/lib/flows";
import { Hatch, useSvgId, useTip, useWidth } from "./parts";

// The flow: who pays whom, as a three-column Sankey. Agency -> Mission ->
// Recipient, every band as wide as its dollars and filled with the engraving
// hatch. It answers the page's headline directly: the three tallest bars on
// the left are the agencies the sentence names.
//
// Selecting a node turns its bands copper and leaves the rest grey; hovering a
// band isolates it. Companies outside the top few of each mission are folded
// into one "All other companies" node, which opens on click. The layout is
// computed, never simulated (lib/flows.ts layoutSankey): the same data always
// draws the same picture, and nothing moves unless the data or the reader does.

const NARROW = 760; // below this the drawing keeps its width and the frame scrolls

export type Fresh = { awards: ReadonlySet<number>; companies: ReadonlySet<string> } | null;

export function FlowView({
  model,
  who,
  order,
  selected,
  onSelect,
  fresh,
  gen,
  label,
}: {
  model: Model;
  who: Map<string, Named>;
  /** the whole window's ranking: keeps nodes in place when filters change */
  order: Map<string, number>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** what is new since the reader's last visit, when that toggle is on */
  fresh: Fresh;
  /** changes when new data arrives, which is when the bands ink in */
  gen: number;
  /** the window in words, for the drawing's description */
  label: string;
}) {
  const [frame, measured] = useWidth<HTMLDivElement>(980);
  const [open, setOpen] = useState(false); // the folded tail, opened
  const [hover, setHover] = useState<string | null>(null);
  const { tip, show, hide } = useTip();
  const hatch = useSvgId("fh");
  const width = Math.max(NARROW, measured);

  const sankey = useMemo(
    () =>
      layoutSankey(model, who, order, {
        width,
        minHeight: open ? 620 : 560,
        perMission: open ? 12 : 4,
        maxNamed: open ? 34 : 11,
        left: 172,
        right: width < 900 ? 232 : 250,
      }),
    [model, who, order, width, open],
  );

  const total = model.total;
  // A name longer than its gutter is cut with an ellipsis (about 6.4px a
  // letter at this size); the tooltip and the inspector spell it out.
  const fit = (text: string, px: number) => {
    const max = Math.max(8, Math.floor(px / 6.4));
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  };
  const right = width < 900 ? 232 : 250;
  const focus = hover ?? selected;
  const touches = (b: SankeyBand, id: string | null) => !!id && (b.key === id || b.source === id || b.target === id);
  const lit = new Set<string>();
  if (selected) for (const b of sankey.bands) if (touches(b, selected)) lit.add(b.source).add(b.target);

  const isFresh = (b: SankeyBand) => !!fresh && b.awards.length > 0 && b.awards.every((a) => fresh.awards.has(a.id));
  const name = (id: string) => (id === OTHERS ? "all other companies" : (who.get(id)?.label ?? id));

  const bandNote = (b: SankeyBand) => (
    <>
      <strong>
        {name(b.source)} → {name(b.target)}
      </strong>
      <span className="ex-tip-row">
        <span className="money">{moneyRound(b.dollars)}</span>
        <span>
          {pct(b.dollars, total)} of dollars · {plural(b.awards.length, "award")}
        </span>
      </span>
      <span className="ex-tip-hint">Click to open its records</span>
    </>
  );
  const nodeNote = (n: SankeyNode) => (
    <>
      <strong>{n.id === OTHERS ? n.label : (who.get(n.id)?.full ?? n.label)}</strong>
      <span className="ex-tip-row">
        <span className="money">{moneyRound(n.dollars)}</span>
        <span>
          {pct(n.dollars, total)} of dollars · {plural(n.awards, "award")}
        </span>
      </span>
      <span className="ex-tip-hint">
        {n.id === OTHERS ? (open ? "Click to fold the list back" : "Click to list more companies") : "Click to select"}
      </span>
    </>
  );

  if (!(total > 0)) return null;
  const [x0, x1, x2] = sankey.cols;
  const colLabel = ["Agency", "Mission", "Recipient"];

  return (
    <div className="ex-scroll" ref={frame}>
      <svg
        viewBox={`0 0 ${sankey.width} ${sankey.height}`}
        width={sankey.width}
        height={sankey.height}
        role="img"
        aria-label={`Flow of ${moneyRound(total)} in autonomy awards, ${label}: from ${sankey.nodes.filter((n) => n.col === 0).length} agencies through ${sankey.nodes.filter((n) => n.col === 1).length} missions to recipients. ${sankey.nodes
          .filter((n) => n.col === 0)
          .slice(0, 3)
          .map((n) => `${n.label} ${pct(n.dollars, total)}`)
          .join(", ")}.`}
        className={`ex-flow ${focus ? "ex-flow-focus" : ""} ${fresh ? "ex-flow-fresh" : ""}`}
        style={{ maxWidth: measured >= NARROW ? "100%" : undefined, height: measured >= NARROW ? "auto" : undefined }}
      >
        <defs>
          <Hatch id={hatch} />
        </defs>
        {[x0, x1, x2].map((x, i) => (
          <text key={i} x={i === 0 ? x + 8 : x} y={16} textAnchor={i === 0 ? "end" : "start"} className="ex-colhead">
            {colLabel[i]}
          </text>
        ))}

        <g key={gen} className="ex-bands">
          {sankey.bands.map((b, i) => {
            const on = touches(b, selected);
            const hot = touches(b, hover);
            const cls = [
              "ex-band",
              b.target === OTHERS || who.get(b.target)?.kind === "company" ? "ex-band-far" : "",
              on ? "ex-band-on" : "",
              hot ? "ex-band-hot" : "",
              isFresh(b) ? "ex-band-fresh" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <path
                key={b.key}
                d={b.d}
                pathLength={1}
                className={cls}
                style={{
                  fill: on ? undefined : `url(#${hatch})`,
                  animationDelay: `${Math.min(1.4, i * 0.035).toFixed(2)}s`,
                }}
                onClick={() => onSelect(selected === b.key ? null : b.key)}
                onPointerMove={(e) => show(e, bandNote(b))}
                onPointerEnter={() => setHover(b.key)}
                onPointerLeave={() => {
                  setHover(null);
                  hide();
                }}
              >
                <title>{`${name(b.source)} to ${name(b.target)}: ${moneyRound(b.dollars)}, ${pct(b.dollars, total)} of dollars, ${plural(b.awards.length, "award")}`}</title>
              </path>
            );
          })}
        </g>

        {sankey.nodes.map((n) => {
          const on = selected === n.id;
          const isOthers = n.id === OTHERS;
          const share = pct(n.dollars, total);
          const mid = n.y + n.h / 2 + 4.5;
          const newcomer = !!fresh && fresh.companies.has(n.id);
          const cls = [
            "ex-node",
            on ? "ex-node-on" : "",
            !on && lit.has(n.id) ? "ex-node-lit" : "",
            focus && !on && !lit.has(n.id) && hover !== n.id ? "ex-node-quiet" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const act = () => (isOthers ? setOpen((o) => !o) : onSelect(on ? null : n.id));
          return (
            <g
              key={n.id}
              className={cls}
              role="button"
              tabIndex={0}
              aria-pressed={isOthers ? undefined : on}
              aria-expanded={isOthers ? open : undefined}
              aria-label={`${isOthers ? n.label : (who.get(n.id)?.full ?? n.label)}: ${moneyRound(n.dollars)}, ${share} of dollars, ${plural(n.awards, "award")}`}
              onClick={act}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  act();
                }
              }}
              onPointerMove={(e) => show(e, nodeNote(n))}
              onPointerEnter={() => setHover(isOthers ? null : n.id)}
              onPointerLeave={() => {
                setHover(null);
                hide();
              }}
            >
              {/* a taller invisible target, so a hairline node can still be hit */}
              <rect
                x={n.col === 0 ? 0 : n.x - 4}
                y={n.y + n.h / 2 - Math.max(8, n.h / 2)}
                width={n.col === 0 ? n.x + sankey.bar + 4 : n.col === 2 ? sankey.width - n.x + 4 : sankey.bar + 180}
                height={Math.max(16, n.h)}
                className="ex-hit"
              />
              <rect x={n.x} y={n.y} width={sankey.bar} height={n.h} className="ex-bar" />
              {newcomer && <circle cx={n.x + sankey.bar / 2} cy={n.y + n.h / 2} r={7} className="ex-newring" />}
              {n.col === 0 ? (
                <text x={n.x - 10} y={mid} textAnchor="end" className="ex-label">
                  {fit(n.label, 126)}
                  <tspan className="ex-pct" dx="7">
                    {share}
                  </tspan>
                </text>
              ) : (
                <text
                  x={n.x + sankey.bar + 8}
                  y={mid}
                  className={`ex-label ${n.col === 1 ? "ex-halo" : ""} ${isOthers ? "ex-label-fold" : ""}`}
                >
                  {n.col === 2
                    ? fit(n.label, right - (isOthers ? 62 : newcomer ? 130 : 56))
                    : fit(n.label, x2 - x1 - 20)}
                  {/* a mission's share is dropped when its name leaves no room for it */}
                  {(n.col === 2 || n.label.length * 6.4 + 52 < x2 - x1) && (
                    <tspan className="ex-pct" dx="7">
                      {share}
                    </tspan>
                  )}
                  {isOthers && (
                    <tspan className="ex-fold" dx="6">
                      {open ? "−" : "+"}
                    </tspan>
                  )}
                  {newcomer && (
                    <tspan className="ex-newtag" dx="7">
                      first award
                    </tspan>
                  )}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {tip}
    </div>
  );
}
