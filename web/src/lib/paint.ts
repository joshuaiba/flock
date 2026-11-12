// The palette for the graph's canvases, read from the CSS tokens (see
// app/globals.css) so they follow the mode: dark by default, or paper.

export type Palette = {
  /** the page */
  bg: string;
  /** things that float */
  surface: string;
  /** text, node marks, the edges that are not awards */
  text: string;
  muted: string;
  faint: string;
  /** hairlines, as CSS colors with their own alpha */
  line: string;
  line2: string;
  /** dollars awarded: award edges */
  accent: string;
  /** true in paper mode */
  paper: boolean;
};

/** The palette from CSS variables. The solid colors are plain #rrggbb. */
export function readPalette(): Palette {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => s.getPropertyValue(n).trim();
  return {
    bg: v("--bg"),
    surface: v("--surface"),
    text: v("--text"),
    muted: v("--muted"),
    faint: v("--faint"),
    line: v("--line"),
    line2: v("--line2"),
    accent: v("--accent"),
    paper: document.documentElement.dataset.theme === "paper",
  };
}
