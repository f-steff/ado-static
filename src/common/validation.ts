/**
 * Pure validation/URL helpers shared by the UIs.
 *
 * Rationale: keeping these free of DOM/SDK dependencies makes them unit-testable without the
 * Azure DevOps host (see tests/logic.test.ts).
 */

// Slug rule: lowercase alphanumerics separated by single hyphens (docs/02 FR-URL-4).
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Slugs that would collide with reserved platform/extension routes (docs/05, "Reserved and
// edge-case slugs"). Kept lowercase; comparison is case-insensitive.
export const RESERVED_SLUGS = ["static"];

/**
 * Returns a validation message for a slug, or an empty string when acceptable.
 *
 * @param slug Incoming slug (may be empty while the user is still typing).
 * @param existing Slugs already used by other records.
 * @param allowExisting True while editing an existing record (its own slug may be unchanged).
 * @param noun What the record is called in the message ("page" for pages, "link" for links).
 */
export function slugError(slug: string, existing: string[], allowExisting: boolean, noun = "page"): string {
  const value = (slug || "").trim();
  // Empty is "not yet valid" rather than "invalid", so no red error is shown while typing.
  if (!value) {
    return "";
  }
  if (!SLUG_PATTERN.test(value)) {
    return "Slug must be lowercase letters/numbers separated by single hyphens.";
  }
  // Reserved slugs are only rejected for new records; an existing one may keep its own slug.
  if (!allowExisting && RESERVED_SLUGS.includes(value)) {
    return "That slug is reserved.";
  }
  if (!allowExisting && existing.some((candidate) => candidate.toLowerCase() === value.toLowerCase())) {
    return `A ${noun} with that slug already exists.`;
  }
  return "";
}

/**
 * Builds the Feature Management URL for a project-scoped feature state.
 *
 * Rationale: the route order is `.../FeatureStates/{userScope}/{scopeName}/{scopeValue}/{featureId}`
 * (verified against the SDK's FeatureManagementRestClient); `userScope` "host" means all
 * users, and scopeName "project" targets one project. Extracted here so it can be tested.
 */
export function featureStateUrl(organization: string, projectId: string, featureId: string): string {
  return `https://dev.azure.com/${organization}/_apis/FeatureManagement/FeatureStates/host/project/${projectId}/${featureId}?api-version=7.2-preview.1`;
}

/**
 * Converts arbitrary text into a slug (lowercase alphanumerics separated by single hyphens).
 * Rationale: used to pre-fill a sensible, valid slug when a link is created from a repo shortcut.
 */
export function slugify(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
