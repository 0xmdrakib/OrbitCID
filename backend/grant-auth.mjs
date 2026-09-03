import { createPublicKey, verify } from "node:crypto";

function decodePart(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

export class GrantVerifier {
  #pairing;
  #consumed = new Map();

  constructor(pairing) { this.#pairing = pairing; }

  authorize(token, requiredScope, options = {}) {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    try {
      const header = decodePart(parts[0]);
      const payload = decodePart(parts[1]);
      if (header.alg !== "EdDSA" || typeof header.kid !== "string") return null;
      const jwk = this.#pairing.grantKeys.find((candidate) => candidate.kid === header.kid && candidate.kty === "OKP" && candidate.crv === "Ed25519");
      if (!jwk || !verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url"))) return null;
      const now = options.now ?? Math.floor(Date.now() / 1000);
      const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (payload.typ !== "orbitcid-backend-grant" || payload.iss !== this.#pairing.issuer || payload.sub !== this.#pairing.ownerId || !audiences.includes(this.#pairing.audience)) return null;
      if (!Number.isFinite(payload.exp) || payload.exp <= now || payload.exp > now + 360 || (payload.nbf && payload.nbf > now + 10) || (payload.iat && payload.iat > now + 10)) return null;
      const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [];
      if (!scopes.includes(requiredScope) || typeof payload.jti !== "string" || !/^[A-Za-z0-9-]{20,80}$/.test(payload.jti)) return null;
      if (options.consume) {
        for (const [jti, expires] of this.#consumed) if (expires <= now) this.#consumed.delete(jti);
        if (this.#consumed.has(payload.jti)) return null;
        this.#consumed.set(payload.jti, payload.exp);
      }
      return payload;
    } catch { return null; }
  }
}
