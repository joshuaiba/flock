import { cache } from "react";
import { serverGet } from "@/lib/api";
import { signalPath, type Definitions, type Overview } from "@/lib/signals";

/** The overview is read by the header (as-of date), the headline plaques and
 *  the footer (sample flag). `cache` makes that one request per page render. */
export const getOverview = cache((days: number, tag: string | null) =>
  serverGet<Overview>(signalPath("overview", { window: days, tag })),
);

/** The record's size and reach. The Forum reads one thing from it: whether any
 *  solicitation is loaded at all (`opportunities`), so a panel can tell "none
 *  posted lately" from "no solicitation source yet". */
export const getDefinitions = cache(() => serverGet<Definitions>(signalPath("definitions", {})));
