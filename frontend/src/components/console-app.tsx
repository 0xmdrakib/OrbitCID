"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Icon } from "./icons";

interface Connection { id: string; name: string; endpoint: string; key_fingerprint: string; state: string; last_seen_at: string | null; created_at: string }
interface Activity { id: string; action: string; subject: string | null; connection_id: string | null; created_at: string }
interface Claim { code: string; expiresAt: string }
interface Pin { cid: string; type: string }
interface BackupStatus { configured: boolean; provider: string; bucket?: string; prefix?: string; retentionDays?: number; accountHint?: string; state: string; lastStartedAt?: string | null; lastCompletedAt?: string | null; lastError?: string | null; accepted?: boolean }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers }, credentials: "same-origin" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
  return body as T;
}

export function ConsoleApp() {
  const { data: session, isPending } = authClient.useSession();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [label, setLabel] = useState("My IPFS node");
  const [claim, setClaim] = useState<Claim | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeConnectionId, setActiveConnectionId] = useState("");
  const [pins, setPins] = useState<Pin[]>([]);
  const [pinCid, setPinCid] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const [r2AccountId, setR2AccountId] = useState("");
  const [r2AccessKeyId, setR2AccessKeyId] = useState("");
  const [r2SecretAccessKey, setR2SecretAccessKey] = useState("");
  const [r2Bucket, setR2Bucket] = useState("");
  const [r2Prefix, setR2Prefix] = useState("orbitcid");
  const [r2RetentionDays, setR2RetentionDays] = useState(30);

  const refresh = useCallback(async () => {
    const [connectionData, activityData] = await Promise.all([api<{ connections: Connection[] }>("/api/connections"), api<{ activity: Activity[] }>("/api/activity")]);
    setConnections(connectionData.connections); setActivity(activityData.activity);
    setActiveConnectionId((current) => current || connectionData.connections.find((item) => item.state === "active")?.id || "");
  }, []);
  useEffect(() => { if (session?.user) void refresh().catch((error) => setNotice(error.message)); }, [session?.user, refresh]);

  if (isPending) return <main className="console-loading"><span className="spinner"/>Verifying your session…</main>;
  if (!session?.user) return <main className="sign-in-panel"><div className="mark large"><Icon name="shield" size={30}/></div><p className="eyebrow">PRIVATE ACTION REQUIRED</p><h1>Sign in to create your isolated workspace.</h1><p>The public frontend is open to inspect. Connections, activity and backend grants require a verified Google session.</p><button className="ink-button large" onClick={() => void authClient.signIn.social({ provider: "google", callbackURL: "/console" })}>Continue with Google <Icon name="arrow"/></button></main>;

  async function createClaim(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice("");
    try { setClaim(await api<Claim>("/api/pairing-claims", { method: "POST", body: JSON.stringify({ label }) })); await refresh(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Could not create pairing code"); }
    finally { setBusy(false); }
  }
  async function testConnection(connection: Connection) {
    setBusy(true); setNotice("");
    try {
      const grant = await api<{ token: string; endpoint: string }>("/api/backend/grant", { method: "POST", body: JSON.stringify({ connectionId: connection.id, scopes: ["read"] }) });
      const response = await fetch(`${grant.endpoint}/v1/tenant/health`, { headers: { Authorization: `Bearer ${grant.token}` } });
      if (!response.ok) throw new Error(`Backend returned ${response.status}`);
      const result = await response.json(); setNotice(`${connection.name} is online · ${result.peers ?? 0} IPFS peers`);
      await fetch("/api/activity", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "backend.checked", subject: connection.name, connectionId: connection.id }) });
    } catch (error) { setNotice(error instanceof Error ? error.message : "Backend health check failed"); }
    finally { setBusy(false); }
  }
  async function revoke(connection: Connection) {
    if (!window.confirm(`Revoke ${connection.name}? Its old grants will expire within five minutes.`)) return;
    setBusy(true); try { await fetch(`/api/connections/${connection.id}`, { method: "DELETE", credentials: "same-origin" }); await refresh(); } finally { setBusy(false); }
  }

  const activeConnection = connections.find((connection) => connection.id === activeConnectionId && connection.state === "active");
  async function grant(scopes: string[]) {
    if (!activeConnection) throw new Error("Select an active backend first");
    return api<{ token: string; endpoint: string }>("/api/backend/grant", { method: "POST", body: JSON.stringify({ connectionId: activeConnection.id, scopes }) });
  }
  async function saveActivity(action: "file.uploaded" | "pin.created" | "pin.removed" | "backup.configured" | "backup.removed" | "backup.started", subject: string, metadata: Record<string, string | number | boolean | null> = {}) {
    if (!activeConnection) return;
    await fetch("/api/activity", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, subject, connectionId: activeConnection.id, metadata }) });
  }
  async function loadPins() {
    setBusy(true); setNotice("");
    try {
      const access = await grant(["read"]);
      const response = await fetch(`${access.endpoint}/v1/pins`, { headers: { Authorization: `Bearer ${access.token}` } });
      if (!response.ok) throw new Error(`Backend returned ${response.status}`);
      const body = await response.json() as { Keys?: Record<string, { Type?: string }> };
      setPins(Object.entries(body.Keys || {}).map(([cid, value]) => ({ cid, type: value.Type || "recursive" })));
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not load pins"); }
    finally { setBusy(false); }
  }
  async function upload(event: FormEvent) {
    event.preventDefault(); if (!file || !activeConnection) return; setBusy(true); setNotice("");
    try {
      const access = await grant(["write"]); const form = new FormData(); form.append("file", file, file.name);
      const response = await fetch(`${access.endpoint}/v1/ipfs/add`, { method: "POST", headers: { Authorization: `Bearer ${access.token}` }, body: form });
      if (!response.ok) throw new Error(`Upload failed (${response.status})`);
      const lines = (await response.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { Hash?: string; Name?: string });
      const result = lines.at(-1); if (!result?.Hash) throw new Error("Backend did not return a CID");
      const uploadedFile = file;
      let activitySaved = true;
      try { await saveActivity("file.uploaded", result.Hash, { name: uploadedFile.name, size: uploadedFile.size }); } catch { activitySaved = false; }
      setNotice(`Uploaded ${uploadedFile.name} · ${result.Hash}${activitySaved ? "" : " · activity sync needs retry"}`); setFile(null); await loadPins(); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Upload failed"); }
    finally { setBusy(false); }
  }
  async function changePin(action: "pin" | "unpin", cid = pinCid) {
    if (!activeConnection || !cid) return; setBusy(true); setNotice("");
    try {
      const access = await grant(["pin"]);
      const response = await fetch(`${access.endpoint}/v1/pins`, { method: "POST", headers: { Authorization: `Bearer ${access.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ action, cid }) });
      if (!response.ok) throw new Error(`Backend returned ${response.status}`);
      await saveActivity(action === "pin" ? "pin.created" : "pin.removed", cid); setPinCid(""); await loadPins(); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : `Could not ${action} CID`); }
    finally { setBusy(false); }
  }
  async function backupRequest(path = "/v1/backup/r2", init?: RequestInit) {
    const access = await grant(["backup"]);
    const response = await fetch(`${access.endpoint}${path}`, { ...init, headers: { Authorization: `Bearer ${access.token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
    const body = await response.json().catch(() => ({})) as BackupStatus & { error?: string };
    if (!response.ok) throw new Error(body.error || `Backend returned ${response.status}`);
    return body;
  }
  async function loadBackupStatus() {
    setBusy(true); setNotice("");
    try { setBackupStatus(await backupRequest()); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Could not read backup status"); }
    finally { setBusy(false); }
  }
  async function configureBackup(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice("");
    try {
      const status = await backupRequest("/v1/backup/r2", { method: "PUT", body: JSON.stringify({ accountId: r2AccountId, accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey, bucket: r2Bucket, prefix: r2Prefix, retentionDays: r2RetentionDays }) });
      setBackupStatus(status); setR2SecretAccessKey(""); setR2AccessKeyId(""); setR2AccountId("");
      await saveActivity("backup.configured", r2Bucket, { provider: "cloudflare-r2", prefix: r2Prefix });
      setNotice("R2 backup configured on this backend. The secret was not stored by the control service."); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not configure R2 backup"); }
    finally { setBusy(false); }
  }
  async function runBackup() {
    setBusy(true); setNotice("");
    try {
      const status = await backupRequest("/v1/backup/r2/run", { method: "POST" }); setBackupStatus(status);
      await saveActivity("backup.started", status.bucket || "R2 backup"); setNotice("Encrypted offsite backup started on your backend."); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not start backup"); }
    finally { setBusy(false); }
  }
  async function removeBackup() {
    if (!window.confirm("Remove this backend's saved R2 backup configuration? Existing R2 snapshots will not be deleted.")) return;
    setBusy(true); setNotice("");
    try {
      const previousBucket = backupStatus?.bucket || "R2 backup"; setBackupStatus(await backupRequest("/v1/backup/r2", { method: "DELETE" }));
      await saveActivity("backup.removed", previousBucket); setNotice("R2 backup configuration removed. Existing snapshots remain in your bucket."); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not remove backup configuration"); }
    finally { setBusy(false); }
  }

  return <main className="console-main">
    <section className="console-hero"><div><p className="eyebrow">YOUR CONTROL SPACE</p><h1>Good to see you,<br/><em>{session.user.name?.split(" ")[0] || "operator"}.</em></h1><p>Your account data is isolated. Your content remains on the IPFS backend you own.</p></div><div className="identity-card">{session.user.image ? <img src={session.user.image} alt="" referrerPolicy="no-referrer"/> : <span>{session.user.name?.[0] || "U"}</span>}<div><small>VERIFIED GOOGLE IDENTITY</small><strong>{session.user.name}</strong><p>{session.user.email}</p></div><Icon name="check"/></div></section>
    {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice("")} aria-label="Dismiss"><Icon name="x" size={16}/></button></div>}
    <section className="console-grid">
      <div className="console-panel connections-panel"><div className="panel-head"><div><p className="eyebrow">BACKEND CONNECTIONS</p><h2>Your nodes</h2></div><span className="count">{connections.filter((item) => item.state === "active").length}</span></div>
        {connections.length ? <div className="connection-list">{connections.map((connection) => <article key={connection.id} className={connection.state !== "active" ? "muted" : ""}><span className="connection-icon"><Icon name="server"/></span><div><strong>{connection.name}</strong><code>{connection.endpoint}</code><small>Key {connection.key_fingerprint.slice(0, 12)}… · {connection.state}</small></div><div className="row-buttons">{connection.state === "active" && <button onClick={() => void testConnection(connection)} disabled={busy}>Test</button>}<button className="danger-text" onClick={() => void revoke(connection)} disabled={busy}>Revoke</button></div></article>)}</div> : <div className="empty-state"><span><Icon name="link" size={28}/></span><h3>No backend connected</h3><p>Create a one-time claim, then run the pairing command on your own server.</p></div>}
      </div>
      <form className="console-panel pair-panel" onSubmit={createClaim}><p className="eyebrow">ONE-TIME PAIRING</p><h2>Connect your backend</h2><p>The claim expires in ten minutes and can be used once. OrbitCID stores only its SHA-256 hash.</p><label>Connection name<input value={label} onChange={(event) => setLabel(event.target.value)} minLength={1} maxLength={80} required/></label><button className="ink-button wide" disabled={busy}>{busy ? "Preparing…" : "Create pairing code"}<Icon name="arrow"/></button>
        {claim && <div className="claim-box"><small>ONE-TIME CODE · EXPIRES {new Date(claim.expiresAt).toLocaleTimeString()}</small><code>{claim.code}</code><button type="button" onClick={() => void navigator.clipboard.writeText(claim.code)}>Copy code</button><hr/><small>ON YOUR BACKEND</small><pre>docker compose --profile pair run --rm pair</pre><p>Paste the code only when the secure terminal prompt asks for it.</p></div>}
      </form>
    </section>
    {!!connections.some((connection) => connection.state === "active") && <section className="workspace-section"><div className="workspace-title"><div><p className="eyebrow">DIRECT IPFS WORKSPACE</p><h2>Work with your node</h2><p>File bytes stream from this browser to your backend. Vercel receives only the resulting activity record.</p></div><label>Active backend<select value={activeConnectionId} onChange={(event) => { setActiveConnectionId(event.target.value); setPins([]); setBackupStatus(null); }}>{connections.filter((connection) => connection.state === "active").map((connection) => <option value={connection.id} key={connection.id}>{connection.name}</option>)}</select></label></div><div className="console-grid">
      <form className="console-panel upload-panel" onSubmit={upload}><span className="workspace-icon"><Icon name="orbit" size={28}/></span><p className="eyebrow">STREAMING UPLOAD</p><h3>Add to Kubo</h3><p>CIDv1, raw leaves, SHA-256 and 1 MiB chunks are enforced by the backend.</p><label className="file-drop"><input type="file" onChange={(event) => setFile(event.target.files?.[0] || null)} required/><strong>{file?.name || "Choose a file"}</strong><small>{file ? `${file.size.toLocaleString()} bytes` : "The file does not pass through Vercel."}</small></label><button className="ink-button wide" disabled={busy || !file}>Upload and pin <Icon name="arrow"/></button></form>
      <div className="console-panel pins-panel"><div className="panel-head"><div><p className="eyebrow">RECURSIVE PINS</p><h3>Node pinset</h3></div><button className="refresh-button" onClick={() => void loadPins()} disabled={busy}>Refresh</button></div><div className="pin-input"><input placeholder="CID to pin" value={pinCid} onChange={(event) => setPinCid(event.target.value.trim())}/><button onClick={() => void changePin("pin")} disabled={busy || !pinCid}>Pin</button></div>{pins.length ? <div className="pin-list">{pins.slice(0, 100).map((pin) => <div key={pin.cid}><code>{pin.cid}</code><span>{pin.type}</span><button onClick={() => void changePin("unpin", pin.cid)} disabled={busy}>Unpin</button></div>)}</div> : <div className="empty-state compact"><p>Refresh to read this backend's recursive pinset.</p></div>}</div>
    </div></section>}
    {activeConnection && <section className="console-panel backup-panel"><div className="panel-head"><div><p className="eyebrow">OPTIONAL OFFSITE BACKUP</p><h2>Cloudflare R2</h2><p>Keep this disabled if you do not need an offsite copy. Credentials travel directly to your paired backend and are encrypted there; the hosted control service never stores them.</p></div><button className="refresh-button" onClick={() => void loadBackupStatus()} disabled={busy}>Check status</button></div>
      {backupStatus?.configured ? <div className="backup-summary"><div><small>PRIVATE BUCKET</small><strong>{backupStatus.bucket}</strong><code>{backupStatus.prefix} · account {backupStatus.accountHint}</code></div><div><small>BACKUP STATE</small><strong>{backupStatus.state.replaceAll("_", " ")}</strong><span>{backupStatus.lastCompletedAt ? `Last completed ${new Date(backupStatus.lastCompletedAt).toLocaleString()}` : "No completed backup yet"}</span></div>{backupStatus.lastError && <p className="backup-error">{backupStatus.lastError}</p>}<div className="row-buttons"><button className="ink-button" onClick={() => void runBackup()} disabled={busy || backupStatus.state === "running"}>Run backup now</button><button className="danger-text" onClick={() => void removeBackup()} disabled={busy}>Remove configuration</button></div></div> : <form className="backup-form" onSubmit={configureBackup}><div className="backup-fields"><label>Cloudflare account ID<input value={r2AccountId} onChange={(event) => setR2AccountId(event.target.value.trim())} autoComplete="off" pattern="[A-Fa-f0-9]{32}" required/></label><label>R2 bucket<input value={r2Bucket} onChange={(event) => setR2Bucket(event.target.value.trim())} autoComplete="off" required/></label><label>R2 access key ID<input value={r2AccessKeyId} onChange={(event) => setR2AccessKeyId(event.target.value.trim())} autoComplete="off" required/></label><label>R2 secret access key<input type="password" value={r2SecretAccessKey} onChange={(event) => setR2SecretAccessKey(event.target.value)} autoComplete="new-password" minLength={32} required/></label><label>Backup prefix<input value={r2Prefix} onChange={(event) => setR2Prefix(event.target.value.trim())} required/></label><label>Retention days<input type="number" min={1} max={3650} value={r2RetentionDays} onChange={(event) => setR2RetentionDays(Number(event.target.value))} required/></label></div><div className="backup-consent"><Icon name="shield"/><p><strong>Least-privilege credentials only.</strong> Create an R2 token limited to Object Read & Write for this one bucket. OrbitCID never asks for your global API key.</p></div><button className="ink-button" disabled={busy}>Save encrypted backup configuration <Icon name="arrow"/></button></form>}
    </section>}
    <section className="console-panel activity-panel"><div className="panel-head"><div><p className="eyebrow">ACCOUNT ACTIVITY</p><h2>Security trail</h2></div><span>Private · isolated rows</span></div>{activity.length ? <div className="activity-list">{activity.map((item) => <div key={item.id}><i/><strong>{item.action.replaceAll(".", " ")}</strong><span>{item.subject || "—"}</span><time>{new Date(item.created_at).toLocaleString()}</time></div>)}</div> : <div className="empty-state compact"><p>Your account activity will appear here.</p></div>}</section>
  </main>;
}
