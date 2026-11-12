import { NoRows, OrgLink, Panel, signedPct } from "@/components/Signals";
import { serverGet } from "@/lib/api";
import { money } from "@/lib/format";
import { priorLabel, signalPath, type FundingPage } from "@/lib/signals";
import { tagPhrase } from "@/lib/tags";
import { carry, Down, lastLabel, Scroll, signedMoney, type PanelProps } from "./shared";

/** Momentum leaderboard: the ten companies whose award dollars grew the most,
 *  by percentage, against the prior period. */
export async function Rising({ days, tag, className = "" }: PanelProps) {
  const d = await serverGet<FundingPage>(
    signalPath("momentum", { by: "company", sort: "pct", direction: "rising", window: days, tag, limit: 10 }),
  );
  const more = { href: carry("/forum/leaderboards", days, tag, { tab: "rising" }), label: "Full leaderboard" };
  if (!d)
    return (
      <Panel title="Rising" className={className}>
        <Down />
      </Panel>
    );

  // Growth needs a full prior period. When the record starts too late for one,
  // any percentage would compare a whole window with part of one.
  const comparable = d.coverage.prior_complete;
  return (
    <Panel
      title="Rising"
      more={more}
      className={className}
      note={
        <>
          Companies by growth in award dollars, {lastLabel(days)} against {priorLabel(days)}
          {tag && <>, in {tagPhrase(tag)}</>}. Companies with under {money(d.min_baseline)} in the prior period are
          left out: growth from almost nothing is noise.
        </>
      }
    >
      {!comparable ? (
        <NoRows>
          The record does not reach back to the start of {priorLabel(days)}, so there is no growth to rank yet.
        </NoRows>
      ) : d.items.length === 0 ? (
        <NoRows>
          No company with a prior period of {money(d.min_baseline)} or more grew{tag && <> in {tagPhrase(tag)}</>} in{" "}
          {lastLabel(days)}.
        </NoRows>
      ) : (
        <Scroll label="Rising companies">
          {/* The dollar change has its own column from `sm` up; on a phone
              it sits under the period's dollars, so the name keeps its room. */}
          <table className="ledger min-w-[19.5rem]">
            <thead>
              <tr>
                <th scope="col" className="num">
                  <span aria-hidden="true">#</span>
                  <span className="sr-only">Rank</span>
                </th>
                <th scope="col">Company</th>
                <th scope="col" className="num">
                  Awarded
                </th>
                <th scope="col" className="num hidden sm:table-cell">
                  Change
                </th>
                <th scope="col" className="num">
                  Growth
                </th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((r, i) => (
                <tr key={r.org?.id ?? i}>
                  <td className="num w-8 text-muted">{r.pct_rank ?? i + 1}</td>
                  {/* w-full + max-w-0: this cell takes the room the numbers
                      leave, and a long name is cut with an ellipsis. */}
                  <td className="forum-name w-full max-w-0">
                    {r.org ? <OrgLink org={r.org} size={22} className="max-w-full align-middle" /> : "Unnamed recipient"}
                  </td>
                  <td className="num leading-tight">
                    <span className="text-pompeii">{money(r.amount)}</span>
                    <span className="block text-[0.75rem] text-muted sm:hidden">
                      <span className="sr-only">change </span>
                      {signedMoney(r.delta)}
                    </span>
                  </td>
                  <td className="num hidden text-muted sm:table-cell">{signedMoney(r.delta)}</td>
                  <td className="num">{r.pct != null && signedPct(r.pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      )}
    </Panel>
  );
}
