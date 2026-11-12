"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { GraphNode, NodeKind } from "@/lib/api";
import { medallionFor, medallionForTag } from "@/lib/art";
import { ALL_KINDS } from "@/lib/graphLayout";
import { tagLabel } from "@/lib/tags";
import { MedallionImg } from "./Art";
import "./graph-rail.css";

// The graph's left rail: search, the filters in force, and the filters. It
// only shows and reports choices; the state lives in GraphExplorer.tsx, and
// one function (lib/graphLayout.ts hiddenNodes) applies it to both views.
//
// On a wide screen it is one docked panel, 280px wide: the search stays at the
// top, the groups scroll under it, and the foot says how much of the map is
// shown. It folds to a strip of three icon buttons. On a phone the search and
// the window float over the map and the groups fold behind a "Filters" button,
// so the map stays visible. Layout and looks are in graph-rail.css.

export const WINDOWS = [
  { days: 30, label: "30d", long: "30 days" },
  { days: 90, label: "90d", long: "90 days" },
  { days: 365, label: "1y", long: "1 year" },
  { days: 0, label: "All", long: "everything on record" },
];

/** Minimum-dollar steps: companies awarded less in the window are hidden. */
export const AMOUNTS = [
  { min: 0, label: "Any" },
  { min: 1e6, label: "$1M" },
  { min: 1e7, label: "$10M" },
  { min: 1e8, label: "$100M" },
];

// There is no "program" in the data: the kinds are these four.
const KIND_LABEL: Record<NodeKind, string> = {
  company: "Companies",
  agency: "Agencies",
  office: "Offices",
  opportunity: "Solicitations",
};
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

/** One row of a checklist: a box, an optional icon, a name and a count. */
function Check({
  checked,
  onChange,
  icon,
  count,
  disabled = false,
  children,
}: {
  checked: boolean;
  onChange: () => void;
  icon?: ReactNode;
  count?: number;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="graph-check" data-empty={count === 0} data-disabled={disabled}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
      {icon}
      <span>{children}</span>
      {count !== undefined && <span className="graph-count">{count.toLocaleString("en-US")}</span>}
    </label>
  );
}

export function GraphFilters({
  query,
  onQuery,
  hits,
  onPick,
  days,
  onDays,
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
  kindCounts,
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
  days: number;
  onDays: (days: number) => void;
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
  /** entities of each kind, under the other filters */
  kindCounts: Readonly<Record<NodeKind, number>>;
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

  const byName = (a: GraphNode, b: GraphNode) => a.name.localeCompare(b.name);
  const top = agencies.filter((a) => a.kind === "agency").sort(byName);
  const offices = agencies.filter((a) => a.kind === "office").sort(byName);
  const agencyName = agency ? (agencies.find((a) => a.id === agency)?.name ?? "One agency") : null;
  const hiddenKinds = ALL_KINDS.filter((k) => !kinds.has(k));
  const windowLong = WINDOWS.find((w) => w.days === days)?.long ?? `${days} days`;

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
      // first the list, then the text, then the field
      if (showHits) setListed(false);
      else if (query) onQuery("");
      else input.current?.blur();
    }
  };

  const chips: { key: string; label: string; remove: () => void }[] = [
    ...present.filter((t) => tags.has(t)).map((t) => ({ key: `tag:${t}`, label: tagLabel(t), remove: () => onToggleTag(t) })),
    ...(agencyName ? [{ key: "agency", label: agencyName, remove: () => onAgency(null) }] : []),
    ...(min ? [{ key: "min", label: `${AMOUNTS.find((a) => a.min === min)?.label ?? "Minimum"} or more`, remove: () => onMin(0) }] : []),
    ...hiddenKinds.map((k) => ({ key: `kind:${k}`, label: `No ${KIND_LABEL[k].toLowerCase()}`, remove: () => onToggleKind(k) })),
    ...(watch ? [{ key: "watch", label: "Watchlist only", remove: () => onWatch(false) }] : []),
  ];

  const windowSeg = (
    <div className="seg graph-seg graph-float" role="group" aria-label="Time window">
      {WINDOWS.map((w) => (
        <button key={w.days} type="button" aria-pressed={days === w.days} aria-label={w.long} onClick={() => onDays(w.days)}>
          {w.label}
        </button>
      ))}
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
            <SearchIcon />
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
                        <MedallionImg name={medallionFor(h.tag, h.kind)} size={20} />
                        <span className="graph-name">{h.name}</span>
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

          <Group title="Window" value={days ? `Last ${windowLong}` : "Everything on record"} className="graph-only-wide">
            {windowSeg}
          </Group>

          <Group title="Categories" value={tags.size ? `${tags.size} of ${present.length}` : "All"}>
            {/* Several categories share one medallion, so every row carries its name. */}
            <div className="graph-checklist graph-checklist-scroll" role="group" aria-label="Filter by category">
              {present.map((t) => (
                <Check
                  key={t}
                  checked={tags.has(t)}
                  onChange={() => onToggleTag(t)}
                  icon={<MedallionImg name={medallionForTag(t)} size={16} />}
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
                      {a.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {offices.length > 0 && (
                <optgroup label="Offices">
                  {offices.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </Group>

          <Group title="Minimum awarded" value={min ? `${AMOUNTS.find((a) => a.min === min)?.label} or more` : "Any amount"}>
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
              watch
                ? "Watchlist only"
                : hiddenKinds.length
                  ? `${ALL_KINDS.length - hiddenKinds.length} of ${ALL_KINDS.length} kinds`
                  : "Everything"
            }
          >
            <div className="graph-checklist" role="group" aria-label="Kinds of entity">
              {ALL_KINDS.map((k) => (
                <Check key={k} checked={kinds.has(k)} onChange={() => onToggleKind(k)} count={kindCounts[k]}>
                  {KIND_LABEL[k]}
                </Check>
              ))}
              <div className="graph-rule" role="presentation" />
              <Check checked={watch} onChange={() => onWatch(!watch)} disabled={pins === 0 && !watch} count={pins}>
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
