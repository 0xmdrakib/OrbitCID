"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Icon } from "./icons";

function Avatar({ image, name }: { image?: string | null; name?: string | null }) {
  if (image) return <img className="avatar" src={image} alt="" referrerPolicy="no-referrer"/>;
  return <span className="avatar avatar-fallback" aria-hidden="true">{(name || "U").slice(0, 1).toUpperCase()}</span>;
}

export function SiteHeader() {
  const { data: session, isPending } = authClient.useSession();
  const [menu, setMenu] = useState(false);
  const navigationRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(false); };
    const outside = (event: PointerEvent) => { if (!navigationRef.current?.contains(event.target as Node)) setMenu(false); };
    document.addEventListener("keydown", close); document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("keydown", close); document.removeEventListener("pointerdown", outside); };
  }, [menu]);
  const signIn = () => void authClient.signIn.social({ provider: "google", callbackURL: "/console" });
  const signOut = () => void authClient.signOut({ fetchOptions: { onSuccess: () => { window.location.href = "/"; } } });
  return <header className="site-header">
    <nav ref={navigationRef} className="nav-pill" aria-label="Main navigation">
      <Link className="wordmark" href="/"><span className="mark"><Icon name="orbit" size={24}/></span><span><strong>OrbitCID</strong><small>IPFS, under your control</small></span></Link>
      <div className={`nav-links ${menu ? "open" : ""}`} id="mobile-navigation">
        <Link href="/#architecture" onClick={() => setMenu(false)}>Architecture</Link>
        <Link href="/#security" onClick={() => setMenu(false)}>Security</Link>
        <Link href="/console" onClick={() => setMenu(false)}>Console</Link>
      </div>
      <div className="account-actions">
        {!isPending && session?.user ? <>
          <Link className="account-chip" href="/console"><Avatar image={session.user.image} name={session.user.name}/><span><strong>{session.user.name || "Account"}</strong><small>{session.user.email}</small></span></Link>
          <button className="quiet-button" onClick={signOut}>Log out</button>
        </> : !isPending ? <button className="ink-button" onClick={signIn}>Continue with Google <Icon name="arrow" size={17}/></button> : <span className="session-skeleton"/>}
      </div>
      <button className="menu-button" aria-label="Toggle navigation" aria-controls="mobile-navigation" aria-expanded={menu} onClick={() => setMenu((value) => !value)}><Icon name={menu ? "x" : "menu"}/></button>
    </nav>
  </header>;
}
