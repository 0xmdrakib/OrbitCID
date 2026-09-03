const REQUIRED = [
  "BETTER_AUTH_URL",
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "DATABASE_URL",
  "TENANT_DATABASE_URL"
] as const;

export function serverEnv() {
  const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Missing server environment variables: ${missing.join(", ")}`);
  const baseUrl = new URL(process.env.BETTER_AUTH_URL!);
  if (process.env.NODE_ENV === "production" && baseUrl.protocol !== "https:") throw new Error("BETTER_AUTH_URL must use HTTPS in production");
  return {
    baseUrl: baseUrl.origin,
    authSecret: process.env.BETTER_AUTH_SECRET!,
    googleClientId: process.env.GOOGLE_CLIENT_ID!,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    databaseUrl: process.env.DATABASE_URL!,
    tenantDatabaseUrl: process.env.TENANT_DATABASE_URL!,
    trustedOrigins: [baseUrl.origin, ...(process.env.TRUSTED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean)]
  };
}
