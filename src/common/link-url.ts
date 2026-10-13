// Validation for "fixed" links (URLs that are not necessarily inside the current project).
//
// Rationale: the in-project builder cannot represent every target, and a pipeline may publish a
// link to an external artifact/report. Such links are stored as "fixed": we still require an
// absolute http(s) URL (never `javascript:`/`data:`), but not that it points at this Azure DevOps
// project. Pure, so it is unit-testable.

/** Returns an error message for a fixed URL, or "" when it is acceptable. */
export function fixedUrlError(url: string): string {
  const value = (url || "").trim();
  if (!value) {
    return "Enter the URL for the fixed link.";
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    return "That is not a valid URL.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Only http(s) URLs are allowed.";
  }
  return "";
}

/** True when the value is an absolute http(s) URL (used to auto-pick the fixed area on paste). */
export function isHttpUrl(url: string): boolean {
  return fixedUrlError(url) === "";
}

/**
 * A short Area label for a stored link, matching the builder's area vocabulary
 * (Repo, PR, Pipeline, Artifact, Fixed). Derived from the URL so it is stable for old links; the
 * stored `area` wins when it is "fixed".
 */
export function linkAreaLabel(url: string, area?: string): string {
  const value = url || "";
  if (area === "fixed") {
    return "Fixed";
  }
  if (/\/pullrequest\//i.test(value)) {
    return "PR";
  }
  if (/\/_build(?:[/?]|$)/i.test(value)) {
    return "Pipeline";
  }
  if (/\/_artifacts?\//i.test(value) || /\/_packaging\//i.test(value)) {
    return "Artifact";
  }
  if (/\/_git\//i.test(value)) {
    return "Repo";
  }
  // In-project but not one of the modelled shapes: stored as a fixed link.
  return "Fixed";
}
