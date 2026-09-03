import { readFile } from "node:fs/promises";
import { R2BackupManager } from "./r2-backup.mjs";

const pairingPath = process.env.PAIRING_CONFIG_PATH || "/var/lib/orbitcid/pairing.json";
const pairing = JSON.parse(await readFile(pairingPath, "utf8"));
const manager = new R2BackupManager(pairing, { kuboApi: process.env.KUBO_API || "http://kubo:5001" });
const output = await manager.restore(process.argv[2] || "");
process.stdout.write(`${output}\n`);
