const levels = ["info", "low", "moderate", "high", "critical"];

export function classifyAuditResult({ code, stdout, stderr }, threshold = "high") {
  if (!levels.includes(threshold)) throw new Error("Invalid audit threshold");
  let report;
  try { report = JSON.parse(stdout); } catch { report = null; }
  const counts = report?.metadata?.vulnerabilities;
  const validCounts = counts && levels.every((level) => Number.isInteger(counts[level]) && counts[level] >= 0);

  if (validCounts && !report.error) {
    if (levels.slice(levels.indexOf(threshold)).some((level) => counts[level] > 0)) return "vulnerable";
    return code === 0 ? "pass" : "failure";
  }

  const message = `${stdout}\n${stderr}`;
  const transient = /\b(?:EAI_AGAIN|ECONNRESET|ENETUNREACH|ETIMEDOUT|ECONNREFUSED|E503)\b|network timeout|service unavailable|\bHTTP\s+50[0234]\b|\"statusCode\"\s*:\s*50[0234]/i.test(message);
  return transient ? "retry" : "failure";
}
