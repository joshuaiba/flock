# flock web

The Next.js site. See "Web UI" in the repository README for how to run it.

- `src/app/` pages: landing, `/forum`, `/forum/leaderboards`, `/graph`, `/entity/[id]`, `/feed`, `/about/numbers`
- `src/app/forum/` the Forum: the signals dashboard. `src/app/forum/leaderboards/` the full rankings
- `src/app/about/numbers/` "About the numbers": what each figure means and what it leaves out, from `GET /api/signals/definitions`
- `src/app/globals.css` the color tokens for dark (the default), paper and Classic (which also has a paper grain), the money chart's category colors, and the shared classes: type roles (`.page-title`, `.panel-title`, `.lede`, `.name`, `.figure`, `.reading`, `.caption`, `.label`, `.ui-link`, `.money`, `.delta`), controls (`.btn`, `.seg`, `.field`, `.chip`, `.check`), tables (`.ledger`), floating surfaces (`.surface`, `.tip`) and art (`.art`)
- `public/art/` the engraving pack, resized to `.webp` by `scripts/build-art.py`, in two tones: `on-dark/` and `on-light/`; and `classic/`, the painted art that only the Classic mode shows
- `src/lib/art.ts` the catalog of those files (sizes, widths), the Classic art's own list, and which medallion a category family gets
- `src/components/Art.tsx` art building blocks: one engraving in the tone that suits the mode (with, for a few pictures on the landing page, a painted twin that Classic shows instead), a painted picture only Classic has, a medallion as a small category icon, the empty-state vignette
- `src/components/Nav.tsx` the top bar: the links, the sample-data mark, the watchlist count, and the Display menu (dark, paper or Classic, motion on or off)
- `src/components/landing/StarHero.tsx`, `landing.css` the landing page's hero: the headline, the star chart (real arcs, hover to read one, the copper ones open their source record), the narrated tour, and the feed of the newest awards
- `src/components/landing/Sections.tsx` the landing page under the hero: three ways into the graph (thumbnails drawn from the same data), top recipients, companies per mission
- `src/lib/starChart.ts` the star chart's geometry: agencies on the limb, missions as sectors, companies as stars, placed by rank and a hash of the id
- `src/components/CommandPalette.tsx` Cmd+K: find a company or an agency (`/api/search`) and open its constellation, or jump to a view
- `src/components/Footer.tsx` the one-line footer; on the landing page the terrace engraving sits behind it (in Classic, the painted terrace)
- `src/lib/flows.ts` the explorer's data layer: the types of `GET /api/flows`, the filters, the tally every view draws (`buildModel`), the headline, and the fixed layouts of the Sankey and the constellation
- `src/components/explorer/Explorer.tsx` the `/graph` screen: holds the window, view, selection and filters (all in the address), and lays out the rail, the view, the timeline strip and the inspector
- `src/components/explorer/FlowView.tsx` the flow: Agency → Mission → Recipient as a Sankey with hatched bands; select a node, hover a band, open the folded tail
- `src/components/explorer/ConstellationView.tsx` one company's or agency's neighborhood on two fixed rings, the rest ghosted; click to re-center
- `src/components/explorer/Timeline.tsx` award ticks, the brush (drag, or arrow keys on its handles), solicitation diamonds; one row as a strip, a row per mission as the Timeline view
- `src/components/explorer/FilterRail.tsx`, `Inspector.tsx` the filters on the left; on the right the selection's totals, breakdowns and award records, each linked to its source
- `src/components/explorer/parts.tsx` shared pieces: the hatch pattern, tick ring and diamond, the tooltip, the width measure, the "last visit" record
- `src/components/explorer/explorer.css` the explorer's styles (prefix `ex-`)
- `src/lib/store.tsx` what lives in the browser: the mode (dark, paper or Classic), the motion switch, and the watchlist's pins
- `src/lib/signals.ts` types for the signals API (`/api/signals/*`), the windows and wording helpers
- `src/components/Signals.tsx` shared pieces of the signals pages: panel, change against the prior period, rank change, organization link, stage dots, as-of line, loading rows
- `src/components/SignalFilters.tsx` the window and category controls, kept in the URL (`?window=&tag=`)
- `src/components/SeriesChart.tsx` one series as a thin line in the text color, used as a sparkline
- `src/components/forum/` the Forum's panels and the data they load; `MoneyByFamily.tsx` and `MoneyBar.tsx` are "Where the money went", `ForumGutters.tsx` the engraved figures in the margins
- `src/components/leaderboards/` the leaderboards: the tabs, each board's columns, the ledger table, and the URL state (`view.ts`)
- `src/components/EntitySignals.tsx` the signals row on the entity page: 90-day dollars, rank, stage reached, time since the last award
- `src/components/FlightPath.tsx` the entity page's path to production: one line, four stages, the time between them
- `src/lib/tags.ts` the autonomy categories and their plain-English names

Stylesheets beside components (`landing/landing.css`, `explorer/explorer.css`, `footer.css`, `forum/forum.css`) are
plain CSS with prefixed class names. CSS Modules are not available here, because
`next.config.ts` sends every `.css` file through the Tailwind loader.

`API_URL` (default `http://127.0.0.1:8000`) is where the FastAPI service runs.
