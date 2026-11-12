import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Footer } from "@/components/Footer";
import { Agencies } from "@/components/forum/Agencies";
import { getOverview } from "@/components/forum/data";
import { FundingByCategory } from "@/components/forum/FundingByCategory";
import { AsOfLine, HeadlineStats, StatsSkeleton } from "@/components/forum/Headline";
import { HeatingUp } from "@/components/forum/HeatingUp";
import { LargestAwards } from "@/components/forum/LargestAwards";
import { ReachedProduction } from "@/components/forum/ReachedProduction";
import { Rising } from "@/components/forum/Rising";
import { Watchlist } from "@/components/forum/Watchlist";
import { SignalFilters } from "@/components/SignalFilters";
import { PanelSkeleton } from "@/components/Signals";
import { parseWindow } from "@/lib/signals";
import { TAGS } from "@/lib/tags";

export const metadata: Metadata = { title: "The Forum" };

type Search = Promise<{ [key: string]: string | string[] | undefined }>;

// The dashboard's grid: twelve columns on a wide screen, one column (in this
// same order) on a narrow one. The order is the order of importance: what
// changed (the summary row), who is rising, what reached production, what is
// heating up, then the supporting sections. min-w-0 lets a section shrink
// below its widest table, which then scrolls inside it instead of stretching
// the page.
const GRID = "mt-12 grid grid-cols-1 gap-x-12 gap-y-14 lg:grid-cols-12";
const SPAN = {
  rising: "min-w-0 lg:col-span-7",
  production: "min-w-0 lg:col-span-5",
  heating: "min-w-0 lg:col-span-12",
  largest: "min-w-0 lg:col-span-12",
  categories: "min-w-0 lg:col-span-12",
  agencies: "min-w-0 lg:col-span-7",
  watchlist: "min-w-0 lg:col-span-5",
};

/** The toolbar under the title: on the left the as-of date and where every
 *  figure is defined, on the right the window and the category. */
const TOOLBAR = "relative z-20 mt-5 flex flex-wrap items-center justify-between gap-x-8 gap-y-3";

/** `?window=` and `?tag=`, read leniently: an unknown window becomes 90 days
 *  and an unknown category becomes "all". */
async function readFilters(searchParams: Search): Promise<{ days: number; tag: string | null }> {
  const q = await searchParams;
  const raw = Array.isArray(q.tag) ? q.tag[0] : q.tag;
  return { days: parseWindow(q.window), tag: raw && TAGS.includes(raw) ? raw : null };
}

/** Everything under the title. Each signal is its own server component in its
 *  own Suspense, so a slow one never holds up the others. The boundaries are
 *  keyed by the filters: change the window and each panel shows its plaster
 *  skeleton until its new numbers arrive, never the old numbers under the new
 *  window. */
async function Forum({ searchParams }: { searchParams: Search }) {
  const { days, tag } = await readFilters(searchParams);
  const key = `${days}:${tag ?? ""}`;
  const p = { days, tag };
  return (
    <>
      <div className={TOOLBAR}>
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <Suspense key={key} fallback={<span className="skeleton my-1 h-3.5 w-44" aria-hidden="true" />}>
            <AsOfLine {...p} />
          </Suspense>
          <Link href="/about/numbers" className="ui-link">
            How these are counted
          </Link>
        </div>
        <SignalFilters basePath="/forum" window={days} tag={tag} />
      </div>

      <Suspense key={key} fallback={<StatsSkeleton />}>
        <HeadlineStats {...p} />
      </Suspense>

      <div className={GRID}>
        <Suspense key={`rising:${key}`} fallback={<PanelSkeleton title="Rising" rows={10} className={SPAN.rising} />}>
          <Rising {...p} className={SPAN.rising} />
        </Suspense>
        <Suspense
          key={`production:${key}`}
          fallback={<PanelSkeleton title="Reached production" rows={6} className={SPAN.production} />}
        >
          <ReachedProduction {...p} className={SPAN.production} />
        </Suspense>
        <Suspense key={`heating:${key}`} fallback={<PanelSkeleton title="Heating up" rows={5} className={SPAN.heating} />}>
          <HeatingUp {...p} className={SPAN.heating} />
        </Suspense>
        <Suspense
          key={`largest:${key}`}
          fallback={<PanelSkeleton title="Largest awards" rows={10} className={SPAN.largest} />}
        >
          <LargestAwards {...p} className={SPAN.largest} />
        </Suspense>
        <Suspense
          key={`categories:${key}`}
          fallback={<PanelSkeleton title="Funding by category" rows={4} className={SPAN.categories} />}
        >
          <FundingByCategory {...p} className={SPAN.categories} />
        </Suspense>
        <Suspense key={`agencies:${key}`} fallback={<PanelSkeleton title="Agencies" rows={8} className={SPAN.agencies} />}>
          <Agencies {...p} className={SPAN.agencies} />
        </Suspense>
        {/* The watchlist is the reader's own: it loads in the browser. */}
        <Watchlist className={SPAN.watchlist} />
      </div>
    </>
  );
}

/** What stands in for the whole dashboard until the filters are read. */
function ForumSkeleton() {
  return (
    <>
      <div className={TOOLBAR} aria-hidden="true">
        <span className="skeleton h-3.5 w-64 max-w-full" />
        <span className="skeleton h-[1.875rem] w-80 max-w-full" />
      </div>
      <StatsSkeleton />
      <div className={GRID}>
        <PanelSkeleton title="Rising" rows={10} className={SPAN.rising} />
        <PanelSkeleton title="Reached production" rows={6} className={SPAN.production} />
        <PanelSkeleton title="Heating up" rows={5} className={SPAN.heating} />
        <PanelSkeleton title="Largest awards" rows={10} className={SPAN.largest} />
        <PanelSkeleton title="Funding by category" rows={4} className={SPAN.categories} />
        <PanelSkeleton title="Agencies" rows={8} className={SPAN.agencies} />
        <PanelSkeleton title="Your watchlist" rows={3} className={SPAN.watchlist} />
      </div>
    </>
  );
}

async function ForumFooter({ searchParams }: { searchParams: Search }) {
  const { days, tag } = await readFilters(searchParams);
  const o = await getOverview(days, tag);
  return <Footer sample={o?.sample} />;
}

export default function ForumPage({ searchParams }: { searchParams: Search }) {
  return (
    <>
      <main className="mx-auto max-w-6xl px-4 pt-24 sm:px-6 sm:pt-28">
        {/* The page's one ornament: the title in its plaque. */}
        <div className="relative z-20">
          <h1 className="title-plaque">The Forum</h1>
        </div>
        <Suspense fallback={<ForumSkeleton />}>
          <Forum searchParams={searchParams} />
        </Suspense>
      </main>
      <Suspense fallback={<Footer />}>
        <ForumFooter searchParams={searchParams} />
      </Suspense>
    </>
  );
}
