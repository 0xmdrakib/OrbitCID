import { describe, expect, it } from "vitest";
import { clampPartSize, normalizePath } from "../src/utils";

describe("request safety utilities", () => {
  it("normalizes safe paths", () => {
    expect(normalizePath("/folder/hello%20world.txt")).toBe("/folder/hello world.txt");
    expect(normalizePath("/")).toBe("/");
  });

  it("rejects traversal and Windows separator paths", () => {
    expect(() => normalizePath("/safe/../secret")).toThrow();
    expect(() => normalizePath("/safe\\secret")).toThrow();
  });

  it("keeps multipart sizes aligned and bounded", () => {
    expect(clampPartSize(100, 1)).toBe(5 * 1024 * 1024);
    expect(clampPartSize(100, 100 * 1024 * 1024)).toBe(64 * 1024 * 1024);
    expect(clampPartSize(100, 7_000_000) % (1024 * 1024)).toBe(0);
  });
});