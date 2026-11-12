"use client";

import { useState, type ReactNode } from "react";
import type { GraphNode, NodeKind } from "@/lib/api";
import { medallionFor, medallionForTag } from "@/lib/art";
import { ALL_KINDS } from "@/lib/graphLayout";
import { tagLabel } from "@/lib/tags";
import { MedallionImg } from "./Art";

// The graph's left rail: search, the time window and the filters. It only
// shows and reports choices; the state lives in GraphExplorer.tsx, and one
// function (lib/graphLayout.ts hiddenNodes) applies it to both views.
//
// On a wide screen the filters sit under the search field and scroll inside
// the rail when the window is short (a 13-inch laptop). On a phone they fold
// behind a "Filters" button so the map stays visible.

export const WINDOWS = [
  { days: 30, label: "30d", long: "30 days" },
  { days: 90, label: "90d", long: "90 days" },
  { days: 365, label: "1y", long: "1 year" },
  { days: 0, label: "all", long: "everything on record" },
];

/** Minimum-dollar steps: companies awarded less in the window are hidden. */
export const AMOUNTS = [
  { min: 0, label: "any" },
  { min: 1e6, label: "$1M" },
  { min: 1e7, label: "$10M" },
  { min: 1e8, label: "$100M" },
];

// There is no "program" in the data: the kinds are these four.
const KIND_LABEL: Record<NodeKind, string> = {
  company: "companies",
  agency: "agencies",
  office: "offices",
  opportunity: "solicitations",
};

const caps = "font-caps text-[0.66rem] uppercase tracking-[0.14em]";
const on = "bg-card text-ink shadow-[0_0_0_1px_var(--frame)]";
const off = "text-muted hover:text-ink";
const pressed = "bg-sage/45 text-ink shadow-[inset_0_0_0_1.5px_var(--cypress)]";

/** A filter group that folds away, with a short note on what it is set to. */
function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <details className="group" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none items-baseline gap-2 rounded py-1 [&::-webkit-details-marker]:hidden">
        <span className="label">{title}</span>
        {note && <span className="min-w-0 flex-1 truncate text-[0.95rem] italic text-muted">{note}</span>}
        <span aria-hidden="true" className="ml-auto text-muted transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>
      <div className="pb-1 pt-1.5">{children}</div>
    </details>
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
  tags,
  onToggleTag,
  onClearTags,
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
  tags: ReadonlySet<string>;
  onToggleTag: (tag: string) => void;
  onClearTags: () => void;
  /** agencies and offices in this window */
  agencies: GraphNode[];
  agency: string | null;
  onAgency: (id: string | null) => void;
  min: number;
  onMin: (min: number) => void;
  kinds: ReadonlySet<NodeKind>;
  onToggleKind: (kind: NodeKind) => void;
  watch: boolean;
  onWatch: (on: boolean) => void;
  /** how many organizations are on the watchlist */
  pins: number;
  /** how many filters are narrowing the map */
  active: number;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false); // the filters, on a narrow screen
  const byName = (a: GraphNode, b: GraphNode) => a.name.localeCompare(b.name);
  const top = agencies.filter((a) => a.kind === "agency").sort(byName);
  const offices = agencies.filter((a) => a.kind === "office").sort(byName);

  return (
    <aside
      data-obstacle
      aria-label="Graph filters"
      className="absolute left-3 right-3 top-[4.5rem] flex max-h-[calc(100svh-6rem)] flex-col gap-3 md:left-7 md:right-auto md:top-20 md:max-h-[calc(100svh-9.5rem)] md:w-64"
    >
      <div>
        <label className="marble flex w-full cursor-text items-center rounded-full px-4 py-1.5">
          <span className="sr-only">Search the graph</span>
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Find a company or agency"
            className="w-full bg-transparent text-[1.05rem] text-ink outline-none placeholder:italic placeholder:text-muted"
            type="search"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {query.trim() && (
          <div className="paper-card mt-2 overflow-hidden p-2">
            {hits.length ? (
              <ul>
                {hits.map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      onClick={() => onPick(h.id)}
                      className="flex w-full cursor-pointer items-center gap-2.5 rounded px-2 py-1 text-left hover:bg-hair"
                    >
                      <MedallionImg name={medallionFor(h.tag, h.kind)} size={24} />
                      <span className="truncate">{h.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-2 py-1.5 italic text-muted">
                {active ? "No one by that name among what is shown." : "No one by that name in this window."}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <div>
          <p className="label mb-2 hidden md:block">Window</p>
          <div className="marble inline-flex rounded-full p-1" role="group" aria-label="Time window">
            {WINDOWS.map((w) => (
              <button
                key={w.days}
                type="button"
                aria-pressed={days === w.days}
                aria-label={w.long}
                onClick={() => onDays(w.days)}
                className={`cursor-pointer rounded-full px-3 py-0.5 transition-colors ${caps} ${days === w.days ? on : off}`}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="graph-filter-list"
          onClick={() => setOpen((was) => !was)}
          className={`marble cursor-pointer rounded-full px-3.5 py-1.5 md:hidden ${caps}`}
        >
          Filters{active > 0 && <span className="fig ml-1.5 text-[0.8rem] normal-case">({active})</span>}
        </button>
      </div>

      {/* The filters. They scroll inside the rail when the window is short. */}
      <div
        id="graph-filter-list"
        className={`paper-card min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4 [scrollbar-width:thin] md:-mx-1.5 md:flex md:border-0 md:bg-transparent md:px-1.5 md:pb-3 md:pt-0 md:shadow-none ${
          open ? "flex" : "hidden"
        }`}
      >
        <Section title="Categories" note={tags.size ? `${tags.size} of ${present.length}` : "all"}>
          {/* Several categories share one medallion, so every filter carries its name. */}
          <ul aria-label="Filter by category" className="marble space-y-0.5 rounded-[1.25rem] p-1.5">
            {present.map((t) => (
              <li key={t}>
                <button
                  type="button"
                  aria-pressed={tags.has(t)}
                  onClick={() => onToggleTag(t)}
                  className={`flex w-full cursor-pointer items-center gap-2.5 rounded-full py-0.5 pl-0.5 pr-3 text-left text-[0.98rem] leading-tight transition-colors ${
                    tags.has(t) ? pressed : "text-muted hover:bg-hair hover:text-ink"
                  }`}
                >
                  <MedallionImg name={medallionForTag(t)} size={28} />
                  <span className="min-w-0 truncate">{tagLabel(t)}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[0.98rem] italic leading-snug text-muted">
            {tags.size ? `${tags.size} of ${present.length} shown` : "All categories"}
            {tags.size > 0 && (
              <button type="button" onClick={onClearTags} className="ml-2 cursor-pointer not-italic underline">
                clear
              </button>
            )}
          </p>
        </Section>

        <Section title="Agency" note={agency ? undefined : "all"}>
          <label className="marble flex items-center rounded-full py-1 pl-4 pr-2">
            <span className="sr-only">Show one agency or office, its awardees and its solicitations</span>
            <select
              value={agency ?? ""}
              onChange={(e) => onAgency(e.target.value || null)}
              className="w-full min-w-0 cursor-pointer truncate rounded-full bg-transparent py-0.5 text-[0.98rem] text-ink outline-offset-2"
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
          </label>
        </Section>

        <Section title="Awarded at least" note={min ? undefined : "any amount"}>
          <div className="marble inline-flex rounded-full p-1" role="group" aria-label="Least dollars awarded to a company">
            {AMOUNTS.map((a) => (
              <button
                key={a.min}
                type="button"
                aria-pressed={min === a.min}
                onClick={() => onMin(a.min)}
                className={`fig cursor-pointer rounded-full px-2.5 py-0.5 text-[0.92rem] transition-colors ${min === a.min ? on : off}`}
              >
                {a.label}
              </button>
            ))}
          </div>
        </Section>

        <Section title="Show" note={kinds.size === ALL_KINDS.length && !watch ? "everything" : undefined}>
          <div className="marble flex flex-wrap gap-1 rounded-[1.1rem] p-1" role="group" aria-label="Node types">
            {ALL_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kinds.has(k)}
                onClick={() => onToggleKind(k)}
                className={`cursor-pointer rounded-full px-2.5 py-1 transition-colors ${caps} ${
                  kinds.has(k) ? pressed : "text-muted hover:bg-hair hover:text-ink"
                }`}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-pressed={watch}
            disabled={pins === 0 && !watch}
            onClick={() => onWatch(!watch)}
            className={`marble mt-2 cursor-pointer rounded-full px-3.5 py-1.5 transition-colors disabled:cursor-default disabled:opacity-50 ${caps} ${
              watch ? pressed : "text-ink"
            }`}
          >
            Watchlist only
          </button>
          <p className="mt-1.5 text-[0.95rem] italic leading-snug text-muted">
            {pins === 0
              ? "Nothing is on the chain yet."
              : watch
                ? "The chain and its direct neighbors."
                : `${pins} on the chain.`}
          </p>
        </Section>

        {active > 0 && (
          <p>
            <button type="button" onClick={onReset} className="cursor-pointer text-[0.98rem] underline">
              Clear all filters
            </button>
          </p>
        )}
      </div>
    </aside>
  );
}
