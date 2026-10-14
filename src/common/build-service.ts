import * as SDK from "azure-devops-extension-sdk";

import { describeError } from "./log";

/**
 * Read access to Azure Pipelines builds, for dynamic links.
 *
 * Rationale: a dynamic link can point at the "latest build" of a pipeline; resolving that uses
 * the Build REST API, which needs the `vso.build` scope. That scope is not granted yet, so a
 * 401/403 is reported as an actionable error and the link's fallback value is used instead.
 */

const API_VERSION = "7.1";

/** How "latest" is interpreted for a build link. */
export type BuildMode = "latest" | "latest-succeeded" | "latest-failed";

function orgName(): string {
  const host = SDK.getHost();
  return host ? host.name : "";
}

function projectName(): string {
  const web = SDK.getWebContext();
  return web && web.project ? web.project.name : "";
}

/** A pipeline definition (for the link builder's Pipeline area). */
export interface DefinitionInfo {
  id: number;
  name: string;
}

/** Lists the pipeline definitions in the project (needs `vso.build`). */
export async function listDefinitions(): Promise<DefinitionInfo[]> {
  const organization = orgName();
  const project = projectName();
  if (!organization || !project) {
    throw new Error("Cannot list pipelines without an organization and project context.");
  }
  const token = await SDK.getAccessToken();
  const url =
    `https://dev.azure.com/${organization}/${encodeURIComponent(project)}` +
    `/_apis/build/definitions?api-version=${API_VERSION}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
  } catch {
    throw new Error(
      "Listing pipelines is unavailable here (needs the Build (read) permission)."
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      "Listing pipelines needs the 'Build (read)' permission, which is pending approval for this extension."
    );
  }
  if (!response.ok) {
    throw new Error(`GET definitions -> ${response.status} ${describeError(await response.text())}`);
  }
  const data = (await response.json()) as { value?: Array<{ id?: number; name?: string }> };
  return (data.value || [])
    .filter((definition) => definition.id)
    .map((definition) => ({
      id: definition.id as number,
      name: definition.name || `Pipeline ${definition.id}`
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A build reference (the fields we summarise). */
interface BuildRef {
  id?: number;
  result?: string;
  status?: string;
  finishTime?: string;
  startTime?: string;
}

/** A recent build of a pipeline (id + result + time). */
export interface BuildSummary {
  id: number;
  result: string;
  finishTime: string;
}

/** Lists a pipeline's recent builds for the link builder (needs `vso.build`). */
export async function listRecentBuilds(definitionId: number, top = 30): Promise<BuildSummary[]> {
  const builds = await listBuilds(definitionId, top);
  return builds
    .filter((build) => build.id)
    .map((build) => ({
      id: build.id as number,
      result: build.result || "",
      finishTime: build.finishTime || build.startTime || ""
    }));
}

/** A per-pipeline summary for the Pipelines hub and settings. */
export interface PipelineSummary {
  id: number;
  name: string;
  runCount: number;
  lastBuildId: number;
  lastResult: string;
  lastFinishedUtc: string;
  failsSinceSuccess: number;
}

/** Lists a pipeline's most recent builds (needs `vso.build`). */
async function listBuilds(definitionId: number, top: number): Promise<BuildRef[]> {
  const organization = orgName();
  const project = projectName();
  const token = await SDK.getAccessToken();
  const params = new URLSearchParams();
  params.set("api-version", API_VERSION);
  params.set("definitions", String(definitionId));
  params.set("queryOrder", "finishTimeDescending");
  params.set("$top", String(top));
  const url =
    `https://dev.azure.com/${organization}/${encodeURIComponent(project)}` +
    `/_apis/build/builds?${params.toString()}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
  } catch {
    throw new Error("Reading builds is unavailable here (needs the Build (read) permission).");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      "Reading builds needs the 'Build (read)' permission, which is pending approval for this extension."
    );
  }
  if (!response.ok) {
    throw new Error(`GET builds -> ${response.status}`);
  }
  const data = (await response.json()) as { value?: BuildRef[] };
  return data.value || [];
}

/** Summarises a pipeline from its recent builds (last result, run count, fails since success). */
function summarize(definition: { id: number; name: string }, builds: BuildRef[]): PipelineSummary {
  const completed = builds.filter((build) => build.result);
  const last = completed[0];
  let failsSinceSuccess = 0;
  for (const build of completed) {
    if ((build.result || "").toLowerCase() === "succeeded") {
      break;
    }
    failsSinceSuccess += 1;
  }
  return {
    id: definition.id,
    name: definition.name,
    runCount: builds.length,
    lastBuildId: last && last.id ? last.id : 0,
    lastResult: last ? last.result || "" : "",
    lastFinishedUtc: last ? last.finishTime || last.startTime || "" : "",
    failsSinceSuccess
  };
}

/** Lists pipelines with a brief summary each (needs `vso.build`). */
export async function getPipelineSummaries(window = 30): Promise<PipelineSummary[]> {
  const definitions = await listDefinitions();
  const queue = definitions.slice();
  const out: PipelineSummary[] = [];
  const worker = async () => {
    while (queue.length > 0) {
      const definition = queue.shift();
      if (!definition) {
        break;
      }
      try {
        out.push(summarize(definition, await listBuilds(definition.id, window)));
      } catch {
        out.push({
          id: definition.id,
          name: definition.name,
          runCount: 0,
          lastBuildId: 0,
          lastResult: "",
          lastFinishedUtc: "",
          failsSinceSuccess: 0
        });
      }
    }
  };
  await Promise.all(Array.from({ length: 5 }, () => worker()));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Counts the pipeline definitions in a specific project (organization overview; best-effort). */
export async function countPipelines(projectId: string): Promise<number> {
  const organization = orgName();
  if (!organization) {
    throw new Error("Cannot count pipelines without an organization context.");
  }
  const token = await SDK.getAccessToken();
  const url =
    `https://dev.azure.com/${organization}/${encodeURIComponent(projectId)}` +
    `/_apis/build/definitions?api-version=${API_VERSION}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
  } catch {
    throw new Error("Reading pipelines is unavailable here.");
  }
  if (!response.ok) {
    throw new Error(`GET definitions -> ${response.status}`);
  }
  const data = (await response.json()) as { value?: unknown[] };
  return (data.value || []).length;
}

/** A single build's identity (used to label a fixed build with its pipeline name). */
export interface BuildInfo {
  id: number;
  definitionId: number;
  definitionName: string;
  branch: string;
}

/** A single timeline record (stage/job/task) used to name build-log links. */
export interface TimelineRecord {
  id: string;
  name: string;
  type: string;
  parentId?: string;
}

/** Reads a build's timeline (stages/jobs/tasks); empty when unavailable. */
export async function getBuildTimeline(buildId: string): Promise<TimelineRecord[]> {
  const organization = orgName();
  const project = projectName();
  if (!organization || !project) {
    return [];
  }
  const token = await SDK.getAccessToken();
  const url =
    `https://dev.azure.com/${organization}/${encodeURIComponent(project)}` +
    `/_apis/build/builds/${encodeURIComponent(buildId)}/timeline?api-version=${API_VERSION}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
  } catch {
    return [];
  }
  if (!response.ok) {
    return [];
  }
  const data = (await response.json()) as {
    records?: Array<{ id?: string; name?: string; type?: string; parentId?: string }>;
  };
  return (data.records || [])
    .filter((record) => record.id)
    .map((record) => ({
      id: record.id as string,
      name: record.name || (record.id as string),
      type: record.type || "",
      parentId: record.parentId
    }));
}

/** Reads one build's identity (pipeline name etc.); null when unavailable. */
export async function getBuildInfo(buildId: string): Promise<BuildInfo | null> {
  const organization = orgName();
  const project = projectName();
  if (!organization || !project) {
    return null;
  }
  const token = await SDK.getAccessToken();
  const url =
    `https://dev.azure.com/${organization}/${encodeURIComponent(project)}` +
    `/_apis/build/builds/${encodeURIComponent(buildId)}?api-version=${API_VERSION}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  const data = (await response.json()) as {
    id?: number;
    definition?: { id?: number; name?: string };
    sourceBranch?: string;
  };
  return {
    id: data.id || Number(buildId),
    definitionId: (data.definition && data.definition.id) || 0,
    definitionName: (data.definition && data.definition.name) || "",
    branch: data.sourceBranch || ""
  };
}

/** Resolves the id of the latest build for a pipeline/branch/result (0 when none found). */
export async function latestBuildId(
  definitionId: number,
  branch: string,
  mode: BuildMode
): Promise<number> {
  const organization = orgName();
  const project = projectName();
  if (!organization || !project) {
    throw new Error("Cannot resolve a build without an organization and project context.");
  }
  const token = await SDK.getAccessToken();
  const params = new URLSearchParams();
  params.set("api-version", API_VERSION);
  params.set("queryOrder", "finishTimeDescending");
  params.set("$top", "1");
  if (definitionId) {
    params.set("definitions", String(definitionId));
  }
  if (branch) {
    params.set("branchName", branch);
  }
  if (mode === "latest-succeeded") {
    params.set("resultFilter", "succeeded");
  } else if (mode === "latest-failed") {
    params.set("resultFilter", "failed");
  }
  const url =
    `https://dev.azure.com/${organization}/${encodeURIComponent(project)}` +
    `/_apis/build/builds?${params.toString()}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
  } catch {
    throw new Error("Resolving the latest build is unavailable here (needs the Build (read) permission).");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      "Build lookup needs the 'Build (read)' permission, which is pending approval for this extension."
    );
  }
  if (!response.ok) {
    throw new Error(`GET builds -> ${response.status} ${describeError(await response.text())}`);
  }
  const data = (await response.json()) as { value?: Array<{ id?: number }> };
  const first = (data.value || [])[0];
  return first && first.id ? first.id : 0;
}
