import type { RefObject } from "react";
import type { Graph } from "@/lib/api";

// What the explorer (GraphExplorer.tsx) and its two renderers agree on. The
// flat canvas and the 3D scene are two views of one filtered graph: both take
// the same props, and each registers the same few camera commands.

/** Camera commands a view offers to the controls around it. */
export type GraphViewApi = {
  /** Show the whole graph. */
  fit: (animate: boolean) => void;
  /** Bring a node and its neighbors into view. `fly` marks an arrival from a link. */
  focusOn: (id: string, fly: boolean) => void;
  /** Zoom by a factor: above 1 moves closer. */
  zoom: (factor: number) => void;
};

export const NO_API: GraphViewApi = { fit: () => {}, focusOn: () => {}, zoom: () => {} };

export type GraphViewProps = {
  graph: Graph | null;
  /** ids the filters hide (lib/graphLayout.ts hiddenNodes) */
  hidden: ReadonlySet<string>;
  /** the category filter, so category names follow it */
  tags: ReadonlySet<string>;
  selected: string | null;
  /** the search text, trimmed and lower-cased */
  query: string;
  /** false until this view has laid out the current graph */
  ready: boolean;
  /** the view puts its camera commands here while it is mounted */
  api: RefObject<GraphViewApi>;
  onSelect: (id: string | null) => void;
  onReady: (ready: boolean) => void;
};
