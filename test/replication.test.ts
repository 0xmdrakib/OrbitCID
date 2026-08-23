import { describe, expect, it } from "vitest";
import { createReplicationTicket, verifyReplicationTicket } from "../src/replication-ticket";
import type { Env } from "../src/types";

const env = { REPLICATION_SIGNING_SECRET: "test-only-secret-with-more-than-32-bytes" } as Env;

describe("replication tickets", () => {
  it("binds a signed ticket to its project and CID", async () => {
    const ticket = await createReplicationTicket(env, "project-a", "bafy-root");
    await expect(verifyReplicationTicket(env, ticket, "bafy-root")).resolves.toMatchObject({ projectId: "project-a", cid: "bafy-root" });
    await expect(verifyReplicationTicket(env, ticket, "bafy-other")).resolves.toBeNull();
  });

  it("rejects modified signatures and missing secrets", async () => {
    const ticket = await createReplicationTicket(env, "project-a", "bafy-root");
    const tampered = `${ticket.slice(0, -1)}${ticket.endsWith("A") ? "B" : "A"}`;
    await expect(verifyReplicationTicket(env, tampered, "bafy-root")).resolves.toBeNull();
    await expect(verifyReplicationTicket({} as Env, ticket, "bafy-root")).resolves.toBeNull();
  });
});
