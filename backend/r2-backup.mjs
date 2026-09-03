import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function validate(input) {
  const value = {
    accountId: String(input?.accountId || "").trim(),
    accessKeyId: String(input?.accessKeyId || "").trim(),
    secretAccessKey: String(input?.secretAccessKey || "").trim(),
    bucket: String(input?.bucket || "").trim(),
    prefix: String(input?.prefix || "orbitcid").trim().replace(/^\/+|\/+$/g, ""),
    retentionDays: Number(input?.retentionDays || 30)
  };
  if (!/^[a-f0-9]{32}$/i.test(value.accountId)) throw new Error("Cloudflare account ID must be 32 hexadecimal characters");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(value.accessKeyId)) throw new Error("R2 access key ID format is invalid");
  if (value.secretAccessKey.length < 32 || value.secretAccessKey.length > 256) throw new Error("R2 secret access key format is invalid");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value.bucket)) throw new Error("R2 bucket name is invalid");
  if (!/^[A-Za-z0-9._/-]{1,160}$/.test(value.prefix) || value.prefix.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Backup prefix is invalid");
  if (!Number.isInteger(value.retentionDays) || value.retentionDays < 1 || value.retentionDays > 3650) throw new Error("Retention must be between 1 and 3650 days");
  return value;
}

function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  return mkdir(dirname(path), { recursive: true, mode: 0o700 })
    .then(() => writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" }))
    .then(() => rename(temporary, path));
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8000); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(output.trim() || `Backup process exited with ${code}`)));
  });
}

export class R2BackupManager {
  #pairing;
  #configPath;
  #statusPath;
  #backupDirectory;
  #kuboApi;
  #script;
  #running = false;

  constructor(pairing, options = {}) {
    this.#pairing = pairing;
    this.#configPath = options.configPath || "/var/lib/orbitcid/r2-backup.enc.json";
    this.#statusPath = options.statusPath || "/var/lib/orbitcid/r2-backup-status.json";
    this.#backupDirectory = options.backupDirectory || "/backups";
    this.#kuboApi = options.kuboApi || "http://kubo:5001";
    this.#script = options.script || "/usr/local/bin/orbitcid-backup";
  }

  #key() {
    const material = this.#pairing?.backendPrivateKey?.d;
    if (typeof material !== "string" || material.length < 32) throw new Error("Backend pairing key is unavailable");
    return createHash("sha256").update("orbitcid:r2-backup:v1\0").update(material).digest();
  }

  #aad() {
    return Buffer.from(`orbitcid:r2-backup:v1:${this.#pairing.connectionId}`);
  }

  #cryptPassword() {
    return createHash("sha256").update("orbitcid:r2-content:v1\0").update(this.#pairing.backendPrivateKey.d).digest("base64url");
  }

  async #readConfig() {
    const envelope = JSON.parse(await readFile(this.#configPath, "utf8"));
    if (envelope.version !== 1 || envelope.algorithm !== "AES-256-GCM") throw new Error("Backup configuration envelope is invalid");
    const decipher = createDecipheriv("aes-256-gcm", this.#key(), Buffer.from(envelope.iv, "base64url"));
    decipher.setAAD(this.#aad());
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]);
    return validate(JSON.parse(plaintext.toString("utf8")));
  }

  async save(input) {
    const config = validate(input);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key(), iv);
    cipher.setAAD(this.#aad());
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(config), "utf8"), cipher.final()]);
    await atomicJson(this.#configPath, {
      version: 1,
      algorithm: "AES-256-GCM",
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url")
    });
    return this.status();
  }

  async remove() {
    if (this.#running) throw new Error("A backup is currently running");
    await unlink(this.#configPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await atomicJson(this.#statusPath, { state: "not_configured", updatedAt: new Date().toISOString() });
    return this.status();
  }

  async status() {
    try {
      const [config, state] = await Promise.all([
        this.#readConfig(),
        readFile(this.#statusPath, "utf8").then((content) => JSON.parse(content)).catch(() => ({}))
      ]);
      return {
        configured: true,
        provider: "cloudflare-r2",
        bucket: config.bucket,
        prefix: config.prefix,
        retentionDays: config.retentionDays,
        accountHint: `…${config.accountId.slice(-6)}`,
        state: this.#running ? "running" : state.state || "ready",
        lastStartedAt: state.lastStartedAt || null,
        lastCompletedAt: state.lastCompletedAt || null,
        lastError: state.lastError || null
      };
    } catch (error) {
      if (error?.code === "ENOENT") return { configured: false, provider: "cloudflare-r2", state: "not_configured" };
      throw error;
    }
  }

  async start() {
    if (this.#running) return { accepted: false, ...(await this.status()) };
    const config = await this.#readConfig();
    this.#running = true;
    const startedAt = new Date().toISOString();
    await atomicJson(this.#statusPath, { state: "running", lastStartedAt: startedAt });
    void this.#execute(config, startedAt);
    return { accepted: true, ...(await this.status()) };
  }

  async #execute(config, startedAt) {
    const temporaryConfig = `/var/lib/orbitcid/rclone.${process.pid}.${randomBytes(6).toString("hex")}.conf`;
    try {
      const obscuredPassword = await run("rclone", ["obscure", this.#cryptPassword()], { env: process.env });
      const remotePath = `r2:${config.bucket}/${config.prefix}/${this.#pairing.connectionId}`;
      const rclone = [
        "[r2]",
        "type = s3",
        "provider = Cloudflare",
        `access_key_id = ${config.accessKeyId}`,
        `secret_access_key = ${config.secretAccessKey}`,
        `endpoint = https://${config.accountId}.r2.cloudflarestorage.com`,
        "acl = private",
        "no_check_bucket = true",
        "",
        "[secure]",
        "type = crypt",
        `remote = ${remotePath}`,
        `password = ${obscuredPassword}`,
        "filename_encryption = standard",
        "directory_name_encryption = true",
        ""
      ].join("\n");
      await writeFile(temporaryConfig, rclone, { mode: 0o600, flag: "wx" });
      await run(this.#script, [], {
        env: {
          ...process.env,
          KUBO_API: this.#kuboApi,
          RCLONE_CONFIG: temporaryConfig,
          RCLONE_REMOTE: "secure:",
          RETENTION_DAYS: String(config.retentionDays),
          BACKUP_WORK_ROOT: this.#backupDirectory
        }
      });
      await atomicJson(this.#statusPath, { state: "ready", lastStartedAt: startedAt, lastCompletedAt: new Date().toISOString(), lastError: null });
    } catch (error) {
      const message = String(error?.message || "Backup failed")
        .replaceAll(config.accessKeyId, "[redacted]")
        .replaceAll(config.secretAccessKey, "[redacted]")
        .slice(0, 500);
      await atomicJson(this.#statusPath, { state: "failed", lastStartedAt: startedAt, lastCompletedAt: new Date().toISOString(), lastError: message });
    } finally {
      this.#running = false;
      await unlink(temporaryConfig).catch(() => undefined);
    }
  }

  async restore(snapshot = "") {
    if (snapshot && !/^[0-9]{8}T[0-9]{6}Z$/.test(snapshot)) throw new Error("Snapshot must use YYYYMMDDTHHMMSSZ format");
    if (this.#running) throw new Error("A backup is currently running");
    const config = await this.#readConfig();
    const temporaryConfig = `/var/lib/orbitcid/rclone.${process.pid}.${randomBytes(6).toString("hex")}.conf`;
    try {
      const obscuredPassword = await run("rclone", ["obscure", this.#cryptPassword()], { env: process.env });
      const remotePath = `r2:${config.bucket}/${config.prefix}/${this.#pairing.connectionId}`;
      const contents = [
        "[r2]", "type = s3", "provider = Cloudflare",
        `access_key_id = ${config.accessKeyId}`,
        `secret_access_key = ${config.secretAccessKey}`,
        `endpoint = https://${config.accountId}.r2.cloudflarestorage.com`,
        "acl = private", "no_check_bucket = true", "",
        "[secure]", "type = crypt", `remote = ${remotePath}`,
        `password = ${obscuredPassword}`, "filename_encryption = standard", "directory_name_encryption = true", ""
      ].join("\n");
      await writeFile(temporaryConfig, contents, { mode: 0o600, flag: "wx" });
      return await run("/usr/local/bin/orbitcid-restore", snapshot ? [snapshot] : [], {
        env: {
          ...process.env,
          KUBO_API: this.#kuboApi,
          RCLONE_CONFIG: temporaryConfig,
          RCLONE_REMOTE: "secure:",
          BACKUP_WORK_ROOT: this.#backupDirectory
        }
      });
    } finally {
      await unlink(temporaryConfig).catch(() => undefined);
    }
  }
}
