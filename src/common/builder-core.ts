// Pure core of the cascading link builder (no Azure DevOps SDK imports).
//
// Rationale: the option types, URL composition and the static view mapping are pure logic that
// the unit tests exercise in Node (where `window` does not exist). Keeping them free of the SDK
// lets the tests run without a browser while link-builder.ts adds the ADO-backed child loaders.

import { DynamicSpec } from "./dynamic-links";

/** One choice in a cascading builder path. */
export interface BuilderOption {
  /** Unique key within its parent (used for memory/caching). */
  key: string;
  label: string;
  /** URL fragment this option appends to the base URL (may be empty for grouping options). */
  url?: string;
  /** True when choosing this option yields a valid link URL. */
  terminal?: boolean;
  /** Dynamic spec implied by choosing this option (merged down the path). */
  dynamic?: DynamicSpec;
  /**
   * Log-target names (stage/job/task) for a "Logs:" option. Rationale: when the build becomes
   * dynamic (latest/...), the concrete per-build ids are replaced by placeholders and these names
   * are resolved against the build chosen at access time.
   */
  names?: { stage?: string; job?: string; task?: string };
  /** Loads the next level of options (absent = leaf). */
  loadChildren?: () => Promise<BuilderOption[]>;
}

/** The result of a (possibly partial) builder path. */
export interface BuilderResult {
  url: string;
  dynamic?: DynamicSpec;
  /** True when at least one chosen option was terminal (a valid link exists). */
  terminal: boolean;
}

/** A static build-view option (no child loader); the ADO layer turns these into options. */
export interface BuildViewSpec {
  key: string;
  label: string;
  url: string;
}

/**
 * The views of a build. Shared so the URL fragments and the paste mapping cannot drift.
 * Logs is listed last because a fixed build expands it into stage -> job -> task.
 */
export function buildViewSpecs(): BuildViewSpec[] {
  return [
    { key: "view:results", label: "View: Results", url: "&view=results" },
    { key: "view:coverage", label: "View: Code coverage", url: "&view=codecoverage-tab" },
    {
      key: "view:artifacts",
      label: "View: Artifacts",
      url: "&view=artifacts&pathAsName=false&type=publishedArtifacts"
    },
    { key: "view:logs", label: "View: Logs", url: "&view=logs" }
  ];
}

/** Maps a `view` query value to a builder view key suffix (results/coverage/artifacts/logs). */
export function viewKeyForValue(view: string): string {
  switch (view) {
    case "results":
      return "results";
    case "codecoverage-tab":
      return "coverage";
    case "artifacts":
      return "artifacts";
    case "logs":
      return "logs";
    default:
      return "";
  }
}

/**
 * True when a target option matches the pasted view and (when present) the stage/job/task names.
 * Rationale: log targets are stored by name, so a pasted (id-based) URL is matched after its ids
 * have been resolved to names; a plain view is matched only when no names are involved.
 */
export function targetMatches(
  option: BuilderOption,
  view: string,
  names: { stage?: string; job?: string; task?: string }
): boolean {
  const hasNames = Boolean(names.stage || names.job || names.task);
  if (hasNames) {
    const optionNames = option.names;
    if (!optionNames) {
      return false;
    }
    return (
      (optionNames.stage || "") === (names.stage || "") &&
      (optionNames.job || "") === (names.job || "") &&
      (optionNames.task || "") === (names.task || "")
    );
  }
  const url = option.url || "";
  return url.indexOf("&view=" + view) === 0 && !/[&?][sjt]=/.test(url) && url.indexOf("{{") < 0;
}

/** The set of query-parameter names a target option's URL fragment carries. */
export function consumedParams(fragment: string | undefined): Set<string> {
  const names = new Set<string>();
  (fragment || "")
    .replace(/^&/, "")
    .split("&")
    .forEach((pair) => {
      if (pair) {
        names.add(pair.split("=")[0]);
      }
    });
  return names;
}

/**
 * True when the chosen path is the "Fixed" area (a stored URL that need not be in-project).
 * Rationale: fixed links skip the in-project builder entirely; the URL comes from the field.
 */
export function isFixedArea(chosen: BuilderOption[]): boolean {
  return Boolean(chosen[0] && chosen[0].key === "area:fixed");
}

/** Composes the URL and dynamic spec from a chosen option path (dynamic specs are merged). */
export function composePath(base: string, chosen: BuilderOption[]): BuilderResult {
  let url = base;
  let dynamic: DynamicSpec | undefined;
  let terminal = false;
  chosen.forEach((option) => {
    if (option.url) {
      url += option.url;
    }
    if (option.dynamic) {
      // Merge rather than replace: an option lower in the path may add (e.g.) a log target while
      // the build-mode option above it already set the kind/buildMode/definitionId.
      dynamic = { ...(dynamic || {}), ...option.dynamic };
    }
    if (option.terminal) {
      terminal = true;
    }
  });
  return { url, dynamic, terminal };
}
