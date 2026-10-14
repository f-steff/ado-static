// Validation and description for pasted Azure DevOps project links.
//
// Rationale: every link must stay inside the current project so it is a stable, bookmarkable
// in-project target (no external links). A pasted URL is accepted only when it addresses this
// organization and project; anything else is rejected with a clear reason. Pure so it is testable.

/** Details detected from a pasted in-project URL (for the paste-to-configure UX). */
export interface ProjectUrlInfo {
  ok: boolean;
  error?: string;
  area: "repository" | "build" | "other";
  repositoryName?: string;
  prId?: string;
  commit?: string;
  buildId?: string;
  view?: string;
  stageId?: string;
  jobId?: string;
  taskId?: string;
  artifactPath?: string;
  // Every query parameter, in order, so a pasted URL can be reconstructed losslessly.
  params: Array<[string, string]>;
}

/**
 * Describes a pasted in-project Azure DevOps URL so the settings UI can pre-select the matching
 * builder options. Tolerant of an optional team segment before `_build`/`_git`, and of the project
 * being referenced by its GUID instead of its name (e.g. wiki page links).
 */
export function describeProjectUrl(
  raw: string,
  organization: string,
  project: string,
  projectId = ""
): ProjectUrlInfo {
  const check = checkProjectUrl(raw, organization, project, projectId);
  if (!check.ok) {
    return { ok: false, error: check.error, area: "other", params: [] };
  }
  const url = new URL(raw);
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  // segments start with [organization, project, ...rest].
  const rest = segments.slice(2);
  const query = url.searchParams;
  const params: Array<[string, string]> = [];
  query.forEach((value, key) => params.push([key, value]));

  const buildAt = rest.indexOf("_build");
  if (buildAt >= 0) {
    return {
      ok: true,
      area: "build",
      buildId: query.get("buildId") || "",
      view: query.get("view") || "",
      stageId: query.get("s") || "",
      jobId: query.get("j") || "",
      taskId: query.get("t") || "",
      artifactPath: query.get("path") || "",
      params
    };
  }

  const gitAt = rest.indexOf("_git");
  if (gitAt >= 0 && rest[gitAt + 1]) {
    const info: ProjectUrlInfo = {
      ok: true,
      area: "repository",
      repositoryName: rest[gitAt + 1],
      params
    };
    const kind = rest[gitAt + 2];
    const id = rest[gitAt + 3];
    if (kind === "pullrequest" && id) {
      info.prId = id;
    } else if (kind === "commit" && id) {
      info.commit = id;
    }
    return info;
  }

  return { ok: true, area: "other", params };
}


export interface UrlCheck {
  ok: boolean;
  error?: string;
  normalized?: string;
}

/** Returns whether a pasted URL is an in-project Azure DevOps link, with a reason when not. */
export function checkProjectUrl(
  raw: string,
  organization: string,
  project: string,
  projectId = ""
): UrlCheck {
  const value = (raw || "").trim();
  if (!value) {
    return { ok: false, error: "Enter a URL." };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "That is not a valid URL." };
  }
  if (url.protocol !== "https:") {
    return { ok: false, error: "Only https URLs are allowed." };
  }

  const host = url.hostname.toLowerCase();
  const isDevAzure = host === "dev.azure.com";
  const isLegacy = host.endsWith(".visualstudio.com") && host !== ".visualstudio.com";
  if (!isDevAzure && !isLegacy) {
    return { ok: false, error: "Only links inside Azure DevOps are allowed." };
  }

  // The project may be referenced by name OR by its GUID (several ADO URLs use the GUID).
  const matchesProject = (segment: string) =>
    segment.toLowerCase() === project.toLowerCase() ||
    (Boolean(projectId) && segment.toLowerCase() === projectId.toLowerCase());

  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));

  if (isDevAzure) {
    const [org, proj] = segments;
    if (!org || org.toLowerCase() !== organization.toLowerCase()) {
      return { ok: false, error: `The link must point at this organization (${organization}).` };
    }
    if (!proj || !matchesProject(proj)) {
      return { ok: false, error: `The link must point at this project (${project}).` };
    }
  } else {
    const org = host.split(".")[0];
    if (org.toLowerCase() !== organization.toLowerCase()) {
      return { ok: false, error: `The link must point at this organization (${organization}).` };
    }
    const [proj] = segments;
    if (!proj || !matchesProject(proj)) {
      return { ok: false, error: `The link must point at this project (${project}).` };
    }
  }

  return { ok: true, normalized: url.toString() };
}
