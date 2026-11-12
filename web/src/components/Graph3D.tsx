"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import ForceGraph3D, { type ForceGraphMethods } from "react-force-graph-3d";
import type { Graph } from "@/lib/api";
import { readPalette } from "@/lib/paint";
import { useStore } from "@/lib/store";
import { layoutGraph3D, type Scene3 } from "./Graph3DLayout";
import { createStage, type Stage } from "./Graph3DStage";
import { NO_API, type GraphViewProps } from "./GraphView";

// The 3D view of the graph: the same filtered graph as the flat view, laid out
// as constellations by category and turned with orbit controls.
//
// react-force-graph-3d hosts the WebGL scene: renderer, camera, controls and
// render loop. It is given no graph data of its own. The layout is computed
// once and frozen (Graph3DLayout.ts), and the nodes, edges, particles and
// labels are drawn in batches by Graph3DStage.ts, because the library draws
// one object per edge and that does not hold frame rate at thousands of edges.
//
// This file is loaded only in the browser, and only when the 3D view is shown
// (GraphExplorer.tsx imports it lazily): three.js needs `window`.

const NOTHING = { nodes: [], links: [] };
const RENDERER = { antialias: true, alpha: false, powerPreference: "high-performance" as const };

/** Layouts already computed, so switching between the two views is instant. */
const laidOut = new WeakMap<Graph, Scene3>();

let webgl: boolean | null = null;
/** Whether this browser can draw the 3D view at all (three.js needs WebGL 2). */
function hasWebGL(): boolean {
  if (webgl !== null) return webgl;
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    webgl = !!gl;
    gl?.getExtension("WEBGL_lose_context")?.loseContext(); // hand the test context straight back
  } catch {
    webgl = false;
  }
  return webgl;
}

export default function Graph3D({
  graph,
  hidden,
  tags,
  selected,
  query,
  ready,
  api,
  onSelect,
  onReady,
  onUnsupported,
}: GraphViewProps & {
  /** this browser has no WebGL: the explorer falls back to the flat view */
  onUnsupported: () => void;
}) {
  const { motion, theme, pin } = useStore();
  const wrapRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const host = useRef<ForceGraphMethods | undefined>(undefined);
  const lossTimer = useRef(0);
  const out = useRef({ onSelect, onReady, onUnsupported, pin });
  out.current = { onSelect, onReady, onUnsupported, pin };

  const [gl] = useState(hasWebGL);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  // The page color, for the canvas background: parchment by day, blue-violet at dusk.
  const [paper, setPaper] = useState(() => readPalette().paper);
  const [stage, setStage] = useState<Stage | null>(null);
  const mounted = gl && !!size;

  useEffect(() => {
    if (!gl) out.current.onUnsupported();
  }, [gl]);

  // The canvas always matches its container.
  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const read = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w && h) setSize((was) => (was && was.w === w && was.h === h ? was : { w, h }));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The stage: created once the library has mounted its scene, disposed with it.
  useEffect(() => {
    const fg = host.current;
    const wrap = wrapRef.current;
    if (!mounted || !fg || !wrap) return;
    clearTimeout(lossTimer.current); // development double-mount: this renderer is still in use
    const renderer = fg.renderer();
    const made = createStage({
      host: fg,
      wrap,
      labels: labelsRef.current!,
      tip: tipRef.current!,
      onSelect: (id) => out.current.onSelect(id),
      onPin: (n) => out.current.pin({ id: Number(n.id.split(":")[1]), name: n.name, tag: n.tag, kind: n.kind }),
    });
    setStage(made);
    const mine = { fit: made.fit, focusOn: made.focusOn, zoom: made.zoom };
    api.current = mine;

    // No rendering while the tab is hidden or the graph is off screen.
    let onScreen = true;
    const block = () => made.setBlocked(document.hidden || !onScreen);
    const io = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      block();
    });
    io.observe(wrap);
    document.addEventListener("visibilitychange", block);

    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", block);
      if (api.current === mine) api.current = NO_API;
      made.dispose();
      setStage(null);
      // The library disposes its renderer when it unmounts. Browsers allow only
      // a few WebGL contexts, so this one is released at once too, not left
      // for garbage collection (switching views back and forth would run out).
      lossTimer.current = window.setTimeout(() => {
        try {
          renderer.forceContextLoss();
        } catch {
          /* already gone */
        }
      }, 0);
    };
  }, [mounted, api]);

  // One layout pass per graph, then the scene is built and stays frozen.
  useEffect(() => {
    if (!stage || !graph) return;
    let alive = true;
    Promise.all([laidOut.get(graph) ?? layoutGraph3D(graph, () => alive), stage.ready]).then(([scene]) => {
      if (!alive || !scene) return;
      laidOut.set(graph, scene);
      stage.setScene(scene);
      out.current.onReady(true);
    });
    return () => {
      alive = false;
    };
  }, [stage, graph]);

  // Filters, selection, search and preferences: the same values the flat view gets.
  useEffect(() => stage?.setHidden(hidden, tags), [stage, hidden, tags]);
  useEffect(() => stage?.setSelected(selected), [stage, selected]);
  useEffect(() => stage?.setQuery(query), [stage, query]);
  useEffect(() => stage?.setMotion(motion), [stage, motion]);
  useEffect(() => {
    setPaper(readPalette().paper);
    stage?.retheme();
  }, [stage, theme]);
  useEffect(() => stage?.wake(), [stage, size]);

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      role="application"
      aria-label="Funding graph in three dimensions. Drag to turn it, scroll or plus and minus to zoom, arrow keys to orbit, zero to fit, drag a node to move it. Use search to find and select an entity."
      className={`absolute inset-0 touch-none outline-none transition-opacity duration-700 ${
        ready ? "opacity-100" : "opacity-0"
      }`}
    >
      {mounted && (
        <ForceGraph3D
          ref={host}
          graphData={NOTHING}
          width={size.w}
          height={size.h}
          backgroundColor={paper}
          showNavInfo={false}
          enablePointerInteraction={false}
          enableNodeDrag={false}
          controlType="orbit"
          rendererConfig={RENDERER}
        />
      )}
      {/* Paper grain: above the canvas, below the names and the controls. */}
      <div className="grain grain-local" aria-hidden="true" />
      <div ref={labelsRef} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden" />
      <div
        ref={tipRef}
        className="fig paper-card pointer-events-none absolute left-0 top-0 whitespace-nowrap px-3 py-1 opacity-0 !shadow-none transition-opacity duration-150"
      />
    </div>
  );
}
