"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { GraphNode, NodeKind } from "@/lib/api";
import { ago, day } from "@/lib/format";
import { tagLabel } from "@/lib/tags";
import "./graph-rail.css";

// The graph's left rail: search, the filters in force, and the filters. It
// only shows and reports choices; the state lives in GraphExplorer.tsx, and
// one function (lib/graphLayout.ts hiddenNodes) applies it to both views.
//
// On a wide screen it is a 280px column down the left edge, set off from the
// map by one hairline: the search stays at the top, then the filters in force
// as removable chips, then the groups, each under a hairline with its name on
// the left and what it is set to on the right. Exclusive choices are segmented
// controls; everything else is a checklist. The window opens on "Recent" (see
// WINDOWS) and says how fresh the record is: how long ago the newest award
// landed, or, once that is more than two weeks back, the day the data ends. The foot says how much of the map
// is shown. It folds to a strip of three icon buttons. On a phone the search
// and the window float over the map and the groups fold behind a "Filters"
// button, so the map stays visible. Layout and looks are in graph-rail.css.

// The windows of the map. The record is not loaded on a fixed schedule, so a
// stretch of the calendar can be empty: "Recent" is the newest stretch of the
// record itself, the 90 days up to its newest award. It always has something
// in it, and it is what the map opens on. The others end today; `days: 0` is
// everything on record.
export const WINDOWS = [
  { key: "recent", days: 90, recent: true, label: "Recent", long: "the 90 days up to the newest award" },
  { key: "30d", days: 30, recent: false, label: "30d", long: "the last 30 days" },
  { key: "90d", days: 90, recent: false, label: "90d", long: "the last 90 days" },
  { key: "1y", days: 365, recent: false, label: "1y", long: "the last year" },
  { key: "all", days: 0, recent: false, label: "All", long: "everything on record" },
] as const;
export type WindowKey = (typeof WINDOWS)[number]["key"];
export type Window = (typeof WINDOWS)[number];
export const DEFAULT_WINDOW: WindowKey = "recent";

/** Days after which the record counts as stale: past this, the rail stops
 *  saying how long ago the newest award was and says when the data ends. */
export const STALE_DAYS = 14;

export function windowOf(key: WindowKey): Window {
  return WINDOWS.find((w) => w.key === key) ?? WINDOWS[0];
}

/** A window in words, to follow "Awarded," or to stand alone capitalized:
 *  "90 days to Oct 3", "last 30 days", "last year", "everything on record".
 *  `latest` is the day of the newest award on record. */
export function windowPhrase(w: Window, latest: string | null | undefined): string {
  if (w.recent) {
    if (!latest) return `latest ${w.days} days`;
    // the year only when it is not this one
    const thisYear = Number(latest.slice(0, 4)) === new Date().getFullYear();
    return `${w.days} days to ${day(latest, thisYear)}`;
  }
  return w.long.replace(/^the /, "");
}

/** True when no award on record falls in a window that ends today. */
function awardless(w: Window, age: number | null): boolean {
  return !w.recent && w.days > 0 && age != null && age > w.days;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** An entity's short name, as the map labels it: "AeroVironment", "Army".
 *  Solicitations and older APIs have none, so the full name stands in. */
export function shortName(n: GraphNode): string {
  return n.display_name || n.name;
}

/** Minimum-dollar steps: companies awarded less in the window are hidden. */
export const AMOUNTS = [
  { min: 0, label: "Any" },
  { min: 1e6, label: "$1M" },
  { min: 1e7, label: "$10M" },
  { min: 1e8, label: "$100M" },
];

// There is no "program" in the data: the kinds are these four, and the rail
// shows them as three rows (agencies and their offices go together).
const SHOWN: { label: string; kinds: NodeKind[] }[] = [
  { label: "Companies", kinds: ["company"] },
  { label: "Agencies and offices", kinds: ["agency", "office"] },
  { label: "Solicitations", kinds: ["opportunity"] },
];
const KIND_ONE: Record<NodeKind, string> = {
  company: "Company",
  agency: "Agency",
  office: "Office",
  opportunity: "Solicitation",
};

// ---- Icons: 16px, one stroke weight, drawn in the text color ----

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}
export const SearchIcon = () => (
  <Icon>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.2 10.2 3.3 3.3" />
  </Icon>
);
export const CloseIcon = ({ size = 16 }: { size?: number }) => (
  <Icon size={size}>
    <path d="m4.25 4.25 7.5 7.5m0-7.5-7.5 7.5" />
  </Icon>
);
const DiscloseIcon = () => (
  <Icon size={14}>
    <path d="m6 4 4 4-4 4" />
  </Icon>
);
/** A panel with its side rail: `fold` draws the rail narrow. */
const RailIcon = () => (
  <Icon>
    <rect x="2" y="3" width="12" height="10" rx="1.75" />
    <path d="M6.25 3v10" />
  </Icon>
);
const SlidersIcon = () => (
  <Icon>
    <path d="M2.5 5h5m3.5 0h2.5M2.5 11h2.5m3.5 0h5" />
    <circle cx="9.25" cy="5" r="1.6" />
    <circle cx="6.75" cy="11" r="1.6" />
  </Icon>
);

/** The window, drawn: a line for the record, today at its right end, the
 *  chosen window as a bar on it and the newest award as a ring. When the
 *  record is fresh the ring sits at the right end; when it is not, the gap
 *  between ring and end is how stale it is, and a bar that misses the ring is
 *  a window with no awards in it. Under it, the same in words: while the
 *  record is fresh, how long ago its newest award landed; once it is stale,
 *  the day it ends ("Sample data ends Aug 11" for the synthetic seed). */
function WindowRecord({
  w,
  latest,
  age,
  sample,
}: {
  w: Window;
  latest: string | null;
  age: number | null;
  sample: boolean;
}) {
  if (latest == null || age == null) return null;
  const recent = WINDOWS[0];
  // The line reaches a year back, or far enough to hold the Recent window.
  const reach = Math.max(365, age + recent.days);
  const to = w.recent ? age : 0; // days ago the window ends
  const len = w.days ? Math.min(w.days, reach - to) : reach;
  const pct = (days: number) => `${((days / reach) * 100).toFixed(2)}%`;
  return (
    <div className="graph-record">
      <div className="graph-record-line" aria-hidden="true" data-open={w.days === 0}>
        <span className="graph-record-span" style={{ right: pct(to), width: pct(len) }} />
        <span className="graph-record-newest" style={{ right: pct(age) }} />
      </div>
      {age > STALE_DAYS ? (
        // the year only when it is not this one
        <p className="graph-record-note graph-record-stale">
          {sample ? "Sample data ends" : "Data through"} {day(latest, Number(latest.slice(0, 4)) === new Date().getFullYear())}
        </p>
      ) : (
        <p className="graph-record-note">
          <span>Newest award</span>
          <span>{`${day(latest, true)} · ${ago(age)}`}</span>
        </p>
      )}
    </div>
  );
}

/** A filter group that folds away. Its header always says what it is set to. */
function Group({
  title,
  value,
  className = "",
  children,
}: {
  title: string;
  value: string;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <details className={`graph-group ${className}`} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="graph-group-title">{title}</span>
        <span className="graph-group-value">{value}</span>
        <DiscloseIcon />
      </summary>
      <div className="graph-group-body">{children}</div>
    </details>
  );
}

/** One row of a checklist (.check in globals.css): a box, a name, and a count
 *  where there is one. */
function Check({
  checked,
  onChange,
  count,
  disabled = false,
  children,
}: {
  checked: boolean;
  onChange: () => void;
  count?: number;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="check graph-check" data-empty={count === 0} data-disabled={disabled}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
      <span>{children}</span>
      {count !== undefined && <span className="check-count">{count.toLocaleString("en-US")}</span>}
    </label>
  );
}

export function GraphFilters({
  query,
  onQuery,
  hits,
  onPick,
  selected,
  onClear,
  win,
  onWin,
  latest,
  age,
  sample,
  present,
  tagCounts,
  tags,
  onToggleTag,
  agencies,
  agency,
  onAgency,
  min,
  onMin,
  kinds,
  onToggleKind,
  watch,
  onWatch,
  pins,
  active,
  onReset,
  shown,
  total,
  collapsed,
  onCollapsed,
}: {
  query: string;
  onQuery: (q: string) => void;
  /** entities on the map whose name matches the search */
  hits: GraphNode[];
  onPick: (id: string) => void;
  /** something is selected on the map */
  selected?: boolean;
  /** clear the selection */
  onClear?: () => void;
  win: WindowKey;
  onWin: (win: WindowKey) => void;
  /** the day of the newest award on record, and how many days ago that was */
  latest: string | null;
  age: number | null;
  /** the record is the synthetic seed data (the graph API's `sample`) */
  sample: boolean;
  /** categories present in this window */
  present: string[];
  /** companies and solicitations in each category, under the other filters */
  tagCounts: Readonly<Record<string, number>>;
  tags: ReadonlySet<string>;
  onToggleTag: (tag: string) => void;
  /** agencies and offices in this window */
  agencies: GraphNode[];
  agency: string | null;
  onAgency: (id: string | null) => void;
  min: number;
  onMin: (min: number) => void;
  kinds: ReadonlySet<NodeKind>;
  /** entities of each kind, under the other filters (kept for the explorer's
   *  own use; the rail's rows carry no counts) */
  kindCounts?: Readonly<Record<NodeKind, number>>;
  onToggleKind: (kind: NodeKind) => void;
  watch: boolean;
  onWatch: (on: boolean) => void;
  /** how many organizations are on the watchlist */
  pins: number;
  /** how many filters are narrowing the map */
  active: number;
  onReset: () => void;
  /** entities on the map now, and in the window */
  shown: number;
  total: number;
  /** wide screens only: the rail is folded to its icon strip */
  collapsed: boolean;
  onCollapsed: (collapsed: boolean) => void;
}) {
  const [open, setOpen] = useState(false); // the groups, on a narrow screen
  const [listed, setListed] = useState(false); // the search results are showing
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const search = useRef<HTMLDivElement>(null);
  const showBtn = useRef<HTMLButtonElement>(null);
  const hideBtn = useRef<HTMLButtonElement>(null);
  /** where the keyboard's place goes once the rail has folded or unfolded */
  const focusNext = useRef<"search" | "show" | "hide" | null>(null);
  const listId = useId();

  // Agencies go by their short names ("Army", "DIU"), as on the map.
  const byName = (a: GraphNode, b: GraphNode) => shortName(a).localeCompare(shortName(b));
  const top = agencies.filter((a) => a.kind === "agency").sort(byName);
  const offices = agencies.filter((a) => a.kind === "office").sort(byName);
  const picked = agency ? agencies.find((a) => a.id === agency) : undefined;
  const agencyName = agency ? (picked ? shortName(picked) : "One agency") : null;
  // A row of the Show group is ticked while every kind behind it is shown.
  const rows = SHOWN.map((row) => ({ ...row, on: row.kinds.every((k) => kinds.has(k)) }));
  const hiddenRows = rows.filter((row) => !row.on);
  /** Show or hide every kind behind one row. */
  const setRow = (row: (typeof rows)[number], on: boolean) => {
    for (const k of row.kinds) if (kinds.has(k) !== on) onToggleKind(k);
  };
  const chosen = windowOf(win);

  const typing = query.trim().length > 0;
  const at = hits.length ? Math.min(cursor, hits.length - 1) : -1;
  const showHits = typing && listed;

  // "/" puts the cursor in the search field, from anywhere on the screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      if (collapsed) {
        focusNext.current = "search";
        onCollapsed(false);
      } else input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collapsed, onCollapsed]);

  // Folding hides the button that was pressed, so the keyboard's place moves
  // to its counterpart: "hide" to "show" and back, or to the search field.
  useEffect(() => {
    const to = focusNext.current;
    focusNext.current = null;
    if (to === "search") input.current?.focus();
    else if (to === "show") showBtn.current?.focus();
    else if (to === "hide") hideBtn.current?.focus();
  }, [collapsed]);
  const fold = (next: boolean, focus: "search" | "show" | "hide") => {
    focusNext.current = focus;
    onCollapsed(next);
  };

  const pick = (id: string) => {
    onPick(id);
    setListed(false);
  };
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!hits.length) return;
      e.preventDefault();
      setListed(true);
      setCursor(showHits ? (at + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length : 0);
    } else if (e.key === "Enter") {
      if (showHits && at >= 0) pick(hits[at].id);
    } else if (e.key === "Escape") {
      // First the list. Then, with something picked on the map, one press
      // does what the takeaway's "Press Esc to clear" promises: the
      // selection goes, and the text that found it with it. Otherwise the
      // text, then the field.
      if (showHits) setListed(false);
      else if (selected && onClear) {
        onClear();
        onQuery("");
        input.current?.blur();
      } else if (query) onQuery("");
      else input.current?.blur();
    }
  };

  const chips: { key: string; label: string; remove: () => void }[] = [
    ...present.filter((t) => tags.has(t)).map((t) => ({ key: `tag:${t}`, label: tagLabel(t), remove: () => onToggleTag(t) })),
    ...(agencyName ? [{ key: "agency", label: agencyName, remove: () => onAgency(null) }] : []),
    ...(min ? [{ key: "min", label: `${AMOUNTS.find((a) => a.min === min)?.label ?? "Minimum"} or more`, remove: () => onMin(0) }] : []),
    ...hiddenRows.map((row) => ({
      key: `kind:${row.kinds[0]}`,
      label: `No ${row.label.toLowerCase().replace(" and ", " or ")}`,
      remove: () => setRow(row, true),
    })),
    ...(watch ? [{ key: "watch", label: "Watchlist only", remove: () => onWatch(false) }] : []),
  ];

  const windowSeg = (
    <div className="seg graph-seg graph-float" role="group" aria-label="Time window">
      {WINDOWS.map((w) => {
        const none = awardless(w, age);
        return (
          <button
            key={w.key}
            type="button"
            aria-pressed={win === w.key}
            aria-label={none ? `${capital(w.long)}: no awards` : capital(w.long)}
            title={none ? `No awards in ${w.long}` : undefined}
            data-empty={none}
            onClick={() => onWin(w.key)}
          >
            {w.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <aside data-obstacle aria-label="Graph filters" className="graph-rail" data-collapsed={collapsed}>
      {/* Folded (wide screens): three buttons that open it again. */}
      <div className="graph-rail-strip">
        <button
          ref={showBtn}
          type="button"
          className="graph-icon-btn"
          aria-label="Show filters"
          aria-expanded={false}
          title="Show filters"
          onClick={() => fold(false, "hide")}
        >
          <RailIcon />
        </button>
        <button
          type="button"
          className="graph-icon-btn"
          aria-label="Search the graph"
          title="Search ( / )"
          onClick={() => fold(false, "search")}
        >
          <SearchIcon />
        </button>
        <button
          type="button"
          className="graph-icon-btn"
          aria-label={active ? `Filters, ${active} in use` : "Filters"}
          title={active ? `Filters (${active} in use)` : "Filters"}
          onClick={() => fold(false, "hide")}
        >
          <SlidersIcon />
          {active > 0 && (
            <span className="graph-badge" aria-hidden="true">
              {active}
            </span>
          )}
        </button>
      </div>

      <div className="graph-rail-full">
        {/* Search: stays put while the groups scroll under it. */}
        <div
          ref={search}
          className="graph-search"
          onBlur={(e) => {
            if (!search.current?.contains(e.relatedTarget as Node | null)) setListed(false);
          }}
        >
          <label className="graph-search-field">
            <span className="sr-only">Search the graph</span>
            <input
              ref={input}
              className="field"
              type="search"
              role="combobox"
              aria-expanded={showHits}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={showHits && at >= 0 ? `${listId}-${at}` : undefined}
              value={query}
              onChange={(e) => {
                onQuery(e.target.value);
                setListed(true);
                setCursor(0);
              }}
              onFocus={() => setListed(true)}
              onKeyDown={onSearchKey}
              placeholder="Find a company or agency"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="graph-search-aside">
              {query ? (
                <button
                  type="button"
                  className="graph-icon-btn"
                  aria-label="Clear the search"
                  onClick={() => {
                    onQuery("");
                    input.current?.focus();
                  }}
                >
                  <CloseIcon size={14} />
                </button>
              ) : (
                <kbd className="graph-kbd graph-only-wide" aria-hidden="true">
                  /
                </kbd>
              )}
            </span>
          </label>
          {showHits && (
            // A press on a result must not take the cursor out of the field first
            // (Safari does not focus buttons, so the list would close under it).
            <div className="graph-hits" onMouseDown={(e) => e.preventDefault()}>
              {hits.length ? (
                <ul id={listId} role="listbox" aria-label="Matching entities">
                  {hits.map((h, i) => (
                    <li key={h.id} role="presentation">
                      <button
                        type="button"
                        id={`${listId}-${i}`}
                        role="option"
                        aria-selected={i === at}
                        tabIndex={-1}
                        className="graph-hit"
                        onPointerEnter={() => setCursor(i)}
                        onClick={() => pick(h.id)}
                      >
                        <span className="graph-name" title={h.name !== shortName(h) ? h.name : undefined}>
                          {shortName(h)}
                        </span>
                        {/* the field asks for companies; anything else says what it is */}
                        {h.kind !== "company" && <span className="graph-hit-kind">{KIND_ONE[h.kind]}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p id={listId} className="graph-hits-none" role="status">
                  {active ? "No one by that name among what is shown." : "No one by that name in this window."}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Phone: the window and the way into the groups. */}
        <div className="graph-rail-quick">
          {windowSeg}
          <button
            type="button"
            className="btn btn-sm graph-float"
            aria-expanded={open}
            aria-controls="graph-filter-list"
            onClick={() => setOpen((was) => !was)}
          >
            Filters{active > 0 && ` (${active})`}
          </button>
        </div>

        <div id="graph-filter-list" className="graph-rail-body" data-open={open}>
          {/* What is narrowing the map now, each removable, and one way to drop them all. */}
          {chips.length > 0 && (
            <div className="graph-active">
              <ul aria-label="Filters in use">
                {chips.map((c) => (
                  <li key={c.key}>
                    <span className="chip">
                      <span>{c.label}</span>
                      <button type="button" aria-label={`Remove filter: ${c.label}`} onClick={c.remove}>
                        <CloseIcon size={12} />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
              <button type="button" className="graph-clear" onClick={onReset}>
                Clear
              </button>
            </div>
          )}

          <Group title="Window" value={capital(windowPhrase(chosen, latest))} className="graph-only-wide">
            {windowSeg}
            <WindowRecord w={chosen} latest={latest} age={age} sample={sample} />
          </Group>

          <Group title="Categories" value={tags.size ? `${tags.size} of ${present.length}` : "All"}>
            <div className="graph-checklist graph-checklist-scroll" role="group" aria-label="Filter by category">
              {present.map((t) => (
                <Check
                  key={t}
                  checked={tags.has(t)}
                  onChange={() => onToggleTag(t)}
                  count={tagCounts[t] ?? 0}
                >
                  {tagLabel(t)}
                </Check>
              ))}
            </div>
          </Group>

          <Group title="Agency" value={agencyName ?? "All"}>
            <select
              className="field"
              aria-label="Show one agency or office, its awardees and its solicitations"
              value={agency ?? ""}
              onChange={(e) => onAgency(e.target.value || null)}
            >
              <option value="">All agencies</option>
              {top.length > 0 && (
                <optgroup label="Agencies">
                  {top.map((a) => (
                    <option key={a.id} value={a.id}>
                      {shortName(a)}
                    </option>
                  ))}
                </optgroup>
              )}
              {offices.length > 0 && (
                <optgroup label="Offices">
                  {offices.map((a) => (
                    <option key={a.id} value={a.id}>
                      {shortName(a)}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </Group>

          <Group title="Minimum award" value={min ? (AMOUNTS.find((a) => a.min === min)?.label ?? "Set") : "Any"}>
            <div className="seg graph-seg" role="group" aria-label="Least dollars awarded to a company in this window">
              {AMOUNTS.map((a) => (
                <button key={a.min} type="button" aria-pressed={min === a.min} onClick={() => onMin(a.min)}>
                  {a.label}
                </button>
              ))}
            </div>
          </Group>

          <Group
            title="Show"
            value={
              watch ? "Watchlist only" : hiddenRows.length ? `${rows.length - hiddenRows.length} of ${rows.length} kinds` : "All kinds"
            }
          >
            <div className="graph-checklist" role="group" aria-label="Kinds of entity">
              {rows.map((row) => (
                <Check key={row.label} checked={row.on} onChange={() => setRow(row, !row.on)}>
                  {row.label}
                </Check>
              ))}
              <Check checked={watch} onChange={() => onWatch(!watch)} disabled={pins === 0 && !watch}>
                Watchlist only
              </Check>
            </div>
            <p className="graph-note">
              {pins === 0
                ? "Nothing is on your watchlist yet."
                : watch
                  ? "Your watchlist and its direct neighbors."
                  : "Narrows the map to your watchlist and its neighbors."}
            </p>
          </Group>
        </div>

        <div className="graph-rail-foot">
          <span>
            <b>{shown.toLocaleString("en-US")}</b> of {total.toLocaleString("en-US")} shown
          </span>
          <button
            ref={hideBtn}
            type="button"
            className="graph-icon-btn"
            aria-label="Hide filters"
            aria-expanded={true}
            title="Hide filters"
            onClick={() => fold(true, "show")}
          >
            <RailIcon />
          </button>
        </div>
      </div>
    </aside>
  );
}
