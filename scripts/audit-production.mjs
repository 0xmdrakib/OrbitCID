import { spawn } from "node:child_process";
import { classifyAuditResult } from "./audit-policy.mjs";

const attempts = 3;
const allDependencies = process.argv.includes("--all");
const threshold = allDependencies ? "moderate" : "high";
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this audit through npm run audit:production");

function runAudit() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli,
      "audit",
      allDependencies ? "--include=dev" : "--omit=dev",
      `--audit-level=${threshold}`,
      "--json",
      "--fetch-retries=0",
      "--fetch-timeout=30000"
    ], { stdio: ["ignore", "pipe", "pipe"], timeout: 70_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const result = await runAudit();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const outcome = classifyAuditResult(result, threshold);
  if (outcome === "pass") process.exit(0);
  if (outcome === "vulnerable") {
    process.stderr.write("Dependency audit found vulnerabilities at or above the configured threshold.\n");
    process.exit(1);
  }

  if (outcome !== "retry") {
    process.stderr.write("Dependency audit did not return a valid successful security report.\n");
    process.exit(1);
  }
  if (attempt < attempts) {
    process.stderr.write(`Dependency audit service attempt ${attempt} failed; retrying…\n`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
  }
}

process.stderr.write("::error::The npm audit service was unavailable after 3 bounded attempts; dependency security could not be verified.\n");
process.exitCode = 1;
