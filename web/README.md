# flock web

The Next.js site. See "Web UI" in the repository README for how to run it.

- `src/app/` pages: landing, `/forum`, `/forum/leaderboards`, `/graph`, `/entity/[id]`, `/feed`, `/about/numbers`
- `src/app/forum/` the Forum: the signals dashboard. `src/app/forum/leaderboards/` the full rankings
- `src/app/about/numbers/` "About the numbers": what each figure means and what it leaves out, from `GET /api/signals/definitions`
- `src/app/globals.css` the palette for day and dusk, paper grain, and the shared classes: interface text (`.ui`, `.label`, `.ui-link`), controls (`.btn`, `.seg`, `.field`, `.chip`), signed changes (`.delta`), tables (`.ledger`) and the title plaque (`.title-plaque`)
- `public/art/` the illustration pack, resized to `.webp` by `scripts/build-art.py`
- `src/lib/art.ts` the catalog of those files (sizes, widths) and which medallion a category gets
- `src/components/Art.tsx` art building blocks: garland, Greek-key rule, corner vine, cartouche (the landing page's About header only), fresco, medallion, empty-state vignette
- `src/components/Nav.tsx` the top bar and its Display menu (day or dusk, motion on or off)
- `src/components/Hero.tsx`, `HeroMotion.tsx`, `hero.css` the landing scene: layers (the lake lies behind the village, dropped to its shoreline), parallax, water shimmer, pausing
- `src/components/Flock.tsx` the murmuration (boids drawn from sprite strips, `src/lib/sprites.ts`). It belongs to the landing hero: it scrolls with the scene, leaves over the last 30% of the hero's scroll, and is not drawn anywhere else
- `src/components/GraphExplorer.tsx` the `/graph` screen: fetches the graph, holds the filters, search and selection, and shows them in one of two views (3D by default, `?view=flat` for the flat one)
- `src/components/GraphFilters.tsx` the left rail: search, window, categories, agency, minimum dollars, node types, watchlist only
- `src/components/Graph3D.tsx` the 3D view: mounts `react-force-graph-3d` for the renderer, camera and orbit controls, and falls back to the flat view without WebGL 2
- `src/components/Graph3DLayout.ts` the 3D layout: category constellations, computed once per graph (`d3-force-3d`) and frozen
- `src/components/Graph3DStage.ts` everything the 3D view draws and how it is handled: medallion sprites, batched edges, particles, labels, picking, dragging, camera flights, idle rotation, pausing
- `src/components/GraphFlat.tsx` the flat view: a 2D canvas with the same filters and selection
- `src/components/GraphView.ts` what the two views share: their props and camera commands
- `src/lib/graphLayout.ts` the flat layout (ForceAtlas2, then noverlap, run once), the filter both views use (`hiddenNodes`), and the stress-test graph (`/graph?stress=2000`, development only)
- `src/components/Chain.tsx` the watchlist: medallions on a gold chain (Matter.js)
- `src/lib/signals.ts` types for the signals API (`/api/signals/*`), the windows, wording helpers, and the five chart color families
- `src/components/Signals.tsx` shared pieces of the signals pages: panel, change against the prior period, rank change, organization link, stage dots, as-of line, loading rows
- `src/components/SignalFilters.tsx` the window and category controls, kept in the URL (`?window=&tag=`)
- `src/components/SeriesChart.tsx` one series as a line over a wash, used as a sparkline or a small multiple
- `src/components/forum/` the Forum's panels and the data they load
- `src/components/leaderboards/` the leaderboards: the tabs, each board's columns, the ledger table, and the URL state (`view.ts`)
- `src/components/EntitySignals.tsx` the Signals block on the entity page: 90-day momentum, rank, stage reached, time since the last award
- `src/lib/tags.ts` the autonomy categories and their plain-English names

Stylesheets beside components (`hero.css`, `footer.css`) are plain CSS with
prefixed class names. CSS Modules are not available here, because
`next.config.ts` sends every `.css` file through the Tailwind loader.

`API_URL` (default `http://127.0.0.1:8000`) is where the FastAPI service runs.
