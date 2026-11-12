# flock web

The Next.js site. See "Web UI" in the repository README for how to run it.

- `src/app/` pages: landing, `/forum`, `/forum/leaderboards`, `/graph`, `/entity/[id]`, `/feed`, `/about/numbers`
- `src/app/forum/` the Forum: the signals dashboard. `src/app/forum/leaderboards/` the full rankings
- `src/app/about/numbers/` "About the numbers": what each figure means and what it leaves out, from `GET /api/signals/definitions`
- `src/app/globals.css` the nine color tokens for dark (the default), paper and Classic (which also has a paper grain), the money chart's category colors, and the shared classes: type roles (`.page-title`, `.panel-title`, `.lede`, `.name`, `.figure`, `.reading`, `.caption`, `.label`, `.ui-link`, `.money`, `.delta`), controls (`.btn`, `.seg`, `.field`, `.chip`, `.check`), tables (`.ledger`), floating surfaces (`.surface`, `.tip`) and art (`.art`)
- `public/art/` the engraving pack, resized to `.webp` by `scripts/build-art.py`, in two tones: `on-dark/` and `on-light/`; and `classic/`, the painted art that only the Classic mode shows
- `src/lib/art.ts` the catalog of those files (sizes, widths), the Classic art's own list, and which medallion a category family gets
- `src/components/Art.tsx` art building blocks: one engraving in the tone that suits the mode (with, for a few pictures on the landing page, a painted twin that Classic shows instead), a painted picture only Classic has, a medallion as a small category icon, the empty-state vignette
- `src/components/Nav.tsx` the top bar: the links, the sample-data mark, the watchlist count, and the Display menu (dark, paper or Classic, motion on or off)
- `src/components/Hero.tsx`, `hero.css` the landing scene: one still engraving along the bottom, the headline, the caption and legend for the birds. Classic's painted variant (sky, scene, boats, leafy frame) is in the same markup, chosen in CSS by `data-theme="classic"`
- `src/components/HeroBoats.tsx` the two boats on the hero's lake: both bob and the sailboat drifts across (CSS, in `hero.css`), paused while the hero is off screen or the tab is hidden, and still when motion is off
- `src/components/HeroParallax.tsx` Classic's scroll parallax: the painted sky and the leafy frame drift as the hero scrolls away (off in Dark and Paper, and when motion is off)
- `src/components/Flock.tsx` the murmuration (boids drawn from sprite strips, `src/lib/sprites.ts`): award birds in the accent, solicitation birds in the text color (in Classic, the painted strips). It belongs to the landing hero: it scrolls with the scene, leaves over the last 30% of the hero's scroll, and is not drawn anywhere else. With the hero's two boats, it is the only ambient motion on the site
- `src/components/Footer.tsx` the one-line footer; on the landing page the terrace engraving sits behind it (in Classic, the painted terrace)
- `src/components/GraphExplorer.tsx` the `/graph` screen: fetches the graph, holds the filters, search and selection, and shows them in one of two views (3D by default, `?view=flat` for the flat one), with the side card and the legend
- `src/components/GraphFilters.tsx` the left rail: search, active filters as chips, window, categories, agency, minimum dollars, node types, watchlist only
- `src/components/Graph3D.tsx` the 3D view: mounts `react-force-graph-3d` for the renderer, camera and orbit controls, and falls back to the flat view without WebGL 2
- `src/components/Graph3DLayout.ts` the 3D layout: category constellations, computed once per graph (`d3-force-3d`) and frozen
- `src/components/Graph3DStage.ts` everything the 3D view draws and how it is handled: plain marks (dot, ring, diamond), batched edges, labels, picking, dragging, camera flights, pausing
- `src/components/GraphFlat.tsx` the flat view: a 2D canvas with the same marks, filters and selection
- `src/components/GraphView.ts` what the two views share: their props and camera commands
- `src/lib/graphLayout.ts` the flat layout (ForceAtlas2, then noverlap, run once), the filter both views use (`hiddenNodes`), and the stress-test graph (`/graph?stress=2000`, development only)
- `src/lib/paint.ts` the palette the graph's canvases read from the CSS tokens
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

Stylesheets beside components (`hero.css`, `footer.css`, `forum/forum.css`) are
plain CSS with prefixed class names. CSS Modules are not available here, because
`next.config.ts` sends every `.css` file through the Tailwind loader.

`API_URL` (default `http://127.0.0.1:8000`) is where the FastAPI service runs.
