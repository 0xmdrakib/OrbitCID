import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  agentRules: false,
  experimental: { serverActions: { bodySizeLimit: "1mb" } },
  async headers() {
    const scripts = process.env.NODE_ENV === "development" ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self' 'unsafe-inline'";
    return [{
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
        { key: "Content-Security-Policy", value: `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; ${scripts}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://lh3.googleusercontent.com; connect-src 'self' https:; font-src 'self'; upgrade-insecure-requests` }
      ]
    }];
  }
};

export default config;
