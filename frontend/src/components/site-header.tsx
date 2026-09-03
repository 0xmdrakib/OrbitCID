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
  const [accountMenu, setAccountMenu] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const accountButtonRef = useRef<HTMLButtonElement>(null);
  const accountPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!accountMenu) return;
    const firstItem = accountPanelRef.current?.querySelector<HTMLElement>("[role='menuitem']");
    firstItem?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setAccountMenu(false);
      accountButtonRef.current?.focus();
    };
    const outside = (event: PointerEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) setAccountMenu(false);
    };
    document.addEventListener("keydown", close); document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("keydown", close); document.removeEventListener("pointerdown", outside); };
  }, [accountMenu]);
  const signIn = () => void authClient.signIn.social({ provider: "google", callbackURL: "/console" });
  const signOut = () => { setAccountMenu(false); void authClient.signOut({ fetchOptions: { onSuccess: () => { window.location.href = "/"; } } }); };
  return <header className="site-header">
    <nav className="nav-pill" aria-label="Main navigation">
      <Link className="wordmark" href="/"><span className="mark"><Icon name="orbit" size={24}/></span><span><strong>OrbitCID</strong><small>IPFS, under your control</small></span></Link>
      <div className="nav-links">
        <Link href="/console">Console</Link>
      </div>
      <div className="account-actions">
        {!isPending && session?.user ? <div ref={accountMenuRef} className="account-menu-wrap" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAccountMenu(false); }}>
          <button ref={accountButtonRef} className="account-chip account-trigger" type="button" aria-haspopup="menu" aria-expanded={accountMenu} aria-controls="account-menu" onClick={() => setAccountMenu((value) => !value)}>
            <Avatar image={session.user.image} name={session.user.name}/><span><strong>{session.user.name || "Account"}</strong><small>{session.user.email}</small></span><Icon name="chevron" size={15}/>
          </button>
          {accountMenu && <div ref={accountPanelRef} className="account-popover" id="account-menu" role="menu">
            <div className="account-popover-identity"><small>Signed in with Google</small><strong>{session.user.name || "Account"}</strong><span>{session.user.email}</span></div>
            <Link href="/console" role="menuitem" onClick={() => setAccountMenu(false)}>Open console</Link>
            <button type="button" role="menuitem" onClick={signOut}>Log out</button>
          </div>}
        </div> : !isPending ? <button className="ink-button header-sign-in" onClick={signIn}><span className="sign-in-long">Continue with Google</span><span className="sign-in-short">Sign in</span><Icon name="arrow" size={17}/></button> : <span className="session-skeleton"/>}
      </div>
    </nav>
  </header>;
}
