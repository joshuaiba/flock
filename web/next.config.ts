import type { NextConfig } from "next";

// The FastAPI service (uv run python -m pipeline.api.dev). Server components call
// it directly (src/lib/api.ts). The browser calls same-origin /api/*:
// - On Vercel, vercel.json routes /api/* to the api service before a request
//   reaches Next, so no rewrite is needed here. (The API_URL binding resolves
//   only at request time, so it could not be baked into a rewrite at build time.)
// - Under `pnpm dev` / `pnpm start`, the rewrite below proxies it, so there is no
//   CORS and no public API URL to configure.
const API_URL = process.env.API_URL ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  async rewrites() {
    if (process.env.VERCEL) return [];
    return [{ source: "/api/:path*", destination: `${API_URL.replace(/\/$/, "")}/api/:path*` }];
  },
  turbopack: {
    rules: {
      // Every .css file goes through Tailwind's loader, by way of a small
      // wrapper that keeps it from serving a stale stylesheet (see the file).
      "*.css": {
        loaders: [require.resolve("./tailwind-loader.cjs")],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
