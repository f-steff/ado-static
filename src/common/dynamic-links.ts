// Dynamic-link token helpers.
//
// Rationale: a "static" link may point at a target that changes over time (the latest build, the
// newest open PR, the tip of a branch). Such a link stores a URL containing the token
// `{{dyn}}` plus a small spec describing how to resolve it, and the token is replaced with the
// current value when the link is used. Pure, so the paste/parse logic is unit-testable.

export const DYNAMIC_TOKEN = "{{dyn}}";
// Placeholders for a log target that is resolved against the build chosen at access time.
export const LOG_STAGE_TOKEN = "{{stage}}";
export const LOG_JOB_TOKEN = "{{job}}";
export const LOG_TASK_TOKEN = "{{task}}";

export type DynamicKind = "build" | "pr" | "commit";

/** How "latest" is interpreted for a build link. */
export type DynamicBuildMode = "latest" | "latest-succeeded" | "latest-failed";

/** Which open pull request to pick. */
export type DynamicPrScope = "newest-open" | "oldest-open";

/**
 * A log target stored by name (not id) so it can be found in whichever build the dynamic part
 * resolves to. `view` is usually "logs".
 */
export interface LogTarget {
  view?: string;
  stage?: string;
  job?: string;
  task?: string;
}

/** Describes how to resolve the dynamic part of a link. */
export interface DynamicSpec {
  kind: DynamicKind;
  // build
  buildMode?: DynamicBuildMode;
  definitionId?: number;
  // A log target resolved by name against the resolved build (dynamic builds only).
  logTarget?: LogTarget;
  // pr
  prScope?: DynamicPrScope;
  // repo (pr/commit) and branch (commit/build)
  repositoryId?: string;
  branch?: string;
  // Concrete value captured when the link was created; used when resolution is unavailable.
  fallback?: string;
}

/** The concrete part of a URL that a dynamic link replaces (buildId, a PR id, or a commit). */
export interface DynamicPart {
  param: "buildId" | "pullRequestId" | "commit";
  value: string;
}

/** True when the URL contains the dynamic token. */
export function hasToken(url: string): boolean {
  return (url || "").indexOf(DYNAMIC_TOKEN) >= 0;
}

/**
 * True when the URL contains any dynamic OR log placeholder. Rationale: a link may carry only
 * `{{stage}}`/`{{job}}`/`{{task}}` (a concrete build's log target), so validation and editing must
 * not treat that as "no placeholder".
 */
export function hasAnyToken(url: string): boolean {
  const value = url || "";
  return (
    value.indexOf(DYNAMIC_TOKEN) >= 0 ||
    value.indexOf(LOG_STAGE_TOKEN) >= 0 ||
    value.indexOf(LOG_JOB_TOKEN) >= 0 ||
    value.indexOf(LOG_TASK_TOKEN) >= 0
  );
}

/** Replaces every occurrence of the dynamic token with a resolved value. */
export function applyToken(url: string, value: string): string {
  return (url || "").split(DYNAMIC_TOKEN).join(value);
}

/**
 * Restores literal `{{...}}` tokens if they were percent-encoded (e.g. a pasted or hand-edited
 * URL). Rationale: resolution matches the literal token text, so `%7B%7Bdyn%7D%7D` must be decoded
 * or the link would silently keep a placeholder.
 */
export function normalizeTokens(url: string): string {
  return (url || "")
    .replace(/%7B%7B(dyn|stage|job|task)%7D%7D/gi, (_match, name: string) => `{{${name.toLowerCase()}}}`);
}

/**
 * Replaces the dynamic and log placeholders with resolved values. A token whose value is null/
 * empty is dropped together with its query parameter, so a missing stage/job/task never leaves a
 * dangling `&s={{stage}}` in the URL. Pure, so the replacement rules are unit-testable.
 */
export function applyTokens(
  url: string,
  values: Record<string, string | null | undefined>
): string {
  let out = url || "";
  Object.keys(values).forEach((token) => {
    const value = values[token];
    if (value == null || value === "") {
      // Remove the whole parameter that carries this unresolved token ("&name={{token}}").
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`&[^?&=]+=${escaped}(?=&|$)`, "g"), "");
    }
  });
  Object.keys(values).forEach((token) => {
    const value = values[token];
    if (value != null && value !== "") {
      out = out.split(token).join(value);
    }
  });
  return out;
}

/** Detects the concrete value a dynamic link would replace (for the paste-to-configure UX). */
export function detectDynamicPart(url: string): DynamicPart | null {
  const build = (url || "").match(/[?&]buildId=(\d+)/);
  if (build) {
    return { param: "buildId", value: build[1] };
  }
  const pr = (url || "").match(/\/pullrequest\/(\d+)/);
  if (pr) {
    return { param: "pullRequestId", value: pr[1] };
  }
  const commit = (url || "").match(/\/commit\/([0-9a-f]{7,40})/i);
  if (commit) {
    return { param: "commit", value: commit[1] };
  }
  return null;
}

/** Replaces the detected concrete value in the URL with the dynamic token. */
export function tokenizeUrl(url: string, part: DynamicPart): string {
  if (part.param === "buildId") {
    return (url || "").replace(new RegExp("([?&]buildId=)" + part.value + "\\b"), "$1" + DYNAMIC_TOKEN);
  }
  if (part.param === "pullRequestId") {
    return (url || "").replace("/pullrequest/" + part.value, "/pullrequest/" + DYNAMIC_TOKEN);
  }
  if (part.param === "commit") {
    return (url || "").replace("/commit/" + part.value, "/commit/" + DYNAMIC_TOKEN);
  }
  return url;
}
