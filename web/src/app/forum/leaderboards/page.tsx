import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Footer } from "@/components/Footer";
import { AGENCIES, ENTRANTS, RECIPIENTS, RISING, TOPICS, TRANSITIONS } from "@/components/leaderboards/boards";
import { Ledger, LedgerSkeleton } from "@/components/leaderboards/Ledger";
import { getRecord } from "@/components/leaderboards/record";
import { Tabs } from "@/components/leaderboards/Tabs";
import { BASE, filterParams, parseView, tabOf, viewKey, type View } from "@/components/leaderboards/view";
import { SignalFilters } from "@/components/SignalFilters";
import { AsOf } from "@/components/Signals";

export const metadata: Metadata = { title: "Leaderboards" };

type Query = Promise<Record<string, string | string[] | undefined>>;

/** "As of Nov 11, 2026". Says nothing when the API is down: the ledger does. */
async function Stamp() {
  const record = await getRecord();
  return record ? <AsOf env={record} /> : null;
}

/** The leaderboard the URL asks for. */
function Chosen({ view }: { view: View }) {
  switch (view.tab) {
    case "rising":
      return <Ledger board={RISING} view={view} />;
    case "entrants":
      return <Ledger board={ENTRANTS} view={view} />;
    case "transitions":
      return <Ledger board={TRANSITIONS} view={view} />;
    case "agencies":
      return <Ledger board={AGENCIES} view={view} />;
    case "topics":
      return <Ledger board={TOPICS} view={view} />;
    default:
      return <Ledger board={RECIPIENTS} view={view} />;
  }
}

/** Everything that depends on the query string: the filters, the tabs and the
 *  ledger. The ledger has its own boundary, keyed by the view, so changing the
 *  tab, the sort or the page shows skeleton rows while the new ones load. */
async function Boards({ searchParams }: { searchParams: Query }) {
  const view = parseView(await searchParams);
  const tab = tabOf(view.tab);
  return (
    <>
      <div className="mt-6">
        <SignalFilters
          basePath={BASE}
          window={view.window}
          // Topics are the categories: the filter is hidden there, but its
          // window links keep the category for the other tabs.
          tag={view.tag}
          showTag={tab.usesTag}
          params={filterParams(view)}
        />
        <div className="mt-6">
          <Tabs view={view} />
        </div>
      </div>
      <div className="mt-6">
        <Suspense key={viewKey(view)} fallback={<LedgerSkeleton title={tab.label} />}>
          <Chosen view={view} />
        </Suspense>
      </div>
    </>
  );
}

async function FooterWithData() {
  const record = await getRecord();
  return <Footer sample={record?.sample} />;
}

export default function LeaderboardsPage({ searchParams }: { searchParams: Query }) {
  return (
    <>
      <main className="mx-auto max-w-[71.75rem] px-4 pt-24 sm:px-6 sm:pt-32">
        <header>
          <h1 className="page-title">Leaderboards</h1>
          <div className="mt-5 flex flex-wrap items-baseline gap-x-5 gap-y-1">
            <Suspense fallback={<span className="skeleton h-3.5 w-44" />}>
              <Stamp />
            </Suspense>
            <Link href="/forum" className="ui-link">
              Back to the Forum
            </Link>
            <Link href="/about/numbers" className="ui-link">
              How these are counted
            </Link>
          </div>
        </header>
        <Suspense
          fallback={
            <div className="mt-6">
              <div aria-hidden="true">
                <span className="skeleton h-[1.875rem] w-80 max-w-full" />
                <span className="skeleton mt-6 h-9 w-full" />
              </div>
              <div className="mt-6">
                <LedgerSkeleton />
              </div>
            </div>
          }
        >
          <Boards searchParams={searchParams} />
        </Suspense>
      </main>
      <Suspense fallback={<Footer />}>
        <FooterWithData />
      </Suspense>
    </>
  );
}
