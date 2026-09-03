import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";
import "./responsive.css";

export const metadata: Metadata = {
  title: { default: "OrbitCID | Self-hosted IPFS", template: "%s | OrbitCID" },
  description: "A secure control surface for self-hosted IPFS infrastructure.",
  robots: { index: true, follow: true }
};
export const viewport: Viewport = { colorScheme: "light", themeColor: "#f3f0ee", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><a className="skip-link" href="#content">Skip to content</a><SiteHeader/><div id="content">{children}</div><footer className="site-footer"><span>© 2026 Md. Rakib • made with love and passion.</span><nav aria-label="Legal"><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link></nav></footer></body></html>;
}
