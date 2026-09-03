import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Use",
  description: "Terms for using the OrbitCID open-source IPFS control plane."
};

export default function TermsPage() {
  return <main className="legal-main">
    <article className="legal-card">
      <p className="eyebrow">TERMS OF USE · EFFECTIVE 4 SEPTEMBER 2026</p>
      <h1>Operate your node responsibly.</h1>
      <p className="legal-lead">OrbitCID is an open-source control plane for IPFS infrastructure you own. By using the hosted frontend, you agree to the following terms.</p>

      <section><h2>Your infrastructure</h2><p>You are responsible for deploying, securing, monitoring, backing up, and paying for your Kubo node, server, network, domain, and optional object storage.</p></section>
      <section><h2>Your content</h2><p>You must have the right to store and publish your content. Do not use OrbitCID for unlawful material, malware, credential theft, harassment, infringement, or attempts to interfere with other users or systems.</p></section>
      <section><h2>Public IPFS warning</h2><p>Publishing to the IPFS network can make content globally retrievable and practically irreversible. Unpinning your copy does not remove copies held by other peers. Keep confidential data private or encrypt it before publication.</p></section>
      <section><h2>Accounts and access</h2><p>Keep your Google account and backend host secure. You may not attempt to access another user&apos;s workspace, replay expired grants, bypass rate limits, or expose private backend administration endpoints.</p></section>
      <section><h2>Availability</h2><p>The hosted frontend and open-source software are provided without an uptime or data-recovery guarantee. Maintain independent backups and test restoration before relying on the system for important data.</p></section>
      <section><h2>Open-source license</h2><p>The source code is available under the MIT License. These hosted-service terms do not remove the permissions or warranty disclaimer in that license.</p></section>
      <section><h2>Changes</h2><p>Continued use after an updated effective date constitutes acceptance of the revised terms.</p></section>

      <Link className="ink-button" href="/">Return home</Link>
    </article>
  </main>;
}
