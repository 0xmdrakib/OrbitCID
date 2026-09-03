import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { R2BackupManager } from "../backend/r2-backup.mjs";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("optional R2 backup configuration", () => {
  it("encrypts credentials locally and exposes only safe status metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbitcid-r2-"));
    directories.push(directory);
    const { privateKey } = generateKeyPairSync("ed25519");
    const pairing = {
      connectionId: "12345678-1234-4234-8234-123456789abc",
      backendPrivateKey: privateKey.export({ format: "jwk" })
    };
    const configPath = join(directory, "backup.enc.json");
    const manager = new R2BackupManager(pairing, { configPath, statusPath: join(directory, "status.json") });
    const secret = "secret-access-key-that-never-appears-in-the-file";
    const status = await manager.save({
      accountId: "0123456789abcdef0123456789abcdef",
      accessKeyId: "access_key_1234567890",
      secretAccessKey: secret,
      bucket: "orbitcid-backup",
      prefix: "owner/backups",
      retentionDays: 30
    });

    const stored = await readFile(configPath, "utf8");
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain("access_key_1234567890");
    expect(status).toMatchObject({ configured: true, provider: "cloudflare-r2", bucket: "orbitcid-backup", prefix: "owner/backups", retentionDays: 30 });
    expect(JSON.stringify(status)).not.toContain(secret);

    expect(await manager.remove()).toMatchObject({ configured: false, state: "not_configured" });
  });
});
