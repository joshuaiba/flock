import type { Metadata } from "next";
import { Cormorant_Garamond, EB_Garamond, Inter } from "next/font/google";
import { Suspense } from "react";
import { Flock } from "@/components/Flock";
import { Nav } from "@/components/Nav";
import "./globals.css";

// Identity: Cormorant Garamond (the wordmark, titles, entity names, large
// figures). Reading: EB Garamond (the Field Report, About copy, captions).
// Interface: Inter at 13px with tabular figures, for everything else. No bold
// anywhere: the heaviest weight in use is 500.
const display = Cormorant_Garamond({
  variable: "--font-cormorant",
  subsets: ["latin"],
  weight: ["400", "500"],
  style: ["normal", "italic"],
});
const serif = EB_Garamond({ variable: "--font-garamond", subsets: ["latin"], style: ["normal", "italic"] });
const sans = Inter({ variable: "--font-inter", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "flock", template: "%s · flock" },
  description: "Following the money on the frontier of autonomy, from solicitation to production.",
};

// Runs before first paint so the mode and the "still" preference never flash.
// Dark is the default. A value stored by the painted design is carried over:
// "day" becomes "paper" and "dusk" becomes "dark".
const BOOT = `try{var d=document.documentElement,k="flock.theme",s=localStorage.getItem(k),t=s?JSON.parse(s):"dark",m=t==="paper"||t==="day"?"paper":"dark";if(s&&m!==t)localStorage.setItem(k,JSON.stringify(m));d.dataset.theme=m;if(JSON.parse(localStorage.getItem("flock.still")||"false"))d.setAttribute("data-still","")}catch(e){}`;

// Layers, in a fixed order: engravings (z-0, inside pages), the birds (z-10,
// the flock canvas, drawn on the landing page only), text and controls (z-20
// on the landing page, so the flock passes behind the words), then the top bar
// (z-30).
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${display.variable} ${serif.variable} ${sans.variable} antialiased`}
      suppressHydrationWarning
    >
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
      </body>
    </html>
  );
}
