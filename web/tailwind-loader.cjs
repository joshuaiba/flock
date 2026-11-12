// The Tailwind loader for Turbopack, with one correction.
//
// @tailwindcss/turbopack keeps a compiled stylesheet per CSS file and compiles
// it again only when the file's modification time changes. It never compares
// the source text it is handed. Turbopack can run a loader twice for one
// change: first with the copy of the file it already had, then with the new
// one. The file's time is the same both times, so the second run reuses the
// stylesheet compiled from the old text. The result is a page whose markup is
// new and whose globals.css is old: utilities found by the scan are there,
// but new rules written in the file are missing. It happened on a deploy
// (a build that starts from the last build's cache) and under `next dev`.
//
// This wrapper makes the loader's cache key depend on the source text, so a
// stylesheet is only ever reused for the text it was compiled from.
// next.config.ts sends every .css file here.

const { createHash } = require("node:crypto");
const tailwind = require("@tailwindcss/turbopack");

const inner = tailwind.default ?? tailwind;

module.exports = function tailwindLoader(source) {
  const done = this.async();
  const text = typeof source === "string" ? source : source.toString("utf8");
  const hash = createHash("sha1").update(text).digest("hex").slice(0, 16);
  // The loader keys its cache on `resource`; everything else is the real
  // loader context.
  const context = Object.create(this, {
    resource: { value: `${this.resource}#${hash}`, enumerable: true },
    async: { value: () => done, enumerable: true },
  });
  Promise.resolve(inner.call(context, source)).catch(done);
};
