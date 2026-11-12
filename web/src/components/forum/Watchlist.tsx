"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { NoRows, OrgLink, Panel, RankChange, SkeletonRows } from "@/components/Signals";
import { clientGet } from "@/lib/api";
import { day, money, plural, truncate } from "@/lib/format";
import { signalPath, STAGE_LABEL, type WatchRow, type Watchlist as WatchlistData } from "@/lib/signals";
import { useStore } from "@/lib/store";
import { PanelEmpty } from "./shared";

// "Your watchlist": what changed for the pinned organizations since the
// reader's last visit. The pins and the time of the last visit live in this
// browser only; the server never sees who is watching what.

const VISIT_KEY = "flock.visit";
// Coming back within half an hour is the same visit: reloading the page must
// not wipe the list of what is new.
const SAME_VISIT_MS = 30 * 60 * 1000;
// The API lists at most this many new awards per organization.
const AWARD_CAP = 20;

type Visit = { prev: string | null; last: string };
let since: string | null | undefined; // undefined until read, once per page load

/** The reader's previous visit (ISO time), or null on the first one. Also
 *  records this visit. Storage can be blocked (private windows), in which case
 *  every visit is a first visit. */
function previousVisit(): string | null {
  if (since !== undefined) return since;
  const now = new Date();
  let stored: Visit | null = null;
  try {
    const raw = localStorage.getItem(VISIT_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<Visit>) : null;
    // Both times go to the API as written, so a value that is not a time is
    // dropped here: the API would refuse the whole request over it.
    const isTime = (s: unknown): s is string => typeof s === "string" && !Number.isNaN(Date.parse(s));
    if (v && isTime(v.last)) stored = { prev: isTime(v.prev) ? v.prev : null, last: v.last };
  } catch {
    stored = null;
  }
  if (!stored || now.getTime() - Date.parse(stored.last) > SAME_VISIT_MS) {
    stored = { prev: stored ? stored.last : null, last: now.toISOString() };
    try {
      localStorage.setItem(VISIT_KEY, JSON.stringify(stored));
    } catch {
      /* nothing to do: the next visit will count as a first visit */
    }
  }
  since = stored.prev;
  return since;
}

/** An ISO time as a date in the reader's own time zone: "Nov 3, 2026". */
function localDay(iso: string): string {
  const t = new Date(iso);
  const two = (n: number) => String(n).padStart(2, "0");
  return day(`${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())}`);
}

const never = () => () => {};

type Loaded = { ids: string; data: WatchlistData | null };

export function Watchlist({ className = "" }: { className?: string }) {
  const { pins } = useStore();
  // False on the server and while its HTML is hydrated, so both draw the same
  // loading rows; the pins are known only after that.
  const mounted = useSyncExternalStore(never, () => true, () => false);
  const ids = pins.map((p) => p.id).join(",");
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  // Record the visit even with nothing pinned yet, so that the first pin has
  // an earlier visit to be compared with next time.
  useEffect(() => {
    previousVisit();
  }, []);

  useEffect(() => {
    if (!ids) return;
    const ctl = new AbortController();
    clientGet<WatchlistData>(signalPath("watchlist", { ids, since: previousVisit() }), ctl.signal)
      .then((data) => setLoaded({ ids, data }))
      .catch(() => {
        if (!ctl.signal.aborted) setLoaded({ ids, data: null });
      });
    return () => ctl.abort();
  }, [ids]);

  // An answer for an older set of pins is not shown: it is loading again.
  const res = loaded && loaded.ids === ids ? loaded : null;
  const data = res?.data ?? null;

  return (
    <Panel
      title="Your watchlist"
      className={className}
      note={
        data
          ? data.since
            ? `What is new in the record since your last visit, ${localDay(data.since)}. Rank is by award dollars over the last 90 days.`
            : "Rank is by award dollars over the last 90 days."
          : undefined
      }
    >
      {!mounted ? (
        <Loading />
      ) : pins.length === 0 ? (
        <PanelEmpty>
          Nothing on your watchlist yet. Open any organization and choose &ldquo;Add to watchlist&rdquo; to follow it here.
        </PanelEmpty>
      ) : !res ? (
        <Loading />
      ) : !data ? (
        <NoRows>The data service is not answering.</NoRows>
      ) : data.items.length === 0 ? (
        <NoRows>None of the organizations on your watchlist are in the record.</NoRows>
      ) : (
        <>
          {!data.since && (
            <p className="ui mb-3 max-w-[46rem] text-muted">
              This is your first visit from this browser, so there is nothing to compare with yet. New awards and stages
              will be listed from your next visit.
            </p>
          )}
          <ul className="forum-rows border-t border-line2">
            {data.items.map((w) => (
              <Watched key={w.org.id} w={w} since={data.since} />
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

function Loading() {
  return (
    <div aria-busy="true">
      <span className="sr-only">Loading your watchlist</span>
      <SkeletonRows rows={3} />
    </div>
  );
}

/** One watched organization: where it ranks, when it last won an award, and,
 *  when there is an earlier visit to compare with, what is new since then. */
function Watched({ w, since }: { w: WatchRow; since: string | null }) {
  const capped = w.new_awards.length >= AWARD_CAP;
  const last =
    w.days_since_last == null
      ? "no awards on record"
      : w.days_since_last === 0
        ? "last award today"
        : `last award ${plural(w.days_since_last, "day")} ago`;
  return (
    <li className="py-2.5">
      <div className="forum-name">
        <OrgLink org={w.org} size={22} className="max-w-full" />
      </div>
      <p className="ui mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted">
        {w.rank == null ? (
          <span>not ranked in the last 90 days</span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <span className="text-ink">rank {w.rank}</span>
            {/* Only companies have a rank on record for the day of the last visit. */}
            {since &&
              w.org.kind === "company" &&
              (w.rank_then == null ? (
                <span>not ranked at your last visit</span>
              ) : (
                <>
                  <span>was {w.rank_then}</span>
                  <RankChange rank={w.rank} prev={w.rank_then} since="the ranking at your last visit" />
                </>
              ))}
          </span>
        )}
        <span aria-hidden="true">·</span>
        <span>{last}</span>
      </p>
      {since && (
        <div className="ui mt-1">
          {w.new_awards.length === 0 ? (
            <p className="text-muted">No new awards since your last visit.</p>
          ) : (
            <>
              <p>
                {capped ? `${AWARD_CAP} or more new awards` : plural(w.new_awards.length, "new award")}
                {" · "}
                <span className="text-accent">{money(w.new_amount)}</span>
                {capped && <span className="text-muted"> in the newest {AWARD_CAP}</span>}
              </p>
              <ul className="mt-1 text-muted">
                {w.new_awards.slice(0, 2).map((a) => (
                  <li key={a.id} className="flex gap-2">
                    {/* With the year: an award new to the record can carry an
                        old date (a late filing, a newly loaded source). */}
                    <span className="shrink-0 whitespace-nowrap">{day(a.day)}</span>
                    <span className="shrink-0 text-accent">{money(a.amount)}</span>
                    <span className="min-w-0 truncate">{truncate(a.description, 90)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {w.new_stages.length > 0 && (
            <p className="mt-1">
              New stage{w.new_stages.length === 1 ? "" : "s"} on record:{" "}
              {w.new_stages.map((s) => `${STAGE_LABEL[s.stage]}${s.day ? ` (${day(s.day)})` : ""}`).join(", ")}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
