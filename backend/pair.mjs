import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";

const frontend = new URL(process.env.ORBITCID_FRONTEND_ORIGIN || "");
const endpoint = new URL(process.env.ORBITCID_BACKEND_PUBLIC_URL || "");
const configPath = process.env.PAIRING_CONFIG_PATH || "/var/lib/orbitcid/pairing.json";
if (frontend.protocol !== "https:" && !(frontend.protocol === "http:" && ["localhost", "127.0.0.1"].includes(frontend.hostname))) throw new Error("ORBITCID_FRONTEND_ORIGIN must be an HTTPS origin");
if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1"].includes(endpoint.hostname))) throw new Error("ORBITCID_BACKEND_PUBLIC_URL must be an HTTPS origin");

try {
  await readFile(configPath);
  if (!process.argv.includes("--replace")) throw new Error(`A pairing already exists at ${configPath}. Revoke it in the frontend, then use --replace deliberately.`);
} catch (error) {
  if (error?.code !== "ENOENT" && !String(error?.message).includes("pairing already exists")) throw error;
  if (String(error?.message).includes("pairing already exists")) throw error;
}

const terminal = createInterface({ input: process.stdin, output: process.stdout });
const code = (process.env.ORBITCID_PAIRING_CODE || await terminal.question("Paste the one-time OrbitCID pairing code: ")).trim();
terminal.close();
if (!/^orb_pair_[A-Za-z0-9_-]{40,}$/.test(code)) throw new Error("Pairing code format is invalid");

const expectedJwksUri = new URL("/api/.well-known/orbitcid-jwks.json", frontend);
const jwksResponse = await fetch(expectedJwksUri, { redirect: "error", signal: AbortSignal.timeout(15_000) });
if (!jwksResponse.ok) throw new Error("Could not download the frontend grant keys");
const jwks = await jwksResponse.json();
if (!Array.isArray(jwks.keys) || !jwks.keys.length) throw new Error("Frontend JWKS contains no signing key");

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateJwk = privateKey.export({ format: "jwk" });
const publicJwk = publicKey.export({ format: "jwk" });
const timestamp = Date.now();
const nonce = randomBytes(24).toString("base64url");
const message = `${code}\n${endpoint.origin}\n${nonce}\n${timestamp}`;
const signature = sign(null, Buffer.from(message), createPrivateKey({ key: privateJwk, format: "jwk" })).toString("base64url");

const claim = await fetch(new URL("/api/pairing/claim", frontend), {
  method: "POST",
  headers: { "Content-Type": "application/json", "User-Agent": "OrbitCID-Backend/0.2" },
  body: JSON.stringify({ code, endpoint: endpoint.origin, nonce, timestamp, publicKey: publicJwk, signature }),
  redirect: "error",
  signal: AbortSignal.timeout(30_000)
});
const result = await claim.json().catch(() => ({}));
if (!claim.ok) throw new Error(result?.error?.message || `Pairing failed with HTTP ${claim.status}`);
if (result.frontendOrigin !== frontend.origin || result.issuer !== frontend.origin || result.jwksUri !== expectedJwksUri.href) {
  throw new Error("Frontend returned inconsistent pairing metadata");
}

const config = {
  version: 1,
  connectionId: result.connectionId,
  ownerId: result.ownerId,
  issuer: result.issuer,
  audience: result.audience,
  frontendOrigin: result.frontendOrigin,
  jwksUri: result.jwksUri,
  grantKeys: jwks.keys,
  backendPublicKey: publicJwk,
  backendPrivateKey: privateJwk,
  pairedAt: new Date().toISOString()
};
await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
const temporary = `${configPath}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
await rename(temporary, configPath);
process.stdout.write(`Paired successfully as connection ${result.connectionId}.\nThe private configuration was written with mode 0600.\n`);
