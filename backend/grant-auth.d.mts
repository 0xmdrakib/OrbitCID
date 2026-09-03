export interface BackendPairing {
  issuer: string;
  ownerId: string;
  audience: string;
  grantKeys: JsonWebKey[];
}

export class GrantVerifier {
  constructor(pairing: BackendPairing);
  authorize(token: string, requiredScope: string, options?: { now?: number; consume?: boolean }): Record<string, unknown> | null;
}
