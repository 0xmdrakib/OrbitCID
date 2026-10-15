import { describe, expect, it } from "vitest";
import { classifyAuditResult } from "../scripts/audit-policy.mjs";

function result(counts: Record<string, number> = {}, code = 0) {
  return { code, stderr: "", stdout: JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...counts } } }) };
}

describe("dependency audit security gate", () => {
  it("requires a valid successful audit before passing", () => {
    expect(classifyAuditResult(result())).toBe("pass");
    expect(classifyAuditResult({ code: 0, stdout: "", stderr: "" })).toBe("failure");
    expect(classifyAuditResult({ code: 0, stdout: "{}", stderr: "" })).toBe("failure");
    expect(classifyAuditResult(result({}, 1))).toBe("failure");
  });

  it("blocks actual vulnerabilities even if the process returned success", () => {
    expect(classifyAuditResult(result({ critical: 1 }))).toBe("vulnerable");
    expect(classifyAuditResult(result({ high: 1 }, 1))).toBe("vulnerable");
    expect(classifyAuditResult(result({ moderate: 1 }), "moderate")).toBe("vulnerable");
    expect(classifyAuditResult(result({ low: 1 }), "moderate")).toBe("pass");
  });

  it("retries transient service failures without treating them as a clean audit", () => {
    expect(classifyAuditResult({ code: 1, stdout: "", stderr: "network timeout" })).toBe("retry");
    expect(classifyAuditResult({ code: 1, stdout: '{"error":{"code":"E503","summary":"Service Unavailable"}}', stderr: "" })).toBe("retry");
    expect(classifyAuditResult({ code: 1, stdout: "", stderr: "audit endpoint returned an error" })).toBe("failure");
  });
});
