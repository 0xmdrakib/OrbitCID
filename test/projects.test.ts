import { describe, expect, it } from "vitest";
import { contentIsPublic, projectSlugIsValid, requiresPublicPersistenceAcknowledgement } from "../src/project-policy";

describe("project publication policy", () => {
  it("requires an active project and enabled gateway", () => {
    expect(contentIsPublic({ projectState: "active", gatewayEnabled: true, defaultVisibility: "public" })).toBe(true);
    expect(contentIsPublic({ projectState: "active", gatewayEnabled: false, defaultVisibility: "public" })).toBe(false);
    expect(contentIsPublic({ projectState: "deleted", gatewayEnabled: true, defaultVisibility: "public" })).toBe(false);
  });

  it("applies per-CID visibility overrides", () => {
    expect(contentIsPublic({ projectState: "active", gatewayEnabled: true, defaultVisibility: "private", override: "public" })).toBe(true);
    expect(contentIsPublic({ projectState: "active", gatewayEnabled: true, defaultVisibility: "public", override: "private" })).toBe(false);
    expect(contentIsPublic({ projectState: "active", gatewayEnabled: true, defaultVisibility: "public", override: "inherit" })).toBe(true);
  });

  it("accepts immutable DNS-safe project slugs", () => {
    expect(projectSlugIsValid("agent-chain")).toBe(true);
    expect(projectSlugIsValid("Agent Chain")).toBe(false);
    expect(projectSlugIsValid("-agent")).toBe(false);
    expect(projectSlugIsValid("a")).toBe(true);
    expect(projectSlugIsValid("a".repeat(64))).toBe(false);
    expect(projectSlugIsValid("agent--chain")).toBe(true);
    expect(projectSlugIsValid("agent_chain")).toBe(false);
  });

  it("requires acknowledgement when public-by-default publishing becomes active", () => {
    expect(requiresPublicPersistenceAcknowledgement({ currentGatewayEnabled: false, currentDefaultVisibility: "public", nextGatewayEnabled: true, nextDefaultVisibility: "public" })).toBe(true);
    expect(requiresPublicPersistenceAcknowledgement({ currentGatewayEnabled: true, currentDefaultVisibility: "private", nextGatewayEnabled: true, nextDefaultVisibility: "public" })).toBe(true);
    expect(requiresPublicPersistenceAcknowledgement({ currentGatewayEnabled: true, currentDefaultVisibility: "public", nextGatewayEnabled: true, nextDefaultVisibility: "public" })).toBe(false);
    expect(requiresPublicPersistenceAcknowledgement({ currentGatewayEnabled: false, currentDefaultVisibility: "private", nextGatewayEnabled: true, nextDefaultVisibility: "private" })).toBe(false);
  });
});
