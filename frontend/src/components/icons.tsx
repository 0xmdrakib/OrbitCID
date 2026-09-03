export function Icon({ name, size = 20 }: { name: "arrow" | "check" | "database" | "link" | "lock" | "menu" | "orbit" | "server" | "shield" | "x"; size?: number }) {
  const paths: Record<typeof name, React.ReactNode> = {
    arrow: <><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></>,
    link: <><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"/></>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16"/></>,
    orbit: <><circle cx="12" cy="12" r="3"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(35 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-35 12 12)"/></>,
    server: <><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/></>,
    shield: <><path d="M12 3 4.5 6v5.5c0 4.7 3.1 8 7.5 9.5 4.4-1.5 7.5-4.8 7.5-9.5V6L12 3Z"/><path d="m9 12 2 2 4-5"/></>,
    x: <path d="m6 6 12 12M18 6 6 18"/>
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
