# flock web

The Next.js site. See "Web UI" in the repository README for how to run it.

- `src/app/` pages: landing, `/graph`, `/entity/[id]`, `/feed`
- `src/app/globals.css` the palette for day and dusk, paper grain, shared classes
- `public/art/` the illustration pack, resized to `.webp` by `scripts/build-art.py`
- `src/lib/art.ts` the catalog of those files (sizes, widths) and which medallion a category gets
- `src/components/Art.tsx` art building blocks: garland, Greek-key rule, corner vine, cartouche, fresco, medallion, empty-state vignette
- `src/components/Hero.tsx`, `HeroMotion.tsx`, `hero.css` the landing scene: layers, parallax, water shimmer, pausing
- `src/components/Flock.tsx` the murmuration (boids drawn from sprite strips, `src/lib/sprites.ts`)
- `src/components/GraphExplorer.tsx` the graph canvas: camera, medallion nodes, labels
- `src/lib/graphLayout.ts` graph layout: ForceAtlas2, then noverlap, run once
- `src/components/Chain.tsx` the watchlist: medallions on a gold chain (Matter.js)
- `src/lib/tags.ts` the autonomy categories and their plain-English names

Stylesheets beside components (`hero.css`, `footer.css`) are plain CSS with
prefixed class names. CSS Modules are not available here, because
`next.config.ts` sends every `.css` file through the Tailwind loader.

`API_URL` (default `http://127.0.0.1:8000`) is where the FastAPI service runs.
