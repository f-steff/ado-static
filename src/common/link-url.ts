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

/** The project a bookmarklet falls back to when the page it is clicked on is not inside one. */
export interface BookmarkletTarget {
  org: string;
  project: string;
}

/**
 * The `javascript:` bookmarklet that hands the current page's URL to the Links hub, which opens the
 * signed-in member's **private** link form with it.
 *
 * Rationale: the About tab offers this as a link the user bookmarks (right-click -> Bookmark link), so
 * the code has to be built from the *installed* edition's ids - the released and development editions
 * differ only there - and has to be one self-contained expression, because a bookmarklet runs in
 * whatever page it is clicked on, not in the extension. It targets the Links hub rather than the
 * settings page because the result must be a private link, not a project link.
 *
 * Which project? The page's own project when it has one, so a page in another project lands there;
 * otherwise the `target` captured where the link was installed. That fallback is what makes a **fixed
 * link** work: its page is outside Azure DevOps, so there is no project to derive from the URL.
 *
 * Path segments are already percent-encoded in `location.pathname`, so they are used as-is (encoding
 * them again would double-encode a project name with a space). The target's ids are encoded once, here,
 * and embedded through `JSON.stringify` so a quote in a name cannot break the generated code.
 */
export function addLinkBookmarklet(
  publisherId: string,
  extensionId: string,
  target?: BookmarkletTarget
): string {
  const publisher = (publisherId || "").trim() || "f-steff";
  const extension = (extensionId || "").trim() || "static";
  const hub = `${publisher}.${extension}.static-links-hub`;
  const org = target && target.org ? target.org.trim() : "";
  const project = target && target.project ? target.project.trim() : "";
  // The fallback is emitted as source: a JSON string literal supplies the quotes and any escaping.
  const fallback =
    org && project
      ? `{o:${JSON.stringify(encodeURIComponent(org))},p:${JSON.stringify(encodeURIComponent(project))}}`
      : "null";
  return (
    "javascript:(()=>{" +
    "const s=location.pathname.split('/').filter(Boolean);" +
    // Only an Azure DevOps page carries a project. On any other host (a fixed link's page, for example)
    // the path says nothing, so the pinned target below must be used instead of a made-up project.
    "const a=/\\.visualstudio\\.com$/.test(location.host);" +
    "const d=location.host==='dev.azure.com';" +
    "const o=a?location.host.split('.')[0]:s[0];" +
    "const p=a?s[0]:(d?s[1]:undefined);" +
    // A segment starting with '_' names an organization page (_settings, _usersSettings, ...), not a
    // project, so it must not be mistaken for one.
    "const t=p&&p[0]!=='_'?{o:o,p:p}:" +
    fallback +
    ";" +
    "if(!t)return;" +
    "location.href='https://dev.azure.com/'+t.o+'/'+t.p+'/_apps/hub/" +
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
