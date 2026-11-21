"use client";

import {
  missionLabel,
  WINDOW_KEYS,
  WINDOW_NAMES,
  type Filters,
  type Flows,
  type Named,
  type WindowKey,
} from "@/lib/flows";

// The filter rail: the window, the missions, one agency, a least award. Every
// choice narrows all three views and the inspector at once, and is kept in the
// address so the view can be shared.

export const MINIMUMS = [
  { value: 0, label: "Any" },
  { value: 1e6, label: "$1M" },
  { value: 1e7, label: "$10M" },
  { value: 1e8, label: "$100M" },
] as const;

export function FilterRail({
  data,
  who,
  filters,
  counts,
  shown,
  pending,
  onWindow,
  onChange,
  onReset,
}: {
  data: Flows;
  who: Map<string, Named>;
  filters: Filters;
  /** companies with an award in each mission, under the other filters */
  counts: Map<string, number>;
  /** awards in view, and in the window */
  shown: { awards: number; of: number };
  pending: boolean;
  onWindow: (key: WindowKey) => void;
  onChange: (patch: Partial<Filters>) => void;
  onReset: () => void;
}) {
  const slugs = data.missions.map((m) => m.slug);
  const on = (slug: string) => !filters.missions || filters.missions.has(slug);
  const toggle = (slug: string) => {
    const next = new Set(filters.missions ?? slugs);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    onChange({ missions: next.size === slugs.length ? null : next });
  };
  const filtered = !!filters.missions || !!filters.agency || filters.min > 0 || !!filters.from;
  const payers = data.agencies.filter((a) => a.awards > 0);

  return (
    <aside className="ex-rail" aria-label="Filters">
      <div>
        <p className="ex-sec" id="ex-window">
          Window
        </p>
        <div className="ex-seg" role="group" aria-labelledby="ex-window">
          {WINDOW_KEYS.map((key) => {
            const w = data.windows.find((x) => x.key === key);
            const empty = !w?.awards;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={data.window.key === key}
                disabled={empty}
                title={w ? `${w.label}: ${(w.awards ?? 0).toLocaleString("en-US")} awards` : undefined}
                onClick={() => onWindow(key)}
              >
                {WINDOW_NAMES[key]}
              </button>
            );
          })}
        </div>
        <p className="ex-windowline" aria-live="polite">
          {pending ? "Loading…" : data.window.label}
        </p>
      </div>

      <fieldset>
        <legend className="ex-sec">
          Missions
          {filters.missions && (
            <button type="button" className="ex-linkish" onClick={() => onChange({ missions: null })}>
              all
            </button>
          )}
        </legend>
        <ul className="ex-checks">
          {slugs.map((slug) => (
            <li key={slug}>
              <label>
                <input type="checkbox" checked={on(slug)} onChange={() => toggle(slug)} />
                <span>{missionLabel(slug)}</span>
                <span className="ex-n" title="companies with an award in this mission">
                  {counts.get(slug) ?? 0}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <div>
        <label className="ex-sec" htmlFor="ex-agency">
          Agency
        </label>
        <select
          id="ex-agency"
          className="ex-select"
          value={filters.agency ?? ""}
          onChange={(e) => onChange({ agency: e.target.value || null })}
        >
          <option value="">All agencies</option>
          {payers.map((a) => (
            <option key={a.id} value={a.id}>
              {who.get(a.id)?.label ?? a.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <p className="ex-sec" id="ex-min">
          Minimum award
        </p>
        <div className="ex-chips-row" role="group" aria-labelledby="ex-min">
          {MINIMUMS.map((m) => (
            <button
              key={m.value}
              type="button"
              className="ex-chip"
              aria-pressed={filters.min === m.value}
              onClick={() => onChange({ min: m.value })}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <p className="ex-shown" aria-live="polite">
        <span>{shown.awards.toLocaleString("en-US")}</span> of {shown.of.toLocaleString("en-US")} awards shown
        {filtered && (
          <button type="button" className="ex-linkish" onClick={onReset}>
            reset
          </button>
        )}
      </p>
    </aside>
  );
}
