import "@fontsource/source-sans-3/400.css";
import "@fontsource/source-sans-3/600.css";
import "@fontsource/source-serif-4/600.css";
import "@fontsource/dm-mono/400.css";
import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Legal Retrieval Explorer", description: "Semantic, lexical, and hybrid retrieval over U.S. Supreme Court opinions." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
