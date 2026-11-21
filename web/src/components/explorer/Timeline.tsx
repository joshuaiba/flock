"use client";

import { useMemo, useRef, useState } from "react";
import { day, moneyRound } from "@/lib/format";
import {
  dayNumber,
  isoDay,
  missionLabel,
  r1,
  tickHeight,
  type Award,
  type Named,
  type Solicitation,
} from "@/lib/flows";
import { Diamond, useTip, useWidth } from "./parts";

// The timeline: one tick per award across the window, as tall as its dollars
// (a log scale), in copper when it belongs to the selection. A brush over it
// (drag, or the arrow keys on its handles) narrows every view to those days.
// Solicitations sit on their own line as steel diamonds, hollow until an award
// answers them. As a strip it is one row; as the Timeline view it is one row
// per mission, sharing the days axis and the brush.
//
// Every tick is a link to its award's source record.

const PAD = 22; // room left and right of the axis
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type Brush = { from: string; to: string } | null;

type Row = { key: string; label: string | null; dollars: number; awards: Award[] };

export function Timeline({
  awards,
  solicitations,
  start,
  end,
  brush,
  onBrush,
  marked,
  fresh,
  who,
  rows = "one",
}: {
  /** the window's awards after every filter except the brush */
  awards: Award[];
  solicitations: Solicitation[];
  start: string;
  end: string;
  brush: Brush;
  onBrush: (b: Brush) => void;
  /** awards of the selection: drawn in copper */
  marked: ReadonlySet<number> | null;
  /** awards loaded since the last visit: drawn at full strength, the rest dimmed */
  fresh: ReadonlySet<number> | null;
  who: Map<string, Named>;
  rows?: "one" | "missions";
}) {
  const [frame, measured] = useWidth<HTMLDivElement>(980);
  const width = Math.max(rows === "one" ? 320 : 640, measured);
  const svg = useRef<SVGSVGElement>(null);
  const { tip, show, hide } = useTip();
  const [drag, setDrag] = useState<null | {
    mode: "new" | "move" | "from" | "to";
    anchor: number;
    from: number;
    to: number;
  }>(null);

  const d0 = dayNumber(start);
  const d1 = dayNumber(end);
  const days = Math.max(1, d1 - d0);
  const left = rows === "missions" ? 190 : PAD;
  const inner = width - left - PAD;
  const x = (n: number) => r1(left + ((n - d0) / days) * inner);
  const dayAt = (clientX: number) => {
    const box = svg.current!.getBoundingClientRect();
    const px = ((clientX - box.left) / box.width) * width;
    return Math.round(Math.min(d1, Math.max(d0, d0 + ((px - left) / inner) * days)));
  };

  const list: Row[] = useMemo(() => {
    if (rows === "one") return [{ key: "all", label: null, dollars: 0, awards }];
    const by = new Map<string, Row>();
    for (const a of awards)
      for (const m of a.missions) {
        let r = by.get(m);
        if (!r) by.set(m, (r = { key: m, label: missionLabel(m), dollars: 0, awards: [] }));
        r.awards.push(a);
        r.dollars += (a.amount ?? 0) / a.missions.length;
      }
    return [...by.values()].sort((a, b) => b.dollars - a.dollars);
  }, [awards, rows]);

  const max = useMemo(() => awards.reduce((m, a) => Math.max(m, a.amount ?? 0), 0), [awards]);
  const rowH = rows === "one" ? 62 : 46;
  const tall = rows === "one" ? 56 : 38;
  const top = solicitations.length ? 30 : 12;
  const axisY = (i: number) => top + rowH * (i + 1);
  const height = top + rowH * list.length + 26;

  const b = brush ? { from: dayNumber(brush.from), to: dayNumber(brush.to) } : null;
  const live = drag ? { from: Math.min(drag.from, drag.to), to: Math.max(drag.from, drag.to) } : b;
  const inside = (iso: string) => !live || (dayNumber(iso) >= live.from && dayNumber(iso) <= live.to);
  const commit = (from: number, to: number) => {
    const lo = Math.max(d0, Math.min(from, to));
    const hi = Math.min(d1, Math.max(from, to));
    // The whole window brushed is no brush at all.
    onBrush(lo <= d0 && hi >= d1 ? null : { from: isoDay(lo), to: isoDay(hi) });
  };

  const begin = (e: React.PointerEvent, mode: "new" | "move" | "from" | "to") => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    svg.current?.setPointerCapture(e.pointerId);
    const at = dayAt(e.clientX);
    const cur = b ?? { from: d0, to: d1 };
    setDrag(mode === "new" ? { mode, anchor: at, from: at, to: at } : { mode, anchor: at, ...cur });
  };
  const moveTo = (e: React.PointerEvent) => {
    if (!drag) return;
    const at = dayAt(e.clientX);
    let next = drag;
    if (drag.mode === "new") next = { ...drag, to: at };
    else if (drag.mode === "from") next = { ...drag, from: Math.min(at, drag.to) };
    else if (drag.mode === "to") next = { ...drag, to: Math.max(at, drag.from) };
    else {
      const cur = b ?? { from: d0, to: d1 };
      const shift = Math.max(d0 - cur.from, Math.min(d1 - cur.to, at - drag.anchor));
      next = { ...drag, from: cur.from + shift, to: cur.to + shift };
    }
    setDrag(next);
    if (next.from !== next.to || drag.mode !== "new") commit(next.from, next.to);
  };
  const finish = (e: React.PointerEvent) => {
    if (!drag) return;
    svg.current?.releasePointerCapture(e.pointerId);
    // A click without a drag on the empty axis clears the brush.
    if (drag.mode === "new" && drag.from === drag.to) onBrush(null);
    setDrag(null);
  };
  const nudge = (which: "from" | "to") => (e: React.KeyboardEvent) => {
    const step = (e.shiftKey ? 7 : 1) * (e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0);
    if (e.key === "Escape" || e.key === "Delete") return onBrush(null);
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const cur = b ?? { from: d0, to: d1 };
      return which === "from"
        ? commit(e.key === "Home" ? d0 : cur.to, cur.to)
        : commit(cur.from, e.key === "End" ? d1 : cur.from);
    }
    if (!step) return;
    e.preventDefault();
    const cur = b ?? { from: d0, to: d1 };
    if (which === "from") commit(Math.min(cur.to, Math.max(d0, cur.from + step)), cur.to);
    else commit(cur.from, Math.max(cur.from, Math.min(d1, cur.to + step)));
  };

  // Month marks along the foot, and the window's two ends in words.
  const months: { n: number; label: string }[] = [];
  {
    const first = new Date(d0 * 86_400_000);
    let y = first.getUTCFullYear();
    let m = first.getUTCMonth() + 1;
    const stepBy = days > 800 ? 6 : days > 400 ? 3 : 1;
    for (;;) {
      if (m > 11) {
        m -= 12;
        y += 1;
      }
      const n = Math.round(Date.UTC(y, m, 1) / 86_400_000);
      if (n >= d1) break;
      // A month mark too close to either end would print over the end's date.
      if (((n - d0) / days) * inner > 58 && ((d1 - n) / days) * inner > 58)
        months.push({ n, label: m === 0 || days > 400 ? `${MONTHS[m]} ${y}` : MONTHS[m] });
      m += stepBy;
    }
  }

  const cur = b ?? { from: d0, to: d1 };
  const bx0 = x(live ? live.from : d0);
  const bx1 = x(live ? live.to : d1);
  const footY = axisY(list.length - 1);

  return (
    <div className="ex-scroll" ref={frame}>
      <svg
        ref={svg}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="group"
        aria-label={`Awards from ${day(start)} to ${day(end)}: ${awards.length.toLocaleString("en-US")} awards${brush ? `, narrowed to ${day(brush.from, true)} through ${day(brush.to, true)}` : ""}.`}
        className={`ex-time ${fresh ? "ex-time-fresh" : ""} ${drag ? "ex-time-drag" : ""}`}
        style={{ maxWidth: "100%", height: "auto", touchAction: "pan-y" }}
        onPointerMove={moveTo}
        onPointerUp={finish}
        onPointerCancel={finish}
      >
        {/* the ground: dragging on it draws a new brush */}
        <rect
          x={left}
          y={0}
          width={inner}
          height={footY + 4}
          className="ex-time-ground"
          onPointerDown={(e) => begin(e, "new")}
        />

        {list.map((r, i) => (
          <g key={r.key}>
            <line x1={left} y1={axisY(i)} x2={left + inner} y2={axisY(i)} className="ex-axis" />
            {r.label && (
              <>
                <text x={left - 14} y={axisY(i) - 12} textAnchor="end" className="ex-rowlabel">
                  {r.label}
                </text>
                <text x={left - 14} y={axisY(i) + 1} textAnchor="end" className="ex-rowsub">
                  {moneyRound(r.dollars)} · {r.awards.length}
                </text>
              </>
            )}
            {r.awards.map((a) => {
              const cx = x(dayNumber(a.day));
              const h = tickHeight(a.amount, max, tall);
              const cls = [
                "ex-tick",
                marked?.has(a.id) ? "ex-tick-on" : "",
                fresh?.has(a.id) ? "ex-tick-new" : "",
                inside(a.day) ? "" : "ex-tick-out",
              ]
                .filter(Boolean)
                .join(" ");
              const text = `${who.get(a.agency)?.label ?? "An agency"} to ${who.get(a.company)?.label ?? "a company"}, ${moneyRound(a.amount)}, ${day(a.day)}`;
              const note = (
                <>
                  <strong>
                    {who.get(a.agency)?.label ?? "An agency"} → {who.get(a.company)?.label ?? "a company"}
                  </strong>
                  <span className="ex-tip-row">
                    <span className="money">{moneyRound(a.amount)}</span>
                    <span>{day(a.day)}</span>
                  </span>
                  <span className="ex-tip-row">{a.missions.map(missionLabel).join(" · ")}</span>
                  <span className="ex-tip-hint">Click to open the source record</span>
                </>
              );
              const mark = <line x1={cx} y1={axisY(i)} x2={cx} y2={axisY(i) - h} />;
              const over = {
                onPointerMove: (e: React.PointerEvent) => show(e, note),
                onPointerLeave: hide,
                onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
              };
              return a.url ? (
                <a
                  key={`${r.key}:${a.id}`}
                  href={a.url}
                  target="_blank"
                  rel="noreferrer"
                  className={cls}
                  aria-label={text}
                  {...over}
                >
                  {mark}
                </a>
              ) : (
                <g key={`${r.key}:${a.id}`} className={cls} {...over}>
                  <title>{text}</title>
                  {mark}
                </g>
              );
            })}
          </g>
        ))}

        {solicitations.map((s) => {
          if (!s.posted) return null;
          const n = dayNumber(s.posted);
          if (n < d0 || n > d1) return null;
          const note = (
            <>
              <strong>{s.title}</strong>
              <span className="ex-tip-row">
                <span>{who.get(s.agency)?.label ?? "An agency"} · solicitation</span>
              </span>
              <span className="ex-tip-row">
                Posted {day(s.posted, true)}
                {s.awarded_on
                  ? ` · awarded ${day(s.awarded_on, true)}`
                  : s.open && s.closes
                    ? ` · closes ${day(s.closes, true)}`
                    : " · no award yet"}
              </span>
            </>
          );
          const text = `Solicitation: ${s.title}, posted ${day(s.posted)}${s.awarded_on ? `, awarded ${day(s.awarded_on)}` : ", not yet awarded"}`;
          const cls = `ex-sol ${inside(s.posted) ? "" : "ex-tick-out"}`;
          const over = {
            onPointerMove: (e: React.PointerEvent) => show(e, note),
            onPointerLeave: hide,
            onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
          };
          const mark = <Diamond x={x(n)} y={14} filled={!!s.awarded_on} />;
          return s.url ? (
            <a key={s.id} href={s.url} target="_blank" rel="noreferrer" className={cls} aria-label={text} {...over}>
              {mark}
            </a>
          ) : (
            <g key={s.id} className={cls} {...over}>
              <title>{text}</title>
              {mark}
            </g>
          );
        })}

        {/* the brush */}
        {live && (
          <rect
            x={bx0}
            y={4}
            width={Math.max(2, bx1 - bx0)}
            height={footY}
            className="ex-brush"
            onPointerDown={(e) => begin(e, "move")}
          >
            <title>Drag to move the selected days</title>
          </rect>
        )}
        {(["from", "to"] as const).map((which) => {
          const at = which === "from" ? bx0 : bx1;
          const value = which === "from" ? cur.from : cur.to;
          return (
            <g
              key={which}
              role="slider"
              tabIndex={0}
              aria-label={which === "from" ? "First day shown" : "Last day shown"}
              aria-valuemin={d0}
              aria-valuemax={d1}
              aria-valuenow={value}
              aria-valuetext={day(isoDay(value))}
              className={`ex-handle ${live ? "" : "ex-handle-idle"}`}
              onPointerDown={(e) => begin(e, which)}
              onKeyDown={nudge(which)}
            >
              <rect x={at - 9} y={4} width={18} height={footY} className="ex-hit" />
              <rect
                x={at - 3}
                y={rows === "one" ? footY / 2 - 11 : 2}
                width={6}
                height={rows === "one" ? 30 : 22}
                rx={3}
              />
            </g>
          );
        })}

        <text x={left} y={footY + 18} className="ex-timelabel">
          {day(start, true)}
        </text>
        {months.map((mo) => (
          <text key={mo.n} x={x(mo.n)} y={footY + 18} textAnchor="middle" className="ex-timelabel">
            {mo.label}
          </text>
        ))}
        <text x={left + inner} y={footY + 18} textAnchor="end" className="ex-timelabel">
          {day(end, true)}
        </text>
      </svg>
      {tip}
    </div>
  );
}
