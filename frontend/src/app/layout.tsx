import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";
import "./responsive.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.BETTER_AUTH_URL || "http://localhost:3000"),
  title: { default: "OrbitCID | Self-hosted IPFS", template: "%s | OrbitCID" },
  description: "A secure control surface for self-hosted IPFS infrastructure.",
  openGraph: {
    type: "website",
    siteName: "OrbitCID",
    title: "OrbitCID | Self-hosted IPFS",
    description: "Own your node. Control your orbit.",
    url: "/",
    images: [{
      url: "/og/orbitcid-link-preview.png",
      width: 1200,
      height: 630,
      alt: "OrbitCID — Own your node. Control your orbit."
    }]
  },
  twitter: {
    card: "summary_large_image",
    title: "OrbitCID | Self-hosted IPFS",
    description: "Own your node. Control your orbit.",
    images: ["/og/orbitcid-link-preview.png"]
  },
  robots: { index: true, follow: true }
};
export const viewport: Viewport = { colorScheme: "light", themeColor: "#f3f0ee", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><a className="skip-link" href="#content">Skip to content</a><SiteHeader/><div id="content">{children}</div><footer className="site-footer"><span>© 2026 Md. Rakib • made with love and passion.</span><nav aria-label="Legal"><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link></nav></footer></body></html>;
}
