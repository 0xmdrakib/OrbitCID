"use client";

import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { Icon } from "./icons";

export function PublicHome() {
  const { data: session } = authClient.useSession();
  const begin = () => session?.user ? window.location.assign("/console") : void authClient.signIn.social({ provider: "google", callbackURL: "/console" });
  return <main className="public-main">
    <section className="hero">
      <div className="hero-watermark" aria-hidden="true">OWN<br/>THE NODE</div>
      <div className="hero-copy">
        <p className="eyebrow">SELF-HOSTED IPFS PLATFORM</p>
        <h1>Your frontend.<br/><em>Your node.</em><br/>One secure orbit.</h1>
        <p>OrbitCID gives every signed-in user an isolated control space, then connects it to an IPFS backend they own—on a PC, VPS, or cloud server.</p>
        <div className="hero-actions"><button className="ink-button large" onClick={begin}>{session?.user ? "Open your console" : "Start with Google"}<Icon name="arrow"/></button><a className="text-link" href="https://github.com/0xmdrakib/OrbitCID" target="_blank" rel="noreferrer">View source</a></div>
      </div>
      <div className="orbit-stage" aria-hidden="true">
        <svg viewBox="0 0 620 520"><ellipse cx="310" cy="260" rx="245" ry="112" transform="rotate(-24 310 260)"/><ellipse cx="310" cy="260" rx="225" ry="98" transform="rotate(28 310 260)"/></svg>
        <div className="planet planet-user"><Icon name="shield"/><strong>Google</strong><small>verified identity</small></div>
        <div className="planet planet-data"><Icon name="database"/><strong>Private state</strong><small>tenant-isolated</small></div>
        <div className="planet planet-node"><Icon name="server"/><strong>Kubo</strong><small>your infrastructure</small></div>
        <div className="core"><Icon name="orbit" size={34}/><strong>OrbitCID</strong></div>
      </div>
    </section>

    <section className="stat-strip" aria-label="Platform principles"><div><span>01</span><strong>Publicly inspectable frontend</strong><small>Sign in only when you act.</small></div><div><span>02</span><strong>No shared backend credentials</strong><small>Five-minute scoped grants.</small></div><div><span>03</span><strong>True IPFS data plane</strong><small>Persistent Kubo + DHT + Bitswap.</small></div></section>

    <section className="section-heading" id="architecture"><p className="eyebrow">CLEAR RESPONSIBILITY</p><h2>Three layers.<br/>No blurred trust.</h2><p>The hosted application never becomes your storage server. An isolated control layer stores account state; content travels directly between your browser and the backend you paired.</p></section>
    <section className="architecture-grid">
      <article><span className="step">01</span><Icon name="shield" size={30}/><h3>Frontend identity</h3><p>Google OAuth sessions use secure, server-managed cookies. Your profile image and account controls live in the navigation.</p><ul><li>Public read-only experience</li><li>Login before every private action</li><li>Revocable database sessions</li></ul></article>
      <article className="dark"><span className="step">02</span><Icon name="database" size={30}/><h3>Isolated control state</h3><p>Each row is bound to the verified user ID. Enforced row-level policies add a database boundary below application authorization.</p><ul><li>Connections and preferences</li><li>Security activity trail</li><li>No IPFS file bytes</li></ul></article>
      <article><span className="step">03</span><Icon name="server" size={30}/><h3>Your IPFS backend</h3><p>Run Kubo anywhere with persistent storage. The browser receives a short-lived grant valid only for your connected backend.</p><ul><li>Direct streaming uploads</li><li>Private Kubo RPC</li><li>Optional encrypted backup</li></ul></article>
    </section>

    <section className="security-panel" id="security"><div><p className="eyebrow">FAIL-CLOSED CONNECTION</p><h2>A connection—not a copied API key.</h2><p>A one-time pairing code binds one Google user to one backend public key. Long-lived backend secrets never enter localStorage, source code, or the browser bundle.</p><Link className="light-button" href="/console">Open console <Icon name="arrow"/></Link></div><ol><li><span>1</span>Create a 10-minute claim after Google login.</li><li><span>2</span>Your backend proves possession of its Ed25519 key.</li><li><span>3</span>Vercel issues audience-bound, five-minute grants.</li><li><span>4</span>The backend verifies owner, scope, expiry and replay.</li></ol></section>
  </main>;
}
