import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { argon2id } from "hash-wasm";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import * as raw from "multiformats/codecs/raw";
import type { CID } from "multiformats/cid";
import "./styles.css";

const CHUNK_SIZE = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Tab = "overview" | "upload" | "pins" | "files" | "names" | "imports" | "integration" | "audit" | "settings";

const NAVIGATION: Array<{ id: Tab; label: string; shortLabel?: string }> = [
  { id: "overview", label: "Overview" },
  { id: "upload", label: "Upload" },
  { id: "files", label: "Files" },
  { id: "pins", label: "Pins" },
  { id: "integration", label: "API & Integration", shortLabel: "API" },
  { id: "names", label: "Stable Links" },
  { id: "imports", label: "Import / Migration" },
  { id: "audit", label: "Activity" },
  { id: "settings", label: "Settings" }
];
const PRIMARY_TABS: Tab[] = ["overview", "upload", "files", "pins", "integration"];
const MORE_TABS: Tab[] = ["names", "imports", "audit", "settings"];

interface ApiError { error?: { code?: string; message?: string } }
interface PinResult { requestid: string; status: string; created: string; pin: { cid: string; name?: string; meta?: Record<string, unknown> }; info?: { error?: string; mode?: "standard" | "sealed"; size?: number } }
interface HealthService { status: "operational" | "degraded"; latencyMs: number; detail: string }
interface HealthSnapshot { status: "operational" | "degraded"; latencyMs: number; checkedAt: string; services: Record<string, HealthService> }
interface SessionInfo { authenticated: boolean; actor: string; method: "access" }
interface Project { id: string; name: string; slug: string; description?: string; default_visibility: "private" | "public"; gateway_enabled: number; state: "active" | "deleted"; file_count?: number; logical_bytes?: number; public_count?: number; quota_bytes?: number }
interface RuntimeConfig { gatewayHost: string; appOrigin: string }
interface NavigationPreferences { visible: Tab[]; overflow: Tab[]; version?: number }

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function privateFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof Blob) && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(path, { ...init, headers, credentials: "include" });
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await privateFetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ApiError;
    const error = new Error(body.error?.message ?? `Request failed with ${response.status}`) as Error & { code?: string; status?: number };
    error.code = body.error?.code;
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function* blobChunks(blob: Blob): AsyncGenerator<Uint8Array> {
  const reader = blob.stream().getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function deriveVaultKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const rawKey = await argon2id({ password: passphrase, salt, parallelism: 1, iterations: 3, memorySize: 64 * 1024, hashLength: 32, outputType: "binary" });
  const copy = new Uint8Array(rawKey.length); copy.set(rawKey);
  return crypto.subtle.importKey("raw", copy, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function sealFile(file: File, passphrase: string, progress: (value: number) => void): Promise<Blob> {
  if (passphrase.length < 12) throw new Error("Vault passphrase must contain at least 12 characters");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveVaultKey(passphrase, salt);
  const metaNonce = crypto.getRandomValues(new Uint8Array(12));
  const encryptedMetadata = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: metaNonce }, key,
    encoder.encode(JSON.stringify({ name: file.name, type: file.type, size: file.size, lastModified: file.lastModified }))
  ));
  const header = encoder.encode(`${JSON.stringify({ version: 1, algorithm: "AES-256-GCM", kdf: "Argon2id", salt: bytesToBase64(salt), metaNonce: bytesToBase64(metaNonce), metadata: bytesToBase64(encryptedMetadata), chunkSize: CHUNK_SIZE })}\n`);
  const output: BlobPart[] = [encoder.encode("RIPFS1\n"), header];
  let offset = 0;
  while (offset < file.size) {
    const chunk = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + CHUNK_SIZE)).arrayBuffer());
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, chunk));
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, ciphertext.length, false);
    output.push(nonce, length, ciphertext);
    offset += chunk.length;
    progress(offset / file.size * 25);
  }
  return new Blob(output, { type: "application/vnd.orbitcid.sealed" });
}

async function unsealFile(blob: Blob, passphrase: string, progress: (value: number) => void): Promise<{ blob: Blob; name: string }> {
  if (passphrase.length < 12) throw new Error("Vault passphrase must contain at least 12 characters");
  const probe = new Uint8Array(await blob.slice(0, Math.min(blob.size, 64 * 1024)).arrayBuffer());
  const firstNewline = probe.indexOf(10);
  const secondNewline = probe.indexOf(10, firstNewline + 1);
  if (firstNewline < 0 || secondNewline < 0 || decoder.decode(probe.subarray(0, firstNewline)) !== "RIPFS1") throw new Error("File is not an OrbitCID sealed-vault object");
  const header = JSON.parse(decoder.decode(probe.subarray(firstNewline + 1, secondNewline))) as { salt: string; metaNonce: string; metadata: string; chunkSize: number };
  const key = await deriveVaultKey(passphrase, base64ToBytes(header.salt));
  let metadata: { name: string; type: string; size: number };
  try {
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(header.metaNonce) }, key, base64ToBytes(header.metadata));
    metadata = JSON.parse(decoder.decode(decrypted)) as { name: string; type: string; size: number };
  } catch { throw new Error("Vault passphrase is incorrect or metadata is corrupt"); }
  const output: BlobPart[] = [];
  let offset = secondNewline + 1;
  let plainBytes = 0;
  while (offset < blob.size) {
    if (offset + 16 > blob.size) throw new Error("Sealed chunk header is truncated");
    const nonce = new Uint8Array(await blob.slice(offset, offset + 12).arrayBuffer()); offset += 12;
    const lengthBytes = await blob.slice(offset, offset + 4).arrayBuffer(); offset += 4;
    const length = new DataView(lengthBytes).getUint32(0, false);
    if (length < 16 || length > (header.chunkSize || CHUNK_SIZE) + 16 || offset + length > blob.size) throw new Error("Sealed chunk length is invalid");
    const ciphertext = await blob.slice(offset, offset + length).arrayBuffer(); offset += length;
    try {
      const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
      output.push(plaintext); plainBytes += plaintext.length;
    } catch { throw new Error("Vault passphrase is incorrect or content authentication failed"); }
    progress(blob.size ? offset / blob.size * 100 : 100);
  }
  if (plainBytes !== metadata.size) throw new Error("Decrypted size does not match the sealed manifest");
  return { blob: new Blob(output, { type: metadata.type || "application/octet-stream" }), name: metadata.name || "unsealed-download" };
}

async function prepareDag(blob: Blob, path: string, progress: (value: number) => void): Promise<{ rootCid: string; dagBlocks: Array<{ cid: string; bytes: string }> }> {
  const dagBlocks: Array<{ cid: string; bytes: string }> = [];
  const blockstore = {
    async put(cid: CID, bytes: Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<CID> {
      if (!(bytes instanceof Uint8Array)) throw new Error("Unexpected streaming block");
      if (cid.code !== raw.code) dagBlocks.push({ cid: cid.toString(), bytes: bytesToBase64(bytes) });
      return cid;
    }
  };
  let rootCid = "";
  for await (const entry of importer([{ path, content: blobChunks(blob) }], blockstore, {
    cidVersion: 1,
    rawLeaves: true,
    chunker: fixedSize({ chunkSize: CHUNK_SIZE }),
    onProgress: (event) => {
      const detail = event.detail as { bytesRead?: bigint };
      if (detail.bytesRead && blob.size) progress(25 + Number(detail.bytesRead) / blob.size * 15);
    }
  })) rootCid = entry.cid.toString();
  if (!rootCid) throw new Error("Could not create UnixFS DAG");
  return { rootCid, dagBlocks };
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value; let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    overview: <><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></>,
    upload: <><path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 14v5h14v-5"/></>,
    pins: <><path d="M8 4h8l-1 5 3 3v2H6v-2l3-3-1-5Z"/><path d="M12 14v7"/></>,
    files: <><path d="M3 7h7l2 2h9v10H3V7Z"/><path d="M3 7V5h7l2 2"/></>,
    names: <><path d="M4 7h10l6 5-6 5H4V7Z"/><circle cx="8" cy="12" r="1.5"/></>,
    imports: <><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 19h14"/></>,
    integration: <><circle cx="8" cy="12" r="4"/><path d="M12 12h9M17 12v3M20 12v2"/></>,
    tokens: <><circle cx="8" cy="12" r="4"/><path d="M12 12h9M17 12v3M20 12v2"/></>,
    audit: <><path d="M7 5h13M7 12h13M7 19h13"/><circle cx="3" cy="5" r="1"/><circle cx="3" cy="12" r="1"/><circle cx="3" cy="19" r="1"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></>,
    more: <><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16"/></>,
    close: <><path d="M5 5l14 14M19 5 5 19"/></>,
    refresh: <><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 1-2-5"/></>,
    arrow: <><path d="M5 12h14M14 7l5 5-5 5"/></>,
    lock: <><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
    shield: <><path d="M12 3 5 6v5c0 4.5 2.8 8 7 10 4.2-2 7-5.5 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-5"/></>,
    external: <><path d="M14 5h5v5M19 5l-8 8"/><path d="M17 13v6H5V7h6"/></>
  };
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.overview}</svg>;
}

function PasswordGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await apiFetch("/api/v1/session/login", { method: "POST", body: JSON.stringify({ password }) }); onAuthenticated(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Login failed"); }
    finally { setBusy(false); }
  };
  return <div className="gate"><div className="gate-watermark" aria-hidden="true">PRIVATE EDGE</div><div className="gate-orbit" aria-hidden="true"><span/><span/><span/></div><form className="gate-card" onSubmit={submit}>
    <div className="gate-brand"><div className="brand-mark large"><Icon name="shield" size={28}/></div><div><strong>OrbitCID</strong><small>Owner console</small></div></div>
    <p className="eyebrow">SECURE CONTENT NETWORK</p><h1>Welcome back.</h1>
    <p className="gate-copy">Your Google identity is verified. Enter the independent admin password to unlock the private edge console.</p>
    <div className="identity-proof"><span><Icon name="shield" size={17}/></span><div><strong>Google identity verified</strong><small>Layer one of two is complete</small></div></div>
    <label>Admin password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus minLength={12} required autoComplete="current-password" /></label>
    {error && <div className="alert error" role="alert">{error}</div>}<button className="primary wide" disabled={busy}>{busy ? "Verifying…" : <span>Unlock console <Icon name="arrow" size={18}/></span>}</button>
  </form></div>;
}

function AccessRequired(){return <div className="gate"><div className="gate-watermark" aria-hidden="true">ACCESS REQUIRED</div><div className="gate-orbit" aria-hidden="true"><span/><span/><span/></div><section className="gate-card"><div className="gate-brand"><div className="brand-mark large"><Icon name="shield" size={28}/></div><div><strong>OrbitCID</strong><small>Owner console</small></div></div><p className="eyebrow">FAIL-CLOSED SECURITY</p><h1>Google sign-in required.</h1><p className="gate-copy">This request did not contain a verified Cloudflare Access identity. Open the configured admin hostname and sign in with an allowed account. OrbitCID has no local or development login bypass.</p></section></div>}

function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [accessVerified,setAccessVerified]=useState<boolean|null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>("all");
  const [runtime, setRuntime] = useState<RuntimeConfig>({ gatewayHost: "gateway.example.com", appOrigin: location.origin });
  const [visibleTabs,setVisibleTabs]=useState<Tab[]>(PRIMARY_TABS);const[overflowTabs,setOverflowTabs]=useState<Tab[]>(MORE_TABS);const[draggedTab,setDraggedTab]=useState<Tab|null>(null);
  const [pins, setPins] = useState<PinResult[]>([]);
  const [audit, setAudit] = useState<Record<string, unknown>[]>([]);
  const [names, setNames] = useState<Record<string, unknown>[]>([]);
  const [files, setFiles] = useState<Record<string, unknown>[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [jobs, setJobs] = useState<Record<string, unknown>[]>([]);
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileMenuWasOpen = useRef(false);
  const activeProject = useMemo(() => projects.find((project) => project.id === activeProjectId) ?? null, [projects, activeProjectId]);
  const apiBase = activeProject ? `/api/v1/projects/${encodeURIComponent(activeProject.id)}` : "";

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [projectData, healthData, configData] = await Promise.all([
        apiFetch<{ results: Project[] }>("/api/v1/projects"),
        apiFetch<HealthSnapshot>("/api/v1/health"),
        apiFetch<RuntimeConfig>("/api/v1/config")
      ]);
      setProjects(projectData.results); setHealth(healthData); setRuntime(configData);
      if (activeProjectId === "all") {
        const active = projectData.results.filter((project) => project.state === "active");
        setPins([]); setAudit([]); setNames([]); setFiles([]); setJobs([]);
        setStats({
          storedBytes: active.reduce((sum, project) => sum + Number(project.logical_bytes ?? 0), 0),
          pins: active.reduce((sum, project) => sum + Number(project.file_count ?? 0), 0),
          projects: active.length,
          publicPins: active.reduce((sum, project) => sum + Number(project.public_count ?? 0), 0),
          storageQuotaBytes: active.reduce((sum, project) => sum + Number(project.quota_bytes ?? 0), 0)
        });
        return;
      }
      const selected = projectData.results.find((project) => project.id === activeProjectId);
      if (!selected) { setActiveProjectId("all"); return; }
      const base = `/api/v1/projects/${encodeURIComponent(selected.id)}`;
      const [pinData, auditData, nameData, fileData, usageData, jobData] = await Promise.all([
        apiFetch<{ results: PinResult[] }>(`${base}/pins`), apiFetch<{ results: Record<string, unknown>[] }>(`${base}/audit?limit=50`),
        apiFetch<{ results: Record<string, unknown>[] }>(`${base}/stable-links`), apiFetch<{ entries: Record<string, unknown>[] }>(`${base}/files?path=/`),
        apiFetch<Record<string, unknown>>(`${base}/usage`), apiFetch<{ results: Record<string, unknown>[] }>(`${base}/jobs`)
      ]);
      const projectInfo = usageData.project as Record<string, unknown> | undefined;
      setPins(pinData.results); setAudit(auditData.results); setNames(nameData.results); setFiles(fileData.entries); setJobs(jobData.results);
      setStats({
        storedBytes: Number(usageData.storedBytes ?? 0), pins: Number(usageData.files ?? 0), blocks: Number(usageData.uniqueBlocks ?? 0),
        activeJobs: Number(usageData.activeJobs ?? 0), failedJobs: Number(usageData.failedJobs ?? 0),
        requests30d: Number(usageData.requests30d ?? 0), bytesServed30d: Number(usageData.bytesServed30d ?? 0),
        storageQuotaBytes: Number(projectInfo?.quota_bytes ?? selected.quota_bytes ?? 0)
      });
    } finally { setLoading(false); }
  }, [activeProjectId]);

  const establishSession = useCallback(async () => {
    const [current, projectData, configData, navigationData] = await Promise.all([
      apiFetch<SessionInfo>("/api/v1/session/me"),
      apiFetch<{ results: Project[] }>("/api/v1/projects"),
      apiFetch<RuntimeConfig>("/api/v1/config"),
      apiFetch<NavigationPreferences>("/api/v1/navigation")
    ]);
    setSession(current); setProjects(projectData.results); setRuntime(configData); setVisibleTabs(navigationData.visible); setOverflowTabs(navigationData.overflow); setAccessVerified(true); setAuthenticated(true);
    const preferred = localStorage.getItem("orbitcid_active_project");
    setActiveProjectId(preferred && (preferred === "all" || projectData.results.some((project) => project.id === preferred)) ? preferred : (projectData.results[0]?.id ?? "all"));
  }, []);
  useEffect(() => { void establishSession().catch(async()=>{setSession(null);const response=await privateFetch("/api/v1/session/access").catch(()=>null);setAccessVerified(response?.ok??false);setAuthenticated(false)}); }, [establishSession]);
  useEffect(() => { if (authenticated) void refresh().catch((error) => setNotice(error instanceof Error ? error.message : "Dashboard refresh failed")); }, [authenticated, refresh]);
  useEffect(() => {
    const closeMore = (event: PointerEvent) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) setMoreOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMoreOpen(false); setMobileMenuOpen(false); }
    };
    document.addEventListener("pointerdown", closeMore);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", closeMore); document.removeEventListener("keydown", closeOnEscape); };
  }, []);
  useEffect(() => {
    document.body.classList.toggle("menu-open", mobileMenuOpen);
    if (mobileMenuOpen) {
      mobileMenuWasOpen.current = true;
      window.setTimeout(() => mobileMenuRef.current?.querySelector<HTMLButtonElement>("button[data-nav]")?.focus(), 0);
      const containFocus = (event: KeyboardEvent) => {
        if (event.key !== "Tab" || !mobileMenuRef.current) return;
        const focusable = Array.from(mobileMenuRef.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        if (!focusable.length) return;
        const first = focusable[0]; const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      };
      document.addEventListener("keydown", containFocus);
      return () => { document.body.classList.remove("menu-open"); document.removeEventListener("keydown", containFocus); };
    }
    if (mobileMenuWasOpen.current) { mobileMenuWasOpen.current = false; mobileTriggerRef.current?.focus(); }
    return () => document.body.classList.remove("menu-open");
  }, [mobileMenuOpen]);
  if (authenticated === null) return <div className="boot"><div className="spinner" />Connecting to private edge…</div>;
  if (!authenticated&&accessVerified===false)return <AccessRequired/>;
  if (!authenticated) return <PasswordGate onAuthenticated={() => void establishSession()} />;

  const activeItem = NAVIGATION.find((item) => item.id === tab)!;
  const selectTab = (nextTab: Tab) => { setTab(nextTab); setMoreOpen(false); setMobileMenuOpen(false); window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); };
  const selectProject = (id: string) => { localStorage.setItem("orbitcid_active_project", id); setActiveProjectId(id); if (id === "all" && tab !== "overview") selectTab("overview"); };
  const saveNavigation=async(visible:Tab[],overflow:Tab[])=>{if(!visible.length)return;const previousVisible=visibleTabs;const previousOverflow=overflowTabs;setVisibleTabs(visible);setOverflowTabs(overflow);try{await apiFetch("/api/v1/navigation",{method:"PUT",body:JSON.stringify({visible,overflow})})}catch(error){setVisibleTabs(previousVisible);setOverflowTabs(previousOverflow);setNotice(error instanceof Error?error.message:"Navigation sync failed")}};
  const moveNavigation=(moving:Tab,target:Tab|null,group:"visible"|"overflow")=>{let visible=visibleTabs.filter((id)=>id!==moving);let overflow=overflowTabs.filter((id)=>id!==moving);if(group==="visible"){const index=target?visible.indexOf(target):-1;visible.splice(index<0?visible.length:index,0,moving)}else{if(!visible.length)return;const index=target?overflow.indexOf(target):-1;overflow.splice(index<0?overflow.length:index,0,moving)}setDraggedTab(null);void saveNavigation(visible,overflow);};
  const authLabel = "Google + password";

  return <div className="shell">
    <a className="skip-link" href="#main-content">Skip to dashboard content</a>
    <div className="nav-dock"><nav className="top-nav" aria-label="Dashboard navigation">
      <button className="brand" onClick={() => selectTab("overview")} aria-label="OrbitCID overview"><span className="brand-mark"><Icon name="shield" size={21}/></span><span><strong>OrbitCID</strong><small>Private edge</small></span></button>
      <label className="project-switcher"><span className="sr-only">Active project</span><select value={activeProjectId} onChange={(event) => selectProject(event.target.value)}><option value="all">All projects</option>{projects.filter((project) => project.state === "active").map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
      <div className="primary-nav" onDragOver={(event)=>event.preventDefault()} onDrop={()=>draggedTab&&moveNavigation(draggedTab,null,"visible")}>{visibleTabs.map((id) => { const item = NAVIGATION.find((entry) => entry.id === id)!; return <button draggable onDragStart={()=>setDraggedTab(id)} onDragOver={(event)=>event.preventDefault()} onDrop={(event)=>{event.stopPropagation();if(draggedTab)moveNavigation(draggedTab,id,"visible")}} className={tab === id ? "active" : ""} aria-current={tab === id ? "page" : undefined} onClick={() => selectTab(id)} key={id}><Icon name={id} size={18}/><span>{item.shortLabel ?? item.label}</span></button>; })}</div>
      <div className="more-nav" ref={moreRef}><button onDragOver={(event)=>event.preventDefault()} onDrop={()=>draggedTab&&moveNavigation(draggedTab,null,"overflow")} className={overflowTabs.includes(tab) ? "active" : ""} aria-expanded={moreOpen} aria-haspopup="menu" onClick={() => setMoreOpen((open) => !open)}><Icon name="more" size={19}/><span>More</span></button>
        {moreOpen && <div className="more-menu" role="menu">{overflowTabs.map((id) => { const item = NAVIGATION.find((entry) => entry.id === id)!; return <button draggable onDragStart={()=>setDraggedTab(id)} onDragOver={(event)=>event.preventDefault()} onDrop={(event)=>{event.stopPropagation();if(draggedTab)moveNavigation(draggedTab,id,"overflow")}} role="menuitem" className={tab === id ? "active" : ""} onClick={() => selectTab(id)} key={id}><span className="menu-icon"><Icon name={id} size={19}/></span><span><strong>{item.label}</strong><small>{id === "imports" ? "Trustless gateway ingest" : id === "names" ? "Signed mutable names" : id === "audit" ? "Immutable activity trail" : "Security and projects"}</small></span></button>; })}</div>}
      </div>
      <button ref={mobileTriggerRef} className="mobile-menu-trigger" aria-expanded={mobileMenuOpen} aria-controls="mobile-menu" onClick={() => setMobileMenuOpen(true)}><Icon name="menu" size={21}/><span className="sr-only">Open navigation</span></button>
    </nav></div>
    {mobileMenuOpen && <div className="mobile-menu-layer" onPointerDown={(event) => { if (event.target === event.currentTarget) setMobileMenuOpen(false); }}><div ref={mobileMenuRef} className="mobile-menu" id="mobile-menu" role="dialog" aria-modal="true" aria-label="Dashboard navigation"><div className="mobile-menu-head"><div><p className="eyebrow">OWNER CONSOLE</p><h2>Navigate</h2></div><button onClick={() => setMobileMenuOpen(false)} aria-label="Close navigation"><Icon name="close"/></button></div><div className="mobile-menu-list">{[...visibleTabs,...overflowTabs].map((id) => {const item=NAVIGATION.find((entry)=>entry.id===id)!;return <button data-nav className={tab === item.id ? "active" : ""} onClick={() => selectTab(item.id)} key={item.id}><span className="menu-icon"><Icon name={item.id}/></span><span>{item.label}{overflowTabs.includes(id)&&<small>More</small>}</span><Icon name="arrow" size={18}/></button>})}</div><div className="mobile-security"><span className="pulse"/><div><strong>{authLabel}</strong><small>{session?.actor ?? "Owner-only access"}</small></div></div></div></div>}
    <main id="main-content"><header className="page-header"><div><p className="eyebrow">{activeProject ? activeProject.slug.toUpperCase() : "ALL PROJECTS"}</p><h1>{activeItem.label}</h1><p className="page-intro">{tab === "overview" ? "Your owner-only command center for verified content and edge operations." : `Manage ${activeItem.label.toLowerCase()} for ${activeProject?.name ?? "your projects"}.`}</p></div>
      <div className="header-actions"><span className={`status ${health?.status === "degraded" ? "degraded" : ""}`}><i />{health?.status === "degraded" ? "Service degradation" : `Edge healthy${health ? ` · ${health.latencyMs} ms` : ""}`}</span><button className="ghost icon-label" onClick={() => void refresh()} disabled={loading}><Icon name="refresh" size={18}/>{loading ? "Refreshing…" : "Refresh"}</button></div></header>
      {notice && <div className="alert success" role="status"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss notification"><Icon name="close" size={16}/></button></div>}
      {tab === "overview" && (activeProject ? <Overview stats={stats} pins={pins} jobs={jobs} health={health} session={session} onUpload={() => selectTab("upload")} /> : <AllProjectsOverview projects={projects} stats={stats} onSelect={selectProject} />)}
      {tab === "upload" && activeProject && <UploadPanel apiBase={apiBase} onComplete={(message) => { setNotice(message); void refresh(); }} />}
      {tab === "pins" && activeProject && <PinsPanel apiBase={apiBase} gatewayHost={runtime.gatewayHost} project={activeProject} pins={pins} onChanged={refresh} />}
      {tab === "files" && activeProject && <FilesPanel apiBase={apiBase} files={files} onChanged={refresh} />}
      {tab === "names" && activeProject && <NamesPanel apiBase={apiBase} names={names} onChanged={refresh} />}
      {tab === "imports" && activeProject && <ImportPanel apiBase={apiBase} onQueued={(message) => { setNotice(message); void refresh(); }} />}
      {tab === "integration" && activeProject && <IntegrationPanel project={activeProject} gatewayHost={runtime.gatewayHost} appOrigin={runtime.appOrigin} />}
      {tab === "audit" && <AuditPanel rows={audit} />}
      {tab === "settings" && <SettingsPanel session={session} projects={projects} navigation={{visible:visibleTabs,overflow:overflowTabs}} onNavigationChange={saveNavigation} onProjectsChanged={refresh} onSelectProject={selectProject} onLogout={() => { setSession(null); setAuthenticated(false); }} />}
      <footer className="console-footer"><div><p className="eyebrow">ORBITCID EDGE</p><h2>Content-addressed.<br/>Owner controlled.</h2></div><div className="footer-links"><button onClick={() => selectTab("audit")}>Activity</button><button onClick={() => selectTab("integration")}>API access</button><button onClick={() => selectTab("settings")}>Security settings</button></div><div className="footer-status"><span className="pulse"/><span><strong>{health?.status === "degraded" ? "Review service health" : "Private edge operational"}</strong><small>{authLabel} · {session?.actor ?? "Owner"}</small></span></div><p className="footer-signature">© 2026 Md. Rakib • made with love and passion.</p></footer>
    </main>
  </div>;
}

function AllProjectsOverview({ projects, stats, onSelect }: { projects: Project[]; stats: Record<string, number>; onSelect: (id: string) => void }) {
  const active = projects.filter((project) => project.state === "active");
  return <><section className="overview-hero all-projects-hero"><div className="ghost-headline" aria-hidden="true">ONE EDGE<br/>MANY PROJECTS</div><div className="hero-copy"><p className="eyebrow">PROJECT CONTROL PLANE</p><h2>Every workload.<br/><em>Clearly isolated.</em></h2><p>Separate API keys, quotas, visibility and gateway paths while physical blocks remain globally deduplicated.</p><button className="primary" onClick={() => onSelect(active[0]?.id ?? "all")} disabled={!active.length}>Open a project <Icon name="arrow" size={18}/></button></div></section><section className="metrics"><Metric label="Active projects" value={String(stats.projects ?? active.length)} detail="Independent namespaces"/><Metric label="Logical storage" value={formatBytes(stats.storedBytes ?? 0)} detail={`${stats.pins ?? 0} pinned roots`}/><Metric label="Public roots" value={String(stats.publicPins ?? 0)} detail="Explicitly published"/><Metric label="Default posture" value="Private" detail="Public access is opt-in" accent/></section><section className="panel"><div className="panel-title"><div><p className="eyebrow">PROJECT DIRECTORY</p><h3>Projects</h3></div><span>{active.length} active</span></div><div className="project-grid">{active.map((project) => <button className="project-card" onClick={() => onSelect(project.id)} key={project.id}><span className={`tag ${project.gateway_enabled ? "amber" : "green"}`}>{project.gateway_enabled ? "Gateway enabled" : "Private"}</span><strong>{project.name}</strong><code>{project.slug}</code><small>{project.file_count ?? 0} files · {formatBytes(Number(project.logical_bytes ?? 0))}</small><Icon name="arrow" size={18}/></button>)}</div></section></>;
}

function Overview({ stats, pins, jobs, health, session, onUpload }: { stats: Record<string, number>; pins: PinResult[]; jobs: Record<string, unknown>[]; health: HealthSnapshot | null; session: SessionInfo | null; onUpload: () => void }) {
  const usedPercent = stats.storageQuotaBytes ? Math.min(100, (stats.storedBytes ?? 0) / stats.storageQuotaBytes * 100) : 0;
  const usedLabel = usedPercent > 0 && usedPercent < 0.1 ? "<0.1" : usedPercent.toFixed(1);
  return <><section className="overview-hero"><div className="ghost-headline" aria-hidden="true">PRIVATE<br/>BY DEFAULT</div><div className="hero-copy"><p className="eyebrow">VERIFIED CONTENT EDGE</p><h2>Your content.<br/><em>Content-addressed.</em><br/>Published on your terms.</h2><p>UnixFS, CIDv1, CAR archives and stable links backed by private R2 storage, with optional public Kubo replication.</p><button className="primary" onClick={onUpload}><span>Upload new content</span><Icon name="arrow" size={18}/></button></div><div className="orbit-visual" aria-hidden="true"><svg viewBox="0 0 520 360" preserveAspectRatio="none"><path d="M32 274c82-196 274-246 458-126"/><path d="M86 332c104-118 244-137 399-52"/></svg><div className="orbit-node node-cid"><span className="node-kicker">ROOT CID</span><strong>v1</strong><small>SHA-256 verified</small><span className="satellite"><Icon name="arrow" size={17}/></span></div><div className="orbit-node node-storage"><span className="node-kicker">STORAGE</span><strong>{formatBytes(stats.storedBytes ?? 0)}</strong><small>{usedLabel}% of quota</small><span className="satellite"><Icon name="files" size={17}/></span></div><div className="orbit-node node-lock"><Icon name="lock" size={21}/><small>Private default</small></div></div></section><section className="metrics">
    <Metric label="Stored content" value={formatBytes(stats.storedBytes ?? 0)} detail={`${usedLabel}% of ${formatBytes(stats.storageQuotaBytes ?? 0)}`} />
    <Metric label="Pinned roots" value={String(stats.pins ?? pins.length)} detail={`${stats.blocks ?? 0} verified blocks`} />
    <Metric label="24-hour uploads" value={formatBytes(stats.uploadedBytes24h ?? 0)} detail={`${stats.uploads24h ?? 0} upload sessions`} />
    <Metric label="Security" value="2 layers" detail="Google identity + password" accent />
  </section><section className="grid two overview-support"><div className="panel"><div className="panel-title"><div><p className="eyebrow">EDGE OBSERVABILITY</p><h3>System health</h3></div><span className={`tag ${health?.status === "operational" ? "green" : "amber"}`}>{health?.status ?? "Checking"}</span></div>
      <HealthRow label="Worker API" service={health?.services.worker}/><HealthRow label="D1 metadata" service={health?.services.d1}/><HealthRow label="R2 objects" service={health?.services.objects}/><HealthRow label="R2 blocks" service={health?.services.blocks}/><HealthRow label="KV cache" service={health?.services.cache}/>
    </div><div className="panel provider-note"><p className="eyebrow">OPERATING MODEL</p><h3>Private by default.</h3><p>R2 remains authoritative while project policies decide whether a verified root may enter the public gateway and Kubo network.</p><div className="provider-note-row"><span className="tag green"><Icon name="shield" size={13}/> Verified</span><span>R2 authoritative · optional Kubo publishing</span></div></div></section>
  <section className="grid two"><div className="panel"><div className="panel-title"><h3>Recent pins</h3><span>{pins.length} total</span></div><PinTable pins={pins.slice(0, 6)} compact /></div>
    <div className="panel"><div className="panel-title"><h3>Job queue</h3><span>{stats.activeJobs ?? 0} active · {stats.failedJobs ?? 0} failed</span></div><JobList jobs={jobs.slice(0, 6)} /></div></section></>;
}

function Metric({ label, value, detail, accent }: { label: string; value: string; detail: string; accent?: boolean }) { return <div className={`metric ${accent ? "accent" : ""}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>; }
function HealthRow({ label, service }: { label: string; service?: HealthService }) { return <div className={`health-row ${service?.status === "degraded" ? "degraded" : ""}`} title={service?.detail}><span>{label}</span><strong><i />{service ? `${service.latencyMs} ms` : "Checking"}</strong></div>; }
function JobList({ jobs }: { jobs: Record<string, unknown>[] }) { return <div className="job-list">{jobs.length ? jobs.map((job) => <div className="job-row" key={String(job.id)}><span className={`job-state ${String(job.status)}`} /><div><strong>{String(job.type).replaceAll("_", " ")}</strong><small>{new Date(String(job.updated_at)).toLocaleString()}</small></div><em className={`tag ${job.status === "completed" ? "green" : job.status === "failed" ? "danger-tag" : "amber"}`}>{String(job.status)}</em></div>) : <Empty text="No background jobs yet" />}</div>; }

function UploadPanel({ apiBase, onComplete }: { apiBase: string; onComplete: (message: string) => void }) {
  const [file, setFile] = useState<File | null>(null); const [mode, setMode] = useState<"standard"|"sealed">("standard");
  const [passphrase, setPassphrase] = useState(""); const [progress, setProgress] = useState(0); const [status, setStatus] = useState(""); const [busy, setBusy] = useState(false);
  const upload = async () => {
    if (!file) return; setBusy(true); setProgress(0);
    try {
      setStatus(mode === "sealed" ? "Encrypting locally with Argon2id + AES-GCM…" : "Building UnixFS DAG…");
      const payload = mode === "sealed" ? await sealFile(file, passphrase, setProgress) : file;
      const storedName = mode === "sealed" ? `sealed-${crypto.randomUUID()}.ripfs` : file.name;
      const dag = await prepareDag(payload, storedName, setProgress);
      const init = await apiFetch<{ id: string; partSize: number; partCount: number }>(`${apiBase}/uploads`, { method: "POST", body: JSON.stringify({ name: storedName, size: payload.size, mime: payload.type || "application/octet-stream", mode, metadata: { originalName: mode === "standard" ? file.name : undefined } }) });
      setStatus(`Uploading ${init.partCount} verified parts…`);
      let next = 1; let completed = 0;
      const worker = async () => { while (true) { const part = next++; if (part > init.partCount) return; const start = (part - 1) * init.partSize; const body = payload.slice(start, Math.min(payload.size, start + init.partSize)); await apiFetch(`${apiBase}/uploads/${init.id}/parts/${part}`, { method: "POST", body }); completed += 1; setProgress(40 + completed / init.partCount * 45); } };
      await Promise.all(Array.from({ length: Math.min(8, init.partCount) }, () => worker()));
      setStatus("Uploading DAG metadata…");
      for (let index = 0; index < dag.dagBlocks.length; index += 200) await apiFetch(`${apiBase}/uploads/${init.id}/dag`, { method: "POST", body: JSON.stringify({ blocks: dag.dagBlocks.slice(index, index + 200) }) });
      const result = await apiFetch<{ rootCid: string }>(`${apiBase}/uploads/${init.id}/complete`, { method: "POST", body: JSON.stringify({ rootCid: dag.rootCid, pin: true }) });
      setProgress(100); setStatus(`Verifying ${result.rootCid}`); onComplete(`Upload accepted. Root CID: ${result.rootCid}`); setFile(null);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Upload failed"); }
    finally { setBusy(false); }
  };
  return <section className="grid two upload-layout"><div className="panel upload-panel"><div className="section-heading"><p className="eyebrow">CONTENT INGESTION</p><h3>Upload content</h3></div><div className="dropzone"><input type="file" aria-label="Choose a file to upload" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><div className="drop-icon"><Icon name="upload" size={27}/></div><strong>{file ? file.name : "Choose a file"}</strong><span>{file ? formatBytes(file.size) : "Files are chunked and CID-verified at the edge"}</span></div>
    <div className="segmented"><button className={mode === "standard" ? "selected" : ""} onClick={() => setMode("standard")}>Standard IPFS</button><button className={mode === "sealed" ? "selected" : ""} onClick={() => setMode("sealed")}>Sealed vault</button></div>
    {mode === "sealed" && <label>Vault passphrase<input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} placeholder="Never sent to the server" /></label>}
    <button className="primary wide" disabled={!file || busy || (mode === "sealed" && passphrase.length < 12)} onClick={() => void upload()}>{busy ? "Processing…" : "Create CID & upload"}</button>
    {(busy || status) && <div className="progress-wrap"><div className="progress"><i style={{ width: `${progress}%` }} /></div><small>{status}</small></div>}</div>
    <div className="panel info-panel"><p className="eyebrow">INGESTION POLICY</p><h3>Verified before pinning</h3><ol><li>Build a standard UnixFS DAG in your browser.</li><li>Upload up to eight R2 multipart parts concurrently.</li><li>Verify every 1 MiB raw block CID inside the Worker.</li><li>Traverse and pin the complete DAG through Queues.</li></ol><div className="callout">Sealed mode encrypts bytes locally. Cloudflare never receives the passphrase or plaintext.</div></div></section>;
}

function PinTable({ pins, onDelete, onUnlock, onOpen, compact = false }: { pins: PinResult[]; onDelete?: (pin: PinResult) => void; onUnlock?: (pin: PinResult) => void; onOpen?: (pin: PinResult) => void; compact?: boolean }) { return pins.length ? <div className={`table ${compact ? "compact-table" : ""}`}><div className="tr th"><span>Name</span><span>CID</span><span>Status</span>{!compact&&<span>Created</span>}<span /></div>{pins.map((pin) => <div className="tr" key={pin.requestid}><span><strong>{pin.pin.name || "Untitled"}</strong></span><code title={pin.pin.cid}>{pin.pin.cid.slice(0, 18)}…</code><span><em className={`tag ${pin.status === "pinned" ? "green" : "amber"}`}>{pin.info?.mode === "sealed" ? "sealed" : pin.status}</em></span>{!compact&&<span>{new Date(pin.created).toLocaleDateString()}</span>}<span className="row-actions">{pin.info?.mode === "sealed"&&onUnlock?<button onClick={() => onUnlock(pin)}>Unlock</button>:onOpen?<button onClick={() => onOpen(pin)}>Open <Icon name="external" size={13}/></button>:null}{onDelete && <button onClick={() => onDelete(pin)}>Remove</button>}</span></div>)}</div> : <Empty text="No pinned content yet"/>; }
function PinsPanel({ apiBase, pins, onChanged }: { apiBase: string; gatewayHost: string; project: Project; pins: PinResult[]; onChanged: () => Promise<void> }) {
  const [selected,setSelected]=useState<PinResult|null>(null);const[passphrase,setPassphrase]=useState("");const[progress,setProgress]=useState(0);const[status,setStatus]=useState("");const[busy,setBusy]=useState(false);
  const remove = async (pin: PinResult) => { if (!confirm(`Unpin ${pin.pin.cid}?`)) return; await apiFetch(`${apiBase}/pins/${pin.requestid}`, { method: "DELETE" }); await onChanged(); };
  const preview=async(pin:PinResult)=>{const result=await apiFetch<{url:string}>(`${apiBase}/preview/${pin.pin.cid}`,{method:"POST"});window.open(result.url,"_blank","noopener,noreferrer");};
  const unlock=async(event:FormEvent)=>{event.preventDefault();if(!selected)return;setBusy(true);setStatus("Downloading encrypted object…");setProgress(0);try{const previewResult=await apiFetch<{url:string}>(`${apiBase}/preview/${selected.pin.cid}`,{method:"POST"});const response=await fetch(previewResult.url,{credentials:"omit"});if(!response.ok)throw new Error(`Gateway returned ${response.status}`);const encrypted=await response.blob();setStatus("Decrypting locally…");const result=await unsealFile(encrypted,passphrase,setProgress);const url=URL.createObjectURL(result.blob);const link=document.createElement("a");link.href=url;link.download=result.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30_000);setStatus("Decrypted download ready");setPassphrase("");}catch(error){setStatus(error instanceof Error?error.message:"Vault unlock failed");}finally{setBusy(false);}};
  return <section className="panel"><div className="panel-title"><div><p className="eyebrow">PINNING SERVICE API</p><h3>Content pins</h3></div><span>{pins.length} roots</span></div>{selected&&<form className="vault-unlock" onSubmit={unlock}><div><strong>Unlock sealed object</strong><code>{selected.pin.cid}</code></div><label>Vault passphrase<input type="password" value={passphrase} onChange={(event)=>setPassphrase(event.target.value)} minLength={12} required autoFocus/></label><button className="primary" disabled={busy}>{busy?"Decrypting…":"Decrypt & download"}</button><button className="ghost" type="button" onClick={()=>{setSelected(null);setPassphrase("");setStatus("")}}>Cancel</button>{status&&<div className="progress-wrap"><div className="progress"><i style={{width:`${progress}%`}}/></div><small>{status}</small></div>}</form>}<PinTable pins={pins} onUnlock={setSelected} onOpen={(pin)=>void preview(pin)} onDelete={(pin) => void remove(pin)} /></section>;
}

function FilesPanel({ apiBase, files, onChanged }: { apiBase: string; files: Record<string, unknown>[]; onChanged: () => Promise<void> }) {
  const [operation,setOperation]=useState<"write"|"mkdir"|"cp"|"mv">("write"); const[path,setPath]=useState(""); const[cid,setCid]=useState(""); const[destination,setDestination]=useState("");
  const [historyPath,setHistoryPath]=useState(""); const[history,setHistory]=useState<Record<string,unknown>[]>([]); const[message,setMessage]=useState("");
  const mutate=async(event:FormEvent)=>{event.preventDefault();setMessage("");try{await apiFetch(`${apiBase}/files`,{method:"POST",body:JSON.stringify({op:operation,path,cid:operation==="write"?cid:undefined,destination:["cp","mv"].includes(operation)?destination:undefined})});setPath("");setCid("");setDestination("");setMessage("File operation completed");await onChanged();}catch(error){setMessage(error instanceof Error?error.message:"File operation failed");}};
  const remove=async(filePath:string)=>{if(!confirm(`Delete ${filePath} and its descendants?`))return;await apiFetch(`${apiBase}/files?path=${encodeURIComponent(filePath)}`,{method:"DELETE"});if(historyPath===filePath){setHistory([]);setHistoryPath("");}await onChanged();};
  const loadHistory=async(filePath:string)=>{const result=await apiFetch<{results:Record<string,unknown>[]}>(`${apiBase}/files/history?path=${encodeURIComponent(filePath)}`);setHistoryPath(filePath);setHistory(result.results);};
  const rollback=async(row:Record<string,unknown>)=>{if(!confirm(`Restore ${historyPath} from version ${String(row.version)}?`))return;await apiFetch(`${apiBase}/files`,{method:"POST",body:JSON.stringify({op:"rollback",path:historyPath,historyId:Number(row.id)})});await loadHistory(historyPath);await onChanged();};
  return <section className="grid two"><div className="panel"><div className="panel-title"><h3>Mutable project files</h3><span className="tag">Versioned</span></div><div className="file-list">{files.length ? files.map((file)=><div className="file-row" key={String(file.path)}><span className="row-leading-icon"><Icon name="files" size={18}/></span><div><strong>{String(file.path)}</strong><code>{String(file.cid).slice(0,24)}</code></div><small>{String(file.type)} · v{String(file.version)}</small><span className="row-actions"><button onClick={()=>void loadHistory(String(file.path))}>History</button><button onClick={()=>void remove(String(file.path))}>Delete</button></span></div>) : <Empty text="No project files yet"/>}</div>
    {historyPath&&<div className="history-panel"><div className="panel-title"><h3>{historyPath} history</h3><button className="ghost compact" onClick={()=>{setHistoryPath("");setHistory([])}}>Close</button></div>{history.length?history.map((row)=><div className="history-row" key={String(row.id)}><div><strong>Version {String(row.version)}</strong><small>{String(row.action)} · {new Date(String(row.recorded_at)).toLocaleString()}</small></div><button className="ghost compact" onClick={()=>void rollback(row)}>Restore</button></div>):<Empty text="No recorded versions"/>}</div>}
  </div><form className="panel form-panel" onSubmit={mutate}><h3>File operation</h3><label>Operation<select value={operation} onChange={(event)=>setOperation(event.target.value as typeof operation)}><option value="write">Mount CID</option><option value="mkdir">Create directory</option><option value="cp">Copy path</option><option value="mv">Move path</option></select></label><label>{operation==="write"||operation==="mkdir"?"Project path":"Source path"}<input value={path} onChange={(event)=>setPath(event.target.value)} placeholder="/documents/report.pdf" required/></label>{operation==="write"&&<label>Content CID<input value={cid} onChange={(event)=>setCid(event.target.value)} placeholder="bafy…" required/></label>}{["cp","mv"].includes(operation)&&<label>Destination path<input value={destination} onChange={(event)=>setDestination(event.target.value)} placeholder="/archive/report.pdf" required/></label>}<button className="primary">Apply operation</button>{message&&<div className="callout">{message}</div>}</form></section>;
}

function NamesPanel({ apiBase, names, onChanged }: { apiBase: string; names: Record<string, unknown>[]; onChanged: () => Promise<void> }) { const [name,setName]=useState("");const[cid,setCid]=useState("");const publish=async(e:FormEvent)=>{e.preventDefault();await apiFetch(`${apiBase}/stable-links`,{method:"POST",body:JSON.stringify({name,cid,ttlSeconds:86400})});setName("");setCid("");await onChanged();}; return <section className="grid two"><div className="panel"><h3>Stable links</h3><p>A signed mutable name can point to a newer CID without changing the friendly project link.</p>{names.length ? names.map((item)=><div className="name-row" key={String(item.name)}><strong>{String(item.name)}</strong><code>/ipfs/{String(item.cid)}</code><small>Sequence {String(item.sequence)} · <a href={`${apiBase}/stable-links/${String(item.name)}/record`} target="_blank" rel="noreferrer">Export signed record</a></small></div>) : <Empty text="No stable links published"/>}</div><form className="panel form-panel" onSubmit={publish}><h3>Update a stable link</h3><label>Name<input value={name} onChange={(e)=>setName(e.target.value)} placeholder="latest" required/></label><label>CID<input value={cid} onChange={(e)=>setCid(e.target.value)} placeholder="bafy…" required/></label><button className="primary">Sign and publish privately</button></form></section>; }

function ImportPanel({ apiBase, onQueued }: { apiBase: string; onQueued: (message:string)=>void }) { const[cid,setCid]=useState("");const[busy,setBusy]=useState(false);const submit=async(e:FormEvent)=>{e.preventDefault();setBusy(true);try{const result=await apiFetch<{jobId:string}>(`${apiBase}/imports/cid`,{method:"POST",body:JSON.stringify({cid})});onQueued(`Trustless CAR import queued: ${result.jobId}`);setCid("");}finally{setBusy(false)}}; return <section className="panel narrow"><p className="eyebrow">TRUSTLESS HTTP IMPORT</p><h2>Bring a public CID into this project</h2><p>Only configured gateways are contacted. Every CAR block and root multihash is verified before project ownership is recorded.</p><form onSubmit={submit}><label>Public CID<input value={cid} onChange={(e)=>setCid(e.target.value)} placeholder="bafy…" required/></label><button className="primary" disabled={busy}>{busy?"Queueing…":"Import and verify"}</button></form></section>; }

function IntegrationPanel({ project, gatewayHost, appOrigin }: { project: Project; gatewayHost: string; appOrigin: string }) {
  const [keys,setKeys]=useState<Record<string,unknown>[]>([]);const[name,setName]=useState("");const[created,setCreated]=useState("");const[expires,setExpires]=useState("");
  const [scopes,setScopes]=useState<string[]>(["read","write","pin","publish","export"]);const[message,setMessage]=useState("");
  const base=`/api/v1/projects/${encodeURIComponent(project.id)}`;const machine=`${appOrigin}/api/v1/p/${project.slug}`;const gateway=`https://${gatewayHost}/${project.slug}`;
  const load=useCallback(()=>apiFetch<{results:Record<string,unknown>[]}>(`${base}/keys`).then((value)=>setKeys(value.results)),[base]);useEffect(()=>{void load()},[load]);
  const copy=async(value:string)=>{await navigator.clipboard.writeText(value);setMessage("Copied to clipboard");window.setTimeout(()=>setMessage(""),1800);};
  const toggle=(scope:string)=>setScopes((current)=>current.includes(scope)?current.filter((value)=>value!==scope):[...current,scope]);
  const create=async(event:FormEvent)=>{event.preventDefault();const result=await apiFetch<{token:string}>(`${base}/keys`,{method:"POST",body:JSON.stringify({name,scopes,expiresAt:expires?new Date(expires).toISOString():null})});setCreated(result.token);setName("");await load();};
  const revoke=async(key:Record<string,unknown>)=>{if(!confirm(`Revoke ${String(key.name)} immediately?`))return;await apiFetch(`${base}/keys/${String(key.id)}`,{method:"DELETE"});await load();};
  const rotate=async(key:Record<string,unknown>)=>{if(!confirm(`Rotate ${String(key.name)}? The old key stops working immediately.`))return;const result=await apiFetch<{token:string}>(`${base}/keys/${String(key.id)}/rotate`,{method:"POST"});setCreated(result.token);await load();};
  const jsExample=`const form = new FormData();\nform.append("file", file);\n\nconst response = await fetch("${appOrigin}/api/v0/add?pin=true", {\n  method: "POST",\n  headers: { Authorization: "Bearer ORBITCID_API_KEY" },\n  body: form\n});\nif (!response.ok) throw new Error(await response.text());\nconst records = (await response.text()).trim().split("\\n").map(JSON.parse);\nconst cid = records.at(-1).Hash;`;
  const curlExample=`curl -X POST "${appOrigin}/api/v0/add?pin=true" \\\n  -H "Authorization: Bearer ORBITCID_API_KEY" \\\n  -F "file=@./asset.png"`;
  const resumableExample=`POST ${machine}/uploads\nPOST ${machine}/uploads/{uploadId}/parts/{partNumber}\nPOST ${machine}/uploads/{uploadId}/dag\nPOST ${machine}/uploads/{uploadId}/complete\n\nEach request: Authorization: Bearer ORBITCID_API_KEY`;
  const nftExample=`const imageCid = await addFile(imageFile);\nconst metadata = {\n  name: "My NFT",\n  description: "Immutable metadata hosted with OrbitCID",\n  image: \`ipfs://\${imageCid}\`\n};\nconst metadataCid = await addFile(new Blob([JSON.stringify(metadata)], { type: "application/json" }));\nconsole.log(\`ipfs://\${metadataCid}\`);`;
  const retrievalExample=`IPFS URI: ipfs://YOUR_CID\nProject gateway: ${gateway}/ipfs/YOUR_CID\nStandard public alias: https://${gatewayHost}/ipfs/YOUR_CID`;
  return <><section className="grid two"><form className="panel form-panel" onSubmit={create}><p className="eyebrow">PROJECT CREDENTIAL</p><h3>Create a named API key</h3><label>Key name<input value={name} onChange={(event)=>setName(event.target.value)} placeholder="NFT metadata uploader" required/></label><fieldset><legend>Scopes</legend><div className="scope-grid">{["read","write","pin","publish","export"].map((scope)=><label className="check-pill" key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={()=>toggle(scope)}/><span>{scope}</span></label>)}</div></fieldset><label>Expiry (optional)<input type="datetime-local" value={expires} onChange={(event)=>setExpires(event.target.value)}/></label><button className="primary" disabled={!scopes.length}>Generate key</button>{created&&<div className="secret"><small>Copy now — this secret is shown once</small><code>{created}</code><button type="button" className="ghost compact" onClick={()=>void copy(created)}>Copy key</button></div>}{message&&<div className="callout" role="status">{message}</div>}</form><div className="panel"><p className="eyebrow">KEY INVENTORY</p><h3>Project API keys</h3>{keys.length?keys.map((key)=><div className="token-row" key={String(key.id)}><div><strong>{String(key.name)}</strong><code>{String(key.prefix)}…</code></div><small>{key.revoked_at?"Revoked":Array.isArray(key.scopes)?key.scopes.join(", "):"Active"}</small>{!key.revoked_at&&<span className="row-actions"><button onClick={()=>void rotate(key)}>Rotate</button><button className="danger compact" onClick={()=>void revoke(key)}>Revoke</button></span>}</div>):<Empty text="No project API keys created"/>}</div></section><section className="panel integration-guide"><div className="panel-title"><div><p className="eyebrow">COPY-READY GUIDE</p><h3>Integrate {project.name}</h3></div><span className="tag">{project.slug}</span></div><p>Replace <code>ORBITCID_API_KEY</code> with a key created above. Keep it server-side; never ship it in a public browser bundle.</p><Snippet title="JavaScript / TypeScript small upload" code={jsExample} onCopy={copy}/><Snippet title="cURL upload" code={curlExample} onCopy={copy}/><Snippet title="Resumable upload sequence" code={resumableExample} onCopy={copy}/><Snippet title="NFT image + JSON metadata" code={nftExample} onCopy={copy}/><Snippet title="Retrieval and ipfs://" code={retrievalExample} onCopy={copy}/></section></>;
}
function Snippet({title,code,onCopy}:{title:string;code:string;onCopy:(value:string)=>Promise<void>}){return <details className="snippet"><summary>{title}<Icon name="arrow" size={16}/></summary><div><pre><code>{code}</code></pre><button className="ghost compact" onClick={()=>void onCopy(code)}>Copy code</button></div></details>}
function AuditPanel({ rows }: { rows: Record<string,unknown>[] }) { return <section className="panel"><div className="panel-title"><h3>Immutable activity trail</h3><span>{rows.length} recent events</span></div><div className="audit-list">{rows.map((row)=><div className="audit-row" key={String(row.id)}><span className="audit-dot"/><div><strong>{String(row.action)}</strong><code>{String(row.target??"system")}</code></div><span>{String(row.actor)}</span><time>{new Date(String(row.created_at)).toLocaleString()}</time></div>)}</div></section>; }
function SettingsPanel({ session, projects, navigation, onNavigationChange, onProjectsChanged, onSelectProject, onLogout }: { session:SessionInfo|null; projects:Project[]; navigation:NavigationPreferences; onNavigationChange:(visible:Tab[],overflow:Tab[])=>Promise<void>; onProjectsChanged:()=>Promise<void>; onSelectProject:(id:string)=>void; onLogout:()=>void }) {
  const[name,setName]=useState("");const[slug,setSlug]=useState("");const[visibility,setVisibility]=useState<"private"|"public">("private");const[gateway,setGateway]=useState(false);const[ack,setAck]=useState(false);const[deleted,setDeleted]=useState<Project[]>([]);const[message,setMessage]=useState("");const[editing,setEditing]=useState<Project|null>(null);const[editName,setEditName]=useState("");const[editVisibility,setEditVisibility]=useState<"private"|"public">("private");const[editGateway,setEditGateway]=useState(false);const[editAck,setEditAck]=useState(false);
  const loadDeleted=useCallback(()=>apiFetch<{results:Project[]}>("/api/v1/projects?includeDeleted=true").then((value)=>setDeleted(value.results.filter((project)=>project.state==="deleted"))),[]);useEffect(()=>{void loadDeleted()},[loadDeleted]);
  const create=async(event:FormEvent)=>{event.preventDefault();setMessage("");try{const project=await apiFetch<Project>("/api/v1/projects",{method:"POST",body:JSON.stringify({name,slug,defaultVisibility:visibility,gatewayEnabled:gateway,acknowledgePublicPersistence:ack})});setName("");setSlug("");setVisibility("private");setGateway(false);setAck(false);await onProjectsChanged();onSelectProject(project.id);setMessage("Project created");}catch(error){setMessage(error instanceof Error?error.message:"Project creation failed")}};
  const remove=async(project:Project)=>{if(project.id==="default")return;if(!confirm(`Delete ${project.name}? Its gateway closes immediately and recovery remains available for 30 days.`))return;await apiFetch(`/api/v1/projects/${project.id}`,{method:"DELETE"});onSelectProject("all");await onProjectsChanged();await loadDeleted();};
  const restore=async(project:Project)=>{await apiFetch(`/api/v1/projects/${project.id}/restore`,{method:"POST"});await onProjectsChanged();await loadDeleted();onSelectProject(project.id);};
  const beginEdit=(project:Project)=>{setEditing(project);setEditName(project.name);setEditVisibility(project.default_visibility);setEditGateway(Boolean(project.gateway_enabled));setEditAck(false);};
  const saveEdit=async(event:FormEvent)=>{event.preventDefault();if(!editing)return;await apiFetch(`/api/v1/projects/${editing.id}`,{method:"PATCH",body:JSON.stringify({name:editName,defaultVisibility:editVisibility,gatewayEnabled:editGateway,acknowledgePublicPersistence:editAck})});setEditing(null);await onProjectsChanged();};
  const logout=async()=>{await apiFetch("/api/v1/session/logout",{method:"POST"});onLogout();};
  return <><section className="grid two"><div className="panel form-panel"><p className="eyebrow">PRODUCTION SECURITY</p><h3>Two independent layers</h3><p>Cloudflare Access verifies the configured Google identity, then OrbitCID requires an independently revocable password session.</p><div className="callout">Authenticated as {session?.actor ?? "owner"} through Google Access + password.</div></div><div className="panel form-panel"><p className="eyebrow">SESSION CONTROL</p><h3>Lock this console</h3><p>Revokes this D1-backed browser session immediately. Cloudflare Access remains a separate boundary.</p><button className="danger" onClick={()=>void logout()}>Lock admin console</button></div></section><section className="grid two"><form className="panel form-panel" onSubmit={create}><p className="eyebrow">NEW NAMESPACE</p><h3>Create project</h3><label>Project name<input value={name} onChange={(event)=>{setName(event.target.value);if(!slug)setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,""))}} required/></label><label>Immutable slug<input value={slug} onChange={(event)=>setSlug(event.target.value.toLowerCase())} pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?" required/></label><label>Default visibility<select value={visibility} onChange={(event)=>setVisibility(event.target.value as "private"|"public")}><option value="private">Private</option><option value="public">Public</option></select></label><label className="toggle-row"><input type="checkbox" checked={gateway} onChange={(event)=>setGateway(event.target.checked)}/><span>Enable public gateway for this project</span></label>{gateway&&visibility==="public"&&<label className="warning-check"><input type="checkbox" checked={ack} onChange={(event)=>setAck(event.target.checked)} required/><span>I understand public IPFS content may remain available from third-party peers after I unpublish it.</span></label>}<button className="primary">Create project</button>{message&&<div className="callout">{message}</div>}</form><div className="panel"><p className="eyebrow">LIFECYCLE</p><h3>Project management</h3>{projects.map((project)=><div className="project-manage-row" key={project.id}><div><strong>{project.name}</strong><code>{project.slug}</code></div><span className="tag">{project.default_visibility}</span><button className="ghost compact" onClick={()=>beginEdit(project)}>Edit</button>{project.id!=="default"&&<button className="danger compact" onClick={()=>void remove(project)}>Delete</button>}</div>)}{editing&&<form className="project-edit" onSubmit={saveEdit}><h4>Edit {editing.name}</h4><label>Name<input value={editName} onChange={(event)=>setEditName(event.target.value)} required/></label><label>Default visibility<select value={editVisibility} onChange={(event)=>setEditVisibility(event.target.value as "private"|"public")}><option value="private">Private</option><option value="public">Public</option></select></label><label className="toggle-row"><input type="checkbox" checked={editGateway} onChange={(event)=>setEditGateway(event.target.checked)}/><span>Enable public gateway</span></label>{editGateway&&editVisibility==="public"&&<label className="warning-check"><input type="checkbox" checked={editAck} onChange={(event)=>setEditAck(event.target.checked)}/><span>I acknowledge public IPFS persistence when this change activates public-by-default publishing.</span></label>}<span className="row-actions"><button className="primary compact">Save</button><button type="button" className="ghost compact" onClick={()=>setEditing(null)}>Cancel</button></span></form>}{!!deleted.length&&<div className="recovery-list"><h4>30-day recovery</h4>{deleted.map((project)=><div className="project-manage-row" key={project.id}><div><strong>{project.name}</strong><code>{project.slug}</code></div><button className="ghost compact" onClick={()=>void restore(project)}>Restore</button></div>)}</div>}</div></section><NavigationEditor navigation={navigation} onChange={onNavigationChange}/></>;
}
function NavigationEditor({navigation,onChange}:{navigation:NavigationPreferences;onChange:(visible:Tab[],overflow:Tab[])=>Promise<void>}){const move=(id:Tab,delta:number)=>{const isVisible=navigation.visible.includes(id);const group=[...(isVisible?navigation.visible:navigation.overflow)];const index=group.indexOf(id);const next=Math.max(0,Math.min(group.length-1,index+delta));group.splice(index,1);group.splice(next,0,id);void onChange(isVisible?group:navigation.visible,isVisible?navigation.overflow:group)};const toggle=(id:Tab)=>{if(navigation.visible.includes(id)){if(navigation.visible.length===1)return;void onChange(navigation.visible.filter((item)=>item!==id),[...navigation.overflow,id])}else void onChange([...navigation.visible,id],navigation.overflow.filter((item)=>item!==id))};return <section className="panel navigation-editor"><div className="panel-title"><div><p className="eyebrow">PERSONAL NAVIGATION</p><h3>Reorder or place in More</h3></div><span>Synced to D1</span></div><p>Drag desktop navigation pills directly, or use these mobile-friendly controls.</p><div>{[...navigation.visible,...navigation.overflow].map((id)=>{const item=NAVIGATION.find((entry)=>entry.id===id)!;const group=navigation.visible.includes(id)?navigation.visible:navigation.overflow;const index=group.indexOf(id);return <div className="navigation-row" key={id}><span className="menu-icon"><Icon name={id}/></span><strong>{item.label}</strong><span className="tag">{navigation.visible.includes(id)?"Visible":"More"}</span><button className="ghost compact" disabled={index===0} onClick={()=>move(id,-1)} aria-label={`Move ${item.label} up`}>↑</button><button className="ghost compact" disabled={index===group.length-1} onClick={()=>move(id,1)} aria-label={`Move ${item.label} down`}>↓</button><button className="ghost compact" onClick={()=>toggle(id)}>{navigation.visible.includes(id)?"Move to More":"Show in nav"}</button></div>})}</div></section>}
function Empty({text}:{text:string}){return <div className="empty"><span className="empty-icon"><Icon name="overview" size={24}/></span><span>{text}</span></div>}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
