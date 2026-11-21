import type { Metadata } from "next";
import { Suspense } from "react";
import { Explorer } from "@/components/explorer/Explorer";
import { serverGet } from "@/lib/api";
import { parseWindowKey, type Flows } from "@/lib/flows";

export const metadata: Metadata = { title: "Graph" };

type Search = Promise<{ [key: string]: string | string[] | undefined }>;

/** The first answer is fetched here, so the drawing arrives in the page's own
 *  HTML. With no `?window=` the API picks the window: the first one with an
 *  award in it, so the page never opens empty. A link that names an entity
 *  (`?focus=org:12`) with no window widens to everything on record when the
 *  default window does not hold it. */
async function Loaded({ searchParams }: { searchParams: Search }) {
  const q = await searchParams;
  const key = parseWindowKey(q.window);
  let data = await serverGet<Flows>(key ? `flows?window=${key}` : "flows");
  const focus = Array.isArray(q.focus) ? q.focus[0] : q.focus;
  if (data && !key && focus?.startsWith("org:") && ![...data.companies, ...data.agencies].some((p) => p.id === focus)) {
    const all = await serverGet<Flows>("flows?window=all");
    if (all && [...all.companies, ...all.agencies].some((p) => p.id === focus)) data = all;
  }
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(q)) {
    const v = Array.isArray(value) ? value[0] : value;
    if (v != null) search.set(name, v);
  }
  // A real navigation here (a link, the command palette) starts the explorer
  // afresh from the new address; its own edits to the address do not.
  return <Explorer key={search.toString()} initial={data} search={search.toString()} />;
}

export default function GraphPage({ searchParams }: { searchParams: Search }) {
  return (
    <main>
      <Suspense
        fallback={
          <div className="ex-wrap">
            <div className="skeleton ex-skeleton" aria-hidden="true" />
          </div>
        }
      >
        <Loaded searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
