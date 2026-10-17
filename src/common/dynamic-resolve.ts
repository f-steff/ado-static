import { describeError } from "./log";
import { getBuildTimeline, latestBuildId } from "./build-service";
import {
  DYNAMIC_TOKEN,
  DynamicSpec,
  LOG_JOB_TOKEN,
  LOG_STAGE_TOKEN,
  LOG_TASK_TOKEN,
  LogTarget,
  applyTokens,
  hasAnyToken,
  normalizeTokens
} from "./dynamic-links";
import { latestCommitId, listOpenPullRequests } from "./git-service";

/**
 * Resolves the dynamic part of a link to a concrete value.
 *
 * Rationale: this is where a link's spec becomes a real id. Resolution failures are returned (not
 * thrown) so the caller can show a graceful message; when the link has a captured fallback value,
 * that is used instead so the link still works.
 */

export interface ResolveResult {
  ok: boolean;
  value?: string;
  error?: string;
}

/** Result of resolving a whole link: the ready-to-open URL, or an error. */
export interface ResolveLinkResult {
  ok: boolean;
  url?: string;
  error?: string;
}

/** Resolves one dynamic spec to a string value. */
export async function resolveDynamic(spec: DynamicSpec): Promise<ResolveResult> {
  try {
    if (spec.kind === "pr") {
      const prs = await listOpenPullRequests(spec.repositoryId || "");
      if (prs.length === 0) {
        return fallbackOrError(spec, "No open pull requests were found.");
      }
      const sorted = prs.slice().sort((a, b) => a.createdUtc.localeCompare(b.createdUtc));
      const chosen = spec.prScope === "oldest-open" ? sorted[0] : sorted[sorted.length - 1];
      return { ok: true, value: String(chosen.id) };
    }
    if (spec.kind === "commit") {
      const sha = await latestCommitId(spec.repositoryId || "", spec.branch || "");
      if (!sha) {
        return fallbackOrError(spec, "No commit was found on that branch.");
      }
      return { ok: true, value: sha };
    }
    // kind === "build"
    const id = await latestBuildId(
      spec.definitionId || 0,
      spec.branch || "",
      spec.buildMode || "latest"
    );
    if (!id) {
      return fallbackOrError(spec, "No matching build was found.");
    }
    return { ok: true, value: String(id) };
  } catch (error) {
    return fallbackOrError(spec, describeError(error));
  }
}

/**
 * Resolves a full link URL. The dynamic value is resolved only when the URL actually contains the
 * dynamic token; log placeholders are resolved independently against the build the URL points at
 * (either the resolved dynamic build or the concrete `buildId` already in the URL). A missing log
 * target is reported (not silently dropped) so the hub can show a graceful "not generated" notice.
 */
export async function resolveLink(spec: DynamicSpec, url: string): Promise<ResolveLinkResult> {
  // Restore literal tokens in case they were percent-encoded in the stored URL.
  url = normalizeTokens(url);
  if (!hasAnyToken(url)) {
    return { ok: true, url };
  }
  const values: Record<string, string | null> = {};
  // 1. The dynamic value (buildId/pr/commit), only when the token is present.
  if (url.indexOf(DYNAMIC_TOKEN) >= 0) {
    const resolved = await resolveDynamic(spec);
    if (!resolved.ok || !resolved.value) {
      return { ok: false, error: resolved.error || "The target could not be resolved." };
    }
    values[DYNAMIC_TOKEN] = resolved.value;
  }
  // 2. A log target: find its ids by name in the build the URL points at.
  if (spec.logTarget) {
    const buildId = logBuildId(url, values[DYNAMIC_TOKEN]);
    const ids = buildId ? await findLogIds(buildId, spec.logTarget) : null;
    if (!ids) {
      return {
        ok: false,
        error: `The target "${describeLogTarget(spec.logTarget)}" was not found in the build.`
      };
    }
    values[LOG_STAGE_TOKEN] = ids.stage || null;
    values[LOG_JOB_TOKEN] = ids.job || null;
    values[LOG_TASK_TOKEN] = ids.task || null;
  }
  return { ok: true, url: applyTokens(url, values) };
}

/** The build id a log target must be resolved against: the resolved dynamic id, or the URL's own. */
function logBuildId(url: string, resolved: string | null | undefined): number {
  if (resolved) {
    return Number(resolved);
  }
  const match = (url || "").match(/[?&]buildId=(\d+)/);
  return match ? Number(match[1]) : 0;
}

/** Finds a log target's ids by name inside a build's timeline (null when a name is missing). */
async function findLogIds(
  buildId: number,
  target: LogTarget
): Promise<{ stage?: string; job?: string; task?: string } | null> {
  if (!buildId || Number.isNaN(buildId)) {
    return null;
  }
  const records = await getBuildTimeline(String(buildId));
  // Finds the first record with the given type(s) and name at any depth under `rootId`.
  const findUnder = (rootId: string, types: string[], name: string) => {
    const queue = [rootId];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      for (const record of records) {
        if ((record.parentId || "") !== id) {
          continue;
        }
        if (types.indexOf((record.type || "").toLowerCase()) >= 0 && record.name === name) {
          return record;
        }
        queue.push(record.id);
      }
    }
    return null;
  };
  const result: { stage?: string; job?: string; task?: string } = {};
  let parent = "";
  if (target.stage) {
    const stage = findUnder("", ["stage"], target.stage);
    if (!stage) {
      return null;
    }
    result.stage = stage.id;
    parent = stage.id;
  }
  if (target.job) {
    const job = findUnder(parent, ["job", "phase"], target.job);
    if (!job) {
      return null;
    }
    result.job = job.id;
    parent = job.id;
  }
  if (target.task) {
    const task = findUnder(parent, ["task"], target.task);
    if (!task) {
      return null;
    }
    result.task = task.id;
  }
  return result;
}

/** Human description of a log target for messages. */
function describeLogTarget(target: LogTarget): string {
  return [target.stage, target.job, target.task].filter(Boolean).join(" / ") || "logs";
}

/** Uses the captured fallback when present; otherwise reports the resolution failure. */
function fallbackOrError(spec: DynamicSpec, message: string): ResolveResult {
  if (spec.fallback) {
    return { ok: true, value: spec.fallback };
  }
  return { ok: false, error: message };
}
