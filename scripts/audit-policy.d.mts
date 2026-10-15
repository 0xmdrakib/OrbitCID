export function classifyAuditResult(result: { code: number; stdout: string; stderr: string }, threshold?: string): "pass" | "vulnerable" | "retry" | "failure";
