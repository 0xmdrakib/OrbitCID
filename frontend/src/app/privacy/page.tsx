import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How OrbitCID handles identity, control-plane state, and self-hosted IPFS data."
};

export default function PrivacyPage() {
  return <main className="legal-main">
    <article className="legal-card">
      <p className="eyebrow">PRIVACY POLICY · EFFECTIVE 4 SEPTEMBER 2026</p>
      <h1>Your files stay on infrastructure you control.</h1>
      <p className="legal-lead">OrbitCID separates its hosted control plane from your self-hosted IPFS data plane. This policy explains what the hosted frontend processes when you choose to sign in.</p>

      <section><h2>Public browsing</h2><p>You can inspect the public website without creating an account. OrbitCID does not use advertising trackers or sell personal information.</p></section>
      <section><h2>Google sign-in</h2><p>When you continue with Google, OrbitCID receives your Google account identifier, name, email address, profile image, and verification status. These fields identify your private workspace and display your account in the console.</p></section>
      <section><h2>Control-plane data</h2><p>A managed control database stores your account, revocable session records, backend connection metadata, preferences, pairing state, and security activity. Tenant rows are protected by application authorization and enforced row-level isolation.</p></section>
      <section><h2>IPFS content and credentials</h2><p>IPFS file bytes stream between your browser and the backend you pair. They are not stored in the hosted frontend or control database. Long-lived backend and optional Cloudflare R2 credentials remain on your backend; the browser receives only short-lived, audience-bound grants.</p></section>
      <section><h2>Retention and deletion</h2><p>Pairing claims expire after ten minutes and sessions expire automatically. Account-scoped control data remains until it is no longer needed or the account owner requests removal through the project&apos;s GitHub repository. Public IPFS content may remain available from peers that copied it.</p></section>
      <section><h2>Processors and security</h2><p>OrbitCID uses managed providers for authentication, application hosting, and isolated control storage. Each provider processes data under its own terms. HTTPS, secure cookies, narrowly scoped grants, encrypted secret storage, and database isolation reduce risk, but no Internet service can promise absolute security.</p></section>
      <section><h2>Changes</h2><p>Material changes will be reflected on this page with a new effective date.</p></section>

      <Link className="ink-button" href="/">Return home</Link>
    </article>
  </main>;
}
