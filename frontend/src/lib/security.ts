import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { Buffer as NodeBuffer } from "node:buffer";
import { exportJWK, importPKCS8, importSPKI, SignJWT, type JWK } from "jose";
import { serverEnv } from "./env";

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function newPairingCode() {
  return `orb_pair_${NodeBuffer.from(randomBytes(32)).toString("base64url")}`;
}

function privatePem() {
  const value = process.env.ORBITCID_GRANT_PRIVATE_KEY;
  if (!value) throw new Error("ORBITCID_GRANT_PRIVATE_KEY is not configured");
  return NodeBuffer.from(value, "base64").toString("utf8");
}

function publicPem() {
  const value = process.env.ORBITCID_GRANT_PUBLIC_KEY;
  if (!value) throw new Error("ORBITCID_GRANT_PUBLIC_KEY is not configured");
  return NodeBuffer.from(value, "base64").toString("utf8");
}

export async function grantPublicJwk(): Promise<JWK> {
  const key = await importSPKI(publicPem(), "EdDSA");
  return { ...(await exportJWK(key)), use: "sig", alg: "EdDSA", kid: process.env.ORBITCID_GRANT_KEY_ID || "orbitcid-1" };
}

export async function issueBackendGrant(input: { userId: string; connectionId: string; scopes: string[] }) {
  const env = serverEnv();
  const key = await importPKCS8(privatePem(), "EdDSA");
  return new SignJWT({ scope: input.scopes.join(" "), typ: "orbitcid-backend-grant" })
    .setProtectedHeader({ alg: "EdDSA", kid: process.env.ORBITCID_GRANT_KEY_ID || "orbitcid-1" })
    .setIssuer(env.baseUrl)
    .setSubject(input.userId)
    .setAudience(input.connectionId)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setNotBefore("-5s")
    .setExpirationTime("5m")
    .sign(key);
}

export async function verifyBackendProof(publicKey: JWK, message: string, signature: string) {
  if (publicKey.kty !== "OKP" || publicKey.crv !== "Ed25519" || typeof publicKey.x !== "string") return false;
  try {
    const key = createPublicKey({ key: publicKey as JsonWebKey, format: "jwk" });
    return verify(null, NodeBuffer.from(message), key, NodeBuffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}
