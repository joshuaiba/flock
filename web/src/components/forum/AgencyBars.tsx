"use client";

import { useState } from "react";
import { OrgLink } from "@/components/Signals";
import { money, plural } from "@/lib/format";
import { FAMILY_LABEL, type Family, type SignalOrg } from "@/lib/signals";

/** One colored piece of a bar: a category family's dollars at this agency. */
export type AgencySegment = {
  family: Family;
  amount: number;
  /** share of the agency's categorized dollars, 0 to 1 */
  share: number;
  /** the categories behind the family, in words */
  categories: string;
};
export type AgencyBar = {
  org: SignalOrg;
  amount: number;
  /** bar length against the longest bar, 0 to 1 */
  frac: number;
  posted: number;
  /** the mix spelled out: "Maritime 62%, Swarming 30%" */
  words: string;
  segments: AgencySegment[];
};

// Room kept at the right of the track for the amount written at the bar's tip.
const TIP_ROOM = "5.5rem";

/** Sorted horizontal bars: award dollars per agency, each bar split by category
 *  family. Hovering a piece (or focusing the bar and using the arrow keys)
 *  names the family, its dollars and its share. The same split is written out
 *  under every bar, so nothing here is told by color alone. */
export function AgencyBars({ bars }: { bars: AgencyBar[] }) {
  const [at, setAt] = useState<{ row: number; seg: number } | null>(null);
  return (
    <ul className="border-t border-line2">
      {bars.map((b, i) => {
        const open = at?.row === i ? b.segments[at.seg] : undefined;
        // where the open piece's middle sits along the bar, 0 to 1
        const mid = open ? b.segments.slice(0, at!.seg).reduce((s, x) => s + x.share, 0) + open.share / 2 : 0;
        // and along the whole row, to keep the tooltip inside the panel
        const across = mid * b.frac * 0.8;
        return (
          <li key={b.org.id} className="border-b border-line py-2.5">
            {/* On a phone the count drops to its own line, so the name keeps
                the row: "Department of the Army" and "Department of the Air
                Force" must not both be cut to "Department of…". */}
            <div className="forum-name flex flex-wrap items-center justify-between gap-x-4">
              <OrgLink org={b.org} size={22} />
              {b.posted > 0 && <span className="ui shrink-0 text-muted">{plural(b.posted, "solicitation")} posted</span>}
            </div>
            {b.amount > 0 ? (
              <div className="flex items-center gap-2">
                <div
                  className="relative flex h-7 min-w-[6px] items-center gap-[2px] rounded-[4px]"
                  style={{ width: `calc((100% - ${TIP_ROOM}) * ${b.frac.toFixed(4)})` }}
                  tabIndex={0}
                  role="img"
                  aria-label={`${b.org.name}: ${money(b.amount)}${b.words ? `. ${b.words}` : ""}`}
                  // A click focuses the bar too: keep the piece the pointer chose.
                  onFocus={() => setAt((cur) => (cur?.row === i ? cur : { row: i, seg: 0 }))}
                  onBlur={() => setAt(null)}
                  onPointerLeave={() => setAt(null)}
                  onKeyDown={(e) => {
                    const last = b.segments.length - 1;
                    if (last < 0) return;
                    const cur = at?.row === i ? at.seg : 0;
                    if (e.key === "ArrowRight") setAt({ row: i, seg: Math.min(last, cur + 1) });
                    if (e.key === "ArrowLeft") setAt({ row: i, seg: Math.max(0, cur - 1) });
                    if (e.key === "Escape") setAt(null);
                  }}
                >
                  {b.segments.length === 0 ? (
                    // Dollars with no category behind them: one plain bar.
                    <span className="block h-4 w-full rounded-r-[4px] bg-muted/50" />
                  ) : (
                    b.segments.map((s, j) => (
                      // The piece's hit area is the full 28px row; the mark is 16px.
                      <span
                        key={s.family}
                        className="flex h-full min-w-[3px] basis-0 items-center"
                        style={{ flexGrow: s.share }}
                        onPointerEnter={() => setAt({ row: i, seg: j })}
                        onPointerDown={() => setAt({ row: i, seg: j })}
                      >
                        <span
                          className={`block h-4 w-full ${j === b.segments.length - 1 ? "rounded-r-[4px]" : ""}`}
                          style={{
                            background: `var(--chart-${s.family})`,
                            // a fine ink outline keeps the palest washes visible on plaster
                            boxShadow: "inset 0 0 0 1px var(--line2)",
                          }}
                        />
                      </span>
                    ))
                  )}
                  {open && (
                    <div
                      className="tip w-max max-w-[15rem] whitespace-normal"
                      aria-hidden="true"
                      style={{
                        left: `${mid * 100}%`,
                        bottom: "100%",
                        transform: `translateX(${across < 0.28 ? "-12%" : across > 0.62 ? "-88%" : "-50%"})`,
                      }}
                    >
                      {FAMILY_LABEL[open.family]}
                      <br />
                      {money(open.amount)} · {open.share < 0.005 ? "under 1%" : `${Math.round(open.share * 100)}%`}
                      <br />
                      <span className="text-muted">{open.categories}</span>
                    </div>
                  )}
                </div>
                <span className="forum-num shrink-0 text-accent">{money(b.amount)}</span>
              </div>
            ) : (
              <p className="ui mt-1 text-muted">no awards in this window</p>
            )}
            {b.words && <p className="ui text-muted">{b.words}</p>}
          </li>
        );
      })}
    </ul>
  );
}
