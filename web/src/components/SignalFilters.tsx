"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { endDay, WINDOWS, windowLabel } from "@/lib/signals";
import { TAGS, tagLabel } from "@/lib/tags";

/** The window selector and the category filter, shared by the Forum and the
 *  leaderboards. The state lives in the URL (`?window=90&tag=maritime`), so a
 *  view can be shared; `params` are the page's other query values to keep.
 *
 *  A window ends on the newest award on record, not today, so the buttons
 *  carry that day after them: "30 days · 90 days · 1 year, to Aug 19".
 *  `asOf` is that day; leave it undefined while it is still loading (its
 *  place is held, so nothing moves when it arrives) and pass null when it
 *  cannot be known. */
export function SignalFilters({
  basePath,
  window: current,
  tag,
  asOf,
  params = {},
  showTag = true,
  className = "",
}: {
  basePath: string;
  window: number;
  tag: string | null;
  asOf?: string | null;
  params?: Record<string, string | undefined>;
  showTag?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const href = (next: Record<string, string | number | null>) => {
    const q = new URLSearchParams();
    const all = { ...params, window: String(current), tag: tag ?? undefined, ...next };
    for (const [k, v] of Object.entries(all)) {
      if (v == null || v === "" || (k === "window" && String(v) === "90")) continue;
      q.set(k, String(v));
    }
    const s = q.toString();
    return s ? `${basePath}?${s}` : basePath;
  };
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 ${className}`}>
      <div className="seg" role="group" aria-label={asOf ? `Window, ending ${endDay(asOf)}` : "Window"}>
        {WINDOWS.map((w) => (
          <Link key={w} href={href({ window: w })} scroll={false} aria-current={w === current ? "true" : undefined}>
            {windowLabel(w)}
          </Link>
        ))}
      </div>
      {asOf ? (
        <span className="whitespace-nowrap text-muted" title="The windows end on the newest award on record">
          to {endDay(asOf)}
        </span>
      ) : (
        asOf === undefined && <span className="skeleton h-3.5 w-[4.25rem]" aria-hidden="true" />
      )}
      {showTag && (
        <select
          aria-label="Category"
          value={tag ?? ""}
          onChange={(e) => router.push(href({ tag: e.target.value || null }), { scroll: false })}
          className="field w-[13.5rem] max-w-full"
        >
          <option value="">All categories</option>
          {TAGS.map((t) => (
            <option key={t} value={t}>
              {tagLabel(t)}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
