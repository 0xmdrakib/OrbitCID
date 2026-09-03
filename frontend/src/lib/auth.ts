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
    user: {
      fields: {
        emailVerified: "email_verified",
        createdAt: "created_at",
        updatedAt: "updated_at"
      }
    },
    session: {
      fields: {
        userId: "user_id",
        expiresAt: "expires_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        createdAt: "created_at",
        updatedAt: "updated_at"
      },
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 60 * 5, strategy: "jwe" }
    },
    account: {
      fields: {
        providerId: "provider_id",
        accountId: "account_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at"
      }
    },
    verification: {
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at"
      }
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
