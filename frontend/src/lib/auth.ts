import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { serverEnv } from "./env";

function buildAuth() {
  const env = serverEnv();
  return betterAuth({
    appName: "OrbitCID",
    baseURL: env.baseUrl,
    secret: env.authSecret,
    database: new Pool({ connectionString: env.databaseUrl, max: 4, idleTimeoutMillis: 20_000, allowExitOnIdle: true }),
    trustedOrigins: env.trustedOrigins,
    socialProviders: {
      google: {
        clientId: env.googleClientId,
        clientSecret: env.googleClientSecret,
        prompt: "select_account"
      }
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 60 * 5, strategy: "jwe" }
    },
    advanced: {
      cookiePrefix: "orbitcid",
      useSecureCookies: process.env.NODE_ENV === "production",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" }
    }
  });
}

let instance: ReturnType<typeof buildAuth> | null = null;

export function getAuth(): ReturnType<typeof buildAuth> {
  instance ??= buildAuth();
  return instance;
}
