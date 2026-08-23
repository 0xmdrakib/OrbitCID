import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const ignoredDirectories = new Set([".git", ".wrangler", ".terraform", "node_modules", "dist", "coverage", "assets"]);
const ignoredFiles = new Set([".dev.vars", ".env"]);
const textExtensions = new Set(["", ".cjs", ".css", ".html", ".js", ".json", ".jsonc", ".md", ".mjs", ".sql", ".tf", ".tftpl", ".ts", ".tsx", ".txt", ".yaml", ".yml"]);

const forbidden = [
  { name: "development authentication bypass", pattern: /\bDEV_TOKEN\b|ipfs_dev_token|decodeJwtPayload/ },
  { name: "operator-specific domain", pattern: /rakibhq\.xyz/i },
  { name: "operator-specific Cloudflare account", pattern: /a9f90ea73d239ad09fcb5bbcb5534ee9|6a5012e2becb7c4f4ff5bb9539a500ad/i },
  { name: "operator email", pattern: /0xmdrakib@gmail\.com/i },
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ }
];

async function collect(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    if (entry.isFile() && ignoredFiles.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(path));
    else if (entry.isFile() && textExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

const failures = [];
for (const path of await collect(root)) {
  const name = relative(root, path).replaceAll("\\", "/");
  if (name === "scripts/check-public-release.mjs") continue;
  if (name.endsWith(".tfvars") && !name.endsWith(".tfvars.example")) failures.push(`${name}: deploy-time tfvars must not be published`);
  const content = await readFile(path, "utf8");
  for (const rule of forbidden) if (rule.pattern.test(content)) failures.push(`${name}: ${rule.name}`);
}

if (failures.length) {
  console.error("Public-release safety check failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("Public-release safety check passed.");
}
