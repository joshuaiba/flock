import { cache } from "react";
import { serverGet } from "@/lib/api";
import { signalPath, type Definitions } from "@/lib/signals";

/** The record as a whole: its as-of date, whether it is sample data, and how
 *  many solicitations it holds. The header, the ledger and the footer all read
 *  it; `cache` makes that one request per page render. Null when the API is down. */
export const getRecord = cache(() => serverGet<Definitions>(signalPath("definitions", {})));
