import type { Metadata } from "next";
import { Suspense } from "react";
import { GraphExplorer } from "@/components/GraphExplorer";

export const metadata: Metadata = { title: "Graph" };

export default function GraphPage() {
  return (
    <main>
      <h1 className="sr-only">Funding graph</h1>
      <Suspense fallback={null}>
        <GraphExplorer />
      </Suspense>
    </main>
  );
}
