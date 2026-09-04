import { spawn } from "node:child_process";

const attempts = 3;
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this audit through npm run audit:production");

function runAudit() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli,
      "audit",
      "--omit=dev",
      "--audit-level=high",
      "--json",
      "--fetch-retries=0",
      "--fetch-timeout=30000"
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const result = await runAudit();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.code === 0) process.exit(0);

  let report;
  try { report = JSON.parse(result.stdout); } catch { report = null; }
  if (report?.metadata?.vulnerabilities) {
    process.stderr.write("Production dependency audit found vulnerabilities at or above the configured threshold.\n");
    process.exit(1);
  }

  const transientRegistryFailure = /(?:EAI_AGAIN|ECONNRESET|ENETUNREACH|ETIMEDOUT|network timeout|service unavailable|audit endpoint returned an error|\b50[0234]\b)/i.test(`${result.stdout}\n${result.stderr}`);
  if (!transientRegistryFailure) {
    process.stderr.write("Production dependency audit failed for a non-network reason.\n");
    process.exit(1);
  }
  if (attempt < attempts) {
    process.stderr.write(`Production dependency audit service attempt ${attempt} failed; retrying…\n`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
  }
}

process.stdout.write("::warning::The npm audit service was unavailable after 3 bounded attempts; no dependency result was suppressed. Retry this workflow when the registry recovers.\n");
