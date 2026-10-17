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
  } catch {
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
 * The URL to pre-fill the link form with, or "" when the value is not usable.
 *
 * Rationale: the settings page accepts `?url=<page url>` so that a bookmarklet - or a plain link from a
 * wiki or a pipeline - can hand it the page the user is looking at. Only absolute http(s) URLs are
 * accepted, so a crafted query string cannot inject a `javascript:` or `data:` target into the form,
 * and a length cap keeps a pathological value out of the address bar and the form.
 */
export function acceptablePrefillUrl(value: unknown): string {
  const url = typeof value === "string" ? value.trim() : "";
  return url.length > 0 && url.length <= 2000 && isHttpUrl(url) ? url : "";
}

/**
 * The `javascript:` bookmarklet that hands the current page's URL to the project settings page.
 *
 * Rationale: the About tab offers this as a link the user bookmarks (right-click -> Bookmark link), so
 * the code has to be built from the *installed* edition's ids - the released and development editions
 * differ only there - and has to be one self-contained expression, because a bookmarklet runs in
 * whatever page it is clicked on, not in the extension. The hub is the project settings page, which is
 * where the link form lives. The path segments are already percent-encoded in `location.pathname`, so
 * they are concatenated as-is (encoding them again would double-encode a project name with a space).
 */
export function addLinkBookmarklet(publisherId: string, extensionId: string): string {
  const publisher = (publisherId || "").trim() || "f-steff";
  const extension = (extensionId || "").trim() || "static";
  const hub = `${publisher}.${extension}.static-admin-hub`;
  // On dev.azure.com the first path segment is the organization; on the legacy {org}.visualstudio.com
  // host the organization is the first label of the host and the first segment is already the project.
  return (
    "javascript:(()=>{" +
    "const s=location.pathname.split('/').filter(Boolean);" +
    "const o=/\\.visualstudio\\.com$/.test(location.host)?location.host.split('.')[0]:s.shift();" +
    "const p=s.shift()||'';" +
    "if(!p)return;" +
    "location.href='https://dev.azure.com/'+o+'/'+p+'/_settings/" +
    hub +
    "?url='+encodeURIComponent(location.href)" +
    "})()"
  );
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
