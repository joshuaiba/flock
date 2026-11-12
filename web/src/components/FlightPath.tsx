import type { Stage } from "@/lib/api";
import { day, money } from "@/lib/format";
import { Art } from "./Art";

const BIRD = 50; // width of the swallow, px

/** Path to production: a flight path from solicitation through Phase I and
 *  Phase II to a production contract, drawn as an inked dashed line with a
 *  gliding swallow just above the furthest stage reached. Faint stretches are
 *  where the trail has no record. It sits on a plaster card. */
export function FlightPath({ stages }: { stages: Stage[] }) {
  const furthest = stages.reduce((best, s, i) => (s.reached ? i : best), -1);
  // A stretch is flown only when there is a record at both ends; the rest are gaps.
  const flown = (i: number) => i >= 0 && i < stages.length - 1 && stages[i].reached && stages[i + 1].reached;
  const seg = (on: boolean, hidden: boolean) =>
    `flex-1 border-t border-dashed ${hidden ? "border-transparent" : on ? "border-ink" : "border-line2"}`;
  return (
    <ol className="grid grid-cols-4" aria-label="Path to production">
      {stages.map((s, i) => (
        <li key={s.key} className="flex flex-col items-center text-center">
          <div className="flex h-14 items-end justify-center" aria-hidden="true">
            {i === furthest && (
              <Art
                name="props/swallow-glide-2"
                sizes={`${BIRD}px`}
                opacity={1}
                className="mb-0.5"
                style={{ width: BIRD, aspectRatio: "135 / 104" }}
              />
            )}
          </div>
          <div className="flex w-full items-center">
            <span className={seg(flown(i - 1), i === 0)} />
            {/* a roundel: struck when reached, an empty ring when not */}
            <span
              className={`mx-1.5 h-4 w-4 shrink-0 rounded-full border ${
                s.reached
                  ? "border-ink bg-ink shadow-[inset_0_0_0_2px_var(--card)]"
                  : i < furthest
                    ? "border-dashed border-muted"
                    : "border-line2"
              }`}
            />
            <span className={seg(flown(i), i === stages.length - 1)} />
          </div>
          <p className={`mt-3 font-display text-[1.05rem] leading-tight sm:text-[1.35rem] ${s.reached ? "" : "text-muted"}`}>{s.label}</p>
          {s.reached ? (
            <p className="fig mt-1 text-muted">
              {day(s.date)}
              {s.amount > 0 && (
                <>
                  <br />
                  <span className="text-accent">{money(s.amount)}</span>
                  {s.n > 1 && ` · ${s.n} awards`}
                </>
              )}
            </p>
          ) : (
            <p className="mt-1 italic text-muted">{i < furthest ? "no record" : "not yet"}</p>
          )}
        </li>
      ))}
    </ol>
  );
}
