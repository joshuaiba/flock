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
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-3 ${className}`}>
      <div className="marble inline-flex rounded-full p-1" role="group" aria-label="Window">
        {WINDOWS.map((w) => (
          <Link
            key={w}
            href={href({ window: w })}
            scroll={false}
            aria-current={w === current ? "true" : undefined}
            className={`rounded-full px-3 py-1.5 font-caps text-[0.66rem] uppercase tracking-[0.14em] no-underline transition-colors ${
              w === current ? "bg-card text-ink shadow-[0_0_0_1px_var(--frame)]" : "text-muted hover:text-ink"
            }`}
          >
            {windowLabel(w)}
          </Link>
        ))}
      </div>
      {showTag && (
        <label className="marble inline-flex items-center gap-2 rounded-full py-1 pl-4 pr-2">
          <span className="label">Category</span>
          <select
            value={tag ?? ""}
            onChange={(e) => router.push(href({ tag: e.target.value || null }), { scroll: false })}
            className="fig max-w-[13rem] cursor-pointer truncate rounded-full bg-transparent py-1 pl-1 pr-1 text-ink outline-offset-2"
          >
            <option value="">All categories</option>
            {TAGS.map((t) => (
              <option key={t} value={t}>
                {tagLabel(t)}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
