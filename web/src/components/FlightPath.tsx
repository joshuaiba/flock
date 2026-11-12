import type { Stage } from "@/lib/api";
import { day, money, plural } from "@/lib/format";
import { Art } from "./Art";
import "./flight-path.css";

const BIRD = 58; // width of the swallow, px

/** Days between two ISO dates, or null when either is missing. */
function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const t = (iso: string) => {
    const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((t(b) - t(a)) / 86_400_000);
}

/** "16 months", "3 weeks", "5 days": a stretch of time in the unit that suits it. */
export function span(days: number): string {
  const d = Math.abs(days);
  if (d >= 60) return plural(Math.round(d / 30.44), "month");
  if (d >= 21) return plural(Math.round(d / 7), "week");
  return plural(d, "day");
}

/** Path to production: one line from solicitation through Phase I and Phase II
 *  to a production contract. Each stage is a dot on the line with its name and
 *  date under it; the time between two stages on record is written over the
 *  stretch that joins them; one gliding swallow sits at the furthest stage
 *  reached. A hollow dot and a faint stretch are where the trail has no
 *  record. */
export function FlightPath({ stages }: { stages: Stage[] }) {
  const last = stages.length - 1;
  const furthest = stages.reduce((best, s, i) => (s.reached ? i : best), -1);
  // A stretch is flown only when there is a record at both ends; the rest are gaps.
  const flown = (i: number) => stages[i].reached && stages[i + 1].reached;
  const at = (i: number) => `${(i / last) * 100}%`;
  return (
    <div className="path">
      <div className="path-rail" aria-hidden="true">
        {stages.slice(0, -1).map((s, i) => {
          const gap = flown(i) ? daysBetween(s.date, stages[i + 1].date) : null;
          return (
            <span key={s.key} className="path-stretch" data-flown={flown(i) ? "" : undefined} style={{ left: at(i), width: at(1) }}>
              {gap != null && gap > 0 && <span className="path-gap">{span(gap)}</span>}
            </span>
          );
        })}
        {furthest >= 0 && (
          <Art
            name="props/swallow-glide-1"
            sizes={`${BIRD}px`}
            opacity={0.9}
            className="path-bird"
            style={{
              width: BIRD,
              aspectRatio: "246 / 230",
              left: at(furthest),
              // over its dot, but never off the ends of the line
              transform: `translateX(${furthest === 0 ? "-18%" : furthest === last ? "-82%" : "-50%"})`,
            }}
          />
        )}
      </div>
      <ol className="path-stages" aria-label="Path to production">
        {stages.map((s, i) => (
          <li key={s.key} data-reached={s.reached ? "" : undefined} data-end={i === 0 ? "first" : i === last ? "last" : undefined}>
            <span className="path-dot" aria-hidden="true" />
            <p className="path-name">{s.label}</p>
            {s.reached ? (
              <p className="path-when">
                {day(s.date)}
                {s.amount > 0 && (
                  <>
                    <br />
                    <span className="money">{money(s.amount)}</span>
                    {s.n > 1 && ` · ${s.n} awards`}
                  </>
                )}
              </p>
            ) : (
              <p className="path-when">{i < furthest ? "no record" : "not yet"}</p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The section's one sentence: how long the trail on record took. */
export function pathReading(stages: Stage[]): string {
  const reached = stages.filter((s) => s.reached && s.date);
  if (reached.length < 2) return "Read from award descriptions; the sources publish no stage field.";
  const first = reached[0];
  const lastReached = reached[reached.length - 1];
  const days = daysBetween(first.date, lastReached.date);
  const name = (s: Stage) => (s.key === "solicitation" ? "first solicitation" : s.key === "production" ? "a production contract" : s.label);
  if (days == null || days <= 0) return "Read from award descriptions; the sources publish no stage field.";
  return `From ${name(first)} to ${name(lastReached)} in ${span(days)}. Stages are read from award descriptions.`;
}
