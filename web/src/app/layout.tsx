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
const BOOT = `try{var d=document.documentElement,t=localStorage.getItem("flock.theme");d.dataset.theme=t?JSON.parse(t):matchMedia("(prefers-color-scheme: dark)").matches?"night":"day";if(JSON.parse(localStorage.getItem("flock.still")||"false"))d.setAttribute("data-still","")}catch(e){}`;

// Three layers in a fixed order: painted ground (z-0, inside pages), the birds
// (z-10, the flock canvas), marble and text (z-20 and up). Page wrappers must not
// create stacking contexts, or the flock could not pass between paint and text.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${serif.variable} ${caps.variable} antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT }} />
      </head>
      <body className="min-h-svh">
        <Suspense fallback={null}>
          <Nav />
        </Suspense>
        <Suspense fallback={null}>
          <Flock />
        </Suspense>
        {children}
        <Suspense fallback={null}>
          <Chain />
        </Suspense>
      </body>
    </html>
  );
}
