import type { Metadata, Viewport } from "next";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";
import "./responsive.css";

export const metadata: Metadata = {
  title: { default: "OrbitCID — Self-hosted IPFS", template: "%s · OrbitCID" },
  description: "A secure Vercel control surface for IPFS infrastructure you own.",
  robots: { index: true, follow: true }
};
export const viewport: Viewport = { colorScheme: "light", themeColor: "#f3f0ee", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><a className="skip-link" href="#content">Skip to content</a><SiteHeader/><div id="content">{children}</div><footer className="site-footer"><span>© 2026 Md. Rakib</span><span>OrbitCID is open-source software.</span><span>made with love and passion.</span></footer></body></html>;
}
