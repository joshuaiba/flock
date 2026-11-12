import Link from "next/link";
import { serverGet } from "@/lib/api";
import { day, money, plural } from "@/lib/format";
import { priorLabel, signalPath, STAGE_LABEL, windowLabel, type OrgSignals } from "@/lib/signals";
import { tagLabel } from "@/lib/tags";
import { AsOf, Delta, RankChange, StageTrack } from "./Signals";

// The entity page's signals row: how one organization stands in the last 90
// days. Four readings for a company (dollars, rank, stage reached, the last
// award), three for an agency or office (no stages), in one hairline row like
// the Forum's summary. Every figure comes from GET /api/signals/orgs/ID,
// which reads the same views as the Forum, so the two cannot disagree.

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th", 23 -> "23rd". */
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** One reading: a quiet label, the figure, and the lines that qualify it. */
function Reading({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="forum-kpi">
      <dt className="forum-kpi-label">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const BIG = "figure mt-2 !text-[2rem]";
const SMALL = "mt-1.5 text-muted";

/** The frame is the page's own wrapper, passed in so this block can leave the
 *  page without a trace: it renders nothing when the API is down or the
 *  organization has no awards. */
export async function EntitySignals({
  id,
  Frame,
}: {
  id: number;
  Frame: React.ComponentType<{ children: React.ReactNode }>;
}) {
  const s = await serverGet<OrgSignals>(signalPath(`orgs/${id}`, {}));
  if (!s || !s.last_award_day) return null;

  const company = s.org.kind === "company";
  const compared = s.coverage.prior_complete;
  const peers = company ? "companies" : "agencies and offices";
  const since = s.days_since_last;

  return (
    <Frame>
      <dl className={`forum-kpis ${company ? "" : "forum-kpis-3"}`}>
        <Reading label={`${company ? "Awarded" : "Obligated"}, last ${windowLabel(s.window_days)}`}>
          <p className={`${BIG} money`}>{money(s.amount)}</p>
          <p className={SMALL}>
            {/* The API withholds a percentage when the prior period is too
                small to divide by; then only the dollar change is shown. */}
            {compared && s.pct == null && s.prev_amount > 0 ? (
              <>too little in {priorLabel(s.window_days)} for a percentage</>
            ) : (
              <Delta cur={s.amount} prev={s.prev_amount} env={s} />
            )}
          </p>
          {/* With nothing before, the change would only repeat the figure above. */}
          {compared && s.prev_amount > 0 && s.delta !== 0 && (
            <p className="text-muted">
              a change of{" "}
              <span className="delta text-ink">
                {s.delta > 0 ? "+" : "−"}
                {money(Math.abs(s.delta))}
              </span>
            </p>
          )}
        </Reading>

        <Reading label="Rank by dollars">
          {s.rank == null ? (
            <>
              <p className={`${BIG} text-muted`}>unranked</p>
              <p className={SMALL}>
                no awards in the last {windowLabel(s.window_days)}
                {compared && s.prev_rank != null && <>; {ordinal(s.prev_rank)} in the period before</>}
              </p>
            </>
          ) : (
            <>
              <p className={BIG}>{ordinal(s.rank)}</p>
              <p className={SMALL}>
                of {peers}
                {compared && (
                  <>
                    {" "}
                    <RankChange rank={s.rank} prev={s.prev_rank} />
                  </>
                )}
              </p>
              {s.category && s.category_rank != null && (
                <p className="text-muted">
                  <span className="text-ink">{ordinal(s.category_rank)}</span> in{" "}
                  <Link href={`/forum/leaderboards?tag=${encodeURIComponent(s.category)}`}>{tagLabel(s.category)}</Link>{" "}
                  {compared && <RankChange rank={s.category_rank} prev={s.category_prev_rank} />}
                </p>
              )}
            </>
          )}
        </Reading>

        {company && (
          <Reading label="Furthest stage">
            {s.stage ? (
              <>
                <p className={BIG}>{STAGE_LABEL[s.stage]}</p>
                <StageTrack path={s.path} className="mt-2.5" />
                <p className="mt-1 text-muted">first seen there {day(s.stage_day)}</p>
              </>
            ) : (
              <>
                <p className={`${BIG} text-muted`}>none on record</p>
                <StageTrack path={s.path} className="mt-2.5" />
                <p className="mt-1 text-muted">no award description names a stage</p>
              </>
            )}
          </Reading>
        )}

        <Reading label="Last award">
          <p className={BIG}>{since == null ? "—" : since <= 0 ? "today" : `${plural(since, "day")} ago`}</p>
          <p className={SMALL}>{day(s.last_award_day)}</p>
        </Reading>
      </dl>

      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <AsOf env={s} />
        <Link href="/about/numbers" className="ui-link">
          How these are counted
        </Link>
      </div>
    </Frame>
  );
}

/** The same row as quiet blocks while the readings load. */
export function EntitySignalsSkeleton({ company }: { company: boolean }) {
  return (
    <div aria-busy="true">
      <span className="sr-only">Loading signals</span>
      <div className={`forum-kpis ${company ? "" : "forum-kpis-3"}`} aria-hidden="true">
        {Array.from({ length: company ? 4 : 3 }, (_, i) => (
          <div key={i} className="forum-kpi">
            <span className="skeleton h-3 w-28" />
            <span className="skeleton mt-3 h-8 w-24" />
            <span className="skeleton mt-3 h-3.5 w-40 max-w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
