import { generateKeyPairSync, randomBytes } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
process.stdout.write(`ORBITCID_GRANT_PRIVATE_KEY=${Buffer.from(privateKey).toString("base64")}\n`);
process.stdout.write(`ORBITCID_GRANT_PUBLIC_KEY=${Buffer.from(publicKey).toString("base64")}\n`);
process.stdout.write(`ORBITCID_GRANT_KEY_ID=${randomBytes(12).toString("hex")}\n`);
