import { generateKeyPairSync, sign } from "node:crypto";
import { Buffer as NodeBuffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { newPairingCode, sha256, verifyBackendProof } from "../frontend/src/lib/security";

describe("Vercel to backend pairing proof", () => {
  it("uses a high-entropy, namespaced one-time code", () => {
    const first = newPairingCode();
    const second = newPairingCode();
    expect(first).toMatch(/^orb_pair_[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(sha256(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts proof from the submitted Ed25519 key and rejects tampering", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicJwk = publicKey.export({ format: "jwk" });
    const message = "claim\nhttps://node.example.com\nnonce\n123";
    const signature = NodeBuffer.from(sign(null, NodeBuffer.from(message), privateKey)).toString("base64url");
    expect(await verifyBackendProof(publicJwk, message, signature)).toBe(true);
    expect(await verifyBackendProof(publicJwk, `${message}tampered`, signature)).toBe(false);
  });
});
