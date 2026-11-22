"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { WINDOWS, windowLabel } from "@/lib/signals";
import { TAGS, tagLabel } from "@/lib/tags";

/** The window selector and the category filter, shared by the Forum and the
 *  leaderboards. The state lives in the URL (`?window=90&tag=maritime`), so a
 *  view can be shared; `params` are the page's other query values to keep. */
export function SignalFilters({
  basePath,
  window: current,
  tag,
  params = {},
  showTag = true,
  className = "",
}: {
  basePath: string;
  window: number;
  tag: string | null;
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
      <div className="seg" role="group" aria-label="Window">
        {WINDOWS.map((w) => (
          <Link key={w} href={href({ window: w })} scroll={false} aria-current={w === current ? "true" : undefined}>
            {windowLabel(w)}
          </Link>
        ))}
      </div>
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
