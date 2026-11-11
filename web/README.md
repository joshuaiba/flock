# flock web

The Next.js site. See "Web UI" in the repository README for how to run it.

- `src/app/` pages: landing, `/graph`, `/entity/[id]`, `/feed`
- `src/app/globals.css` the fresco palette for day and dusk, marble, plaster grain
- `src/components/Landscape.tsx` the painted scenes, drawn as animated SVG
- `src/components/Flock.tsx` the murmuration (boids, painted swallows)
- `src/components/GraphExplorer.tsx` the graph canvas: camera, medallions, labels
- `src/lib/graphLayout.ts` graph layout: ForceAtlas2, then noverlap, run once
- `src/components/Chain.tsx` the watchlist: marble medallions on a gold chain (Matter.js)
- `src/lib/paint.ts` brushstroke birds and watercolor blooms, shared by the flock and the graph
- `src/lib/icons.ts` engraved line icons, one per category

`API_URL` (default `http://127.0.0.1:8000`) is where the FastAPI service runs.
