import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

describe("recovery verifier", () => {
  it("decrypts authenticated pages, writes restore SQL, and rejects tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbitcid-recovery-"));
    try {
      const keyBytes = crypto.getRandomValues(new Uint8Array(32));
      const encodedKey = base64url(keyBytes);
      const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
      const encrypt = async (value: unknown, aad: string) => {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
          key,
          encoder.encode(JSON.stringify(value))
        ));
        return JSON.stringify({ version: 2, algorithm: "AES-256-GCM", aad, iv: base64url(iv), ciphertext: base64url(ciphertext) });
      };

      const pageKey = "snapshots/test/projects/000000.json.enc";
      const manifestKey = "snapshots/test/manifest.json.enc";
      await mkdir(join(root, "snapshots", "test", "projects"), { recursive: true });
      await writeFile(join(root, pageKey), await encrypt({ table: "projects", offset: 0, rows: [{ id: "default", name: "Default project" }] }, pageKey));
      await writeFile(join(root, manifestKey), await encrypt({ version: 2, createdAt: "2026-08-24T00:00:00.000Z", tables: [{ name: "projects", rows: 1, pages: [pageKey] }] }, manifestKey));

      const sqlPath = join(root, "restore.sql");
      const valid = spawnSync(process.execPath, ["scripts/verify-recovery.mjs", root, manifestKey, sqlPath], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, RECOVERY_KEY: encodedKey }
      });
      expect(valid.status, valid.stderr).toBe(0);
      expect(valid.stdout).toContain("Recovery snapshot verified: 1 encrypted metadata rows");
      expect(await readFile(sqlPath, "utf8")).toContain('INSERT OR REPLACE INTO "projects"');

      const envelope = JSON.parse(await readFile(join(root, pageKey), "utf8"));
      envelope.ciphertext = `${envelope.ciphertext.slice(0, -1)}${envelope.ciphertext.endsWith("A") ? "B" : "A"}`;
      await writeFile(join(root, pageKey), JSON.stringify(envelope));
      const tampered = spawnSync(process.execPath, ["scripts/verify-recovery.mjs", root, manifestKey], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, RECOVERY_KEY: encodedKey }
      });
      expect(tampered.status).not.toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
