import type { Metadata } from "next";
import { Cinzel, Cormorant_Garamond, EB_Garamond } from "next/font/google";
import { Suspense } from "react";
import { Chain } from "@/components/Chain";
import { Flock } from "@/components/Flock";
import { Nav } from "@/components/Nav";
import "./globals.css";

// Display: Cormorant Garamond. Body and figures: EB Garamond (tabular lining
// figures for every number). Cinzel only for small-caps labels. No bold anywhere.
const display = Cormorant_Garamond({
  variable: "--font-cormorant",
  subsets: ["latin"],
  weight: ["400", "500"],
  style: ["normal", "italic"],
});
const serif = EB_Garamond({ variable: "--font-garamond", subsets: ["latin"], style: ["normal", "italic"] });
const caps = Cinzel({ variable: "--font-cinzel", subsets: ["latin"], weight: "400" });

export const metadata: Metadata = {
  title: { default: "flock", template: "%s · flock" },
  description: "Following the money on the frontier of autonomy, from solicitation to production.",
};

// Runs before first paint so day/night and the "still" preference never flash.
const BOOT = `try{var d=document.documentElement,t=localStorage.getItem("flock.theme");t=t?JSON.parse(t):matchMedia("(prefers-color-scheme: dark)").matches?"dusk":"day";d.dataset.theme=t==="day"?"day":"dusk";if(JSON.parse(localStorage.getItem("flock.still")||"false"))d.setAttribute("data-still","")}catch(e){}`;

// Layers in a fixed order: painted art (z 0-9, inside pages), the birds (z-10,
// the flock canvas), the hero's foreground frame (z-12), paper grain (z-15),
// then text and controls (z-20 and up). Page wrappers must not
// create stacking contexts, or the flock could not pass between paint and text.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${serif.variable} ${caps.variable} antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT }} />
        {/* Without scripts nothing reveals the headings and garlands (see
            Reveal.tsx), so show them from the start. */}
        <noscript>
          <style>{`.reveal{opacity:1;transform:none}`}</style>
        </noscript>
      </head>
      <body className="min-h-svh">
        <Suspense fallback={null}>
          <Nav />
        </Suspense>
        <Suspense fallback={null}>
          <Flock />
        </Suspense>
        <div className="grain" aria-hidden="true" />
        {children}
        <Suspense fallback={null}>
          <Chain />
        </Suspense>
      </body>
    </html>
  );
}
