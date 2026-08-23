export type Visibility = "private" | "public";
export type VisibilityOverride = "inherit" | Visibility | null | undefined;

export function contentIsPublic(input: {
  projectState: "active" | "deleted" | string;
  gatewayEnabled: boolean;
  defaultVisibility: Visibility;
  override?: VisibilityOverride;
}): boolean {
  const visibility = input.override && input.override !== "inherit" ? input.override : input.defaultVisibility;
  return input.projectState === "active" && input.gatewayEnabled && visibility === "public";
}

export function projectSlugIsValid(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

export function requiresPublicPersistenceAcknowledgement(input: {
  currentGatewayEnabled: boolean;
  currentDefaultVisibility: Visibility;
  nextGatewayEnabled: boolean;
  nextDefaultVisibility: Visibility;
}): boolean {
  const wasPublicByDefault = input.currentGatewayEnabled && input.currentDefaultVisibility === "public";
  const willBePublicByDefault = input.nextGatewayEnabled && input.nextDefaultVisibility === "public";
  return willBePublicByDefault && !wasPublicByDefault;
}