import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { Buffer as NodeBuffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { GrantVerifier } from "../backend/grant-auth.mjs";

function token(privateKey: KeyObject, payload: Record<string, unknown>, kid = "qa-key") {
  const header = NodeBuffer.from(JSON.stringify({ alg: "EdDSA", kid })).toString("base64url");
  const body = NodeBuffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = NodeBuffer.from(sign(null, NodeBuffer.from(`${header}.${body}`), privateKey)).toString("base64url");
  return `${header}.${body}.${signature}`;
}

describe("portable backend grants", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pairing = { issuer: "https://app.example.com", ownerId: "owner-12345678", audience: "12345678-1234-4234-8234-123456789abc", grantKeys: [{ ...publicKey.export({ format: "jwk" }), kid: "qa-key" }] };
  const now = 2_000_000_000;
  const validPayload = { typ: "orbitcid-backend-grant", iss: pairing.issuer, sub: pairing.ownerId, aud: pairing.audience, scope: "read write", jti: "12345678-1234-4234-8234-123456789abc", iat: now, nbf: now - 1, exp: now + 300 };

  it("binds a grant to owner, backend audience, signature and scope", () => {
    expect(new GrantVerifier(pairing).authorize(token(privateKey, validPayload), "read", { now })).not.toBeNull();
    expect(new GrantVerifier(pairing).authorize(token(privateKey, { ...validPayload, sub: "other-user" }), "read", { now })).toBeNull();
    expect(new GrantVerifier(pairing).authorize(token(privateKey, { ...validPayload, aud: "other-backend" }), "read", { now })).toBeNull();
    expect(new GrantVerifier(pairing).authorize(token(privateKey, validPayload), "pin", { now })).toBeNull();
  });

  it("consumes mutation JTIs once", () => {
    const verifier = new GrantVerifier(pairing);
    const grant = token(privateKey, validPayload);
    expect(verifier.authorize(grant, "write", { now, consume: true })).not.toBeNull();
    expect(verifier.authorize(grant, "write", { now, consume: true })).toBeNull();
  });
});
