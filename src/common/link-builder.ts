import { getBuildTimeline, listDefinitions, listRecentBuilds } from "./build-service";
import { buildViewSpecs } from "./builder-core";
import type { BuilderOption } from "./builder-core";
import { DYNAMIC_TOKEN, LOG_JOB_TOKEN, LOG_STAGE_TOKEN, LOG_TASK_TOKEN } from "./dynamic-links";
import { listBranches, listOpenPullRequests, listRepositories, RepositoryInfo } from "./git-service";

/**
 * ADO-backed cascading option model for building an in-project link URL.
 *
 * Rationale: a link is built by choosing an "area" and then increasingly specific options, each
 * loaded from Azure DevOps. The shapes are intentionally shallow and name-first:
 *   Repository   -> repository -> named target (root / branches / tags / PR list / a PR by title)
 *   Pull request -> repository -> a PR by title
 *   Pipeline     -> pipeline -> build mode -> (build number) -> a named target
 *   Fixed        -> any http(s) URL (typed in the URL field)
 * The layer after a build is a SINGLE flat list of clearly named targets (views such as "View:
 * Logs", plus every stage/job/task log target as "Logs: <stage> / <job> / <task>"). This is what
 * makes the chain easy to read and to change: picking another build regenerates the list, and a
 * target with the same name is re-selected automatically.
 *
 * The pure types, URL composition and the static view mapping live in builder-core (so they are
 * unit-testable without the SDK); this module adds the child loaders that call ADO and re-exports
 * the pure pieces so callers can import all builder helpers from one place.
 */
export { composePath, viewKeyForValue } from "./builder-core";
export type { BuilderOption, BuilderResult } from "./builder-core";

/** Root areas (blank until chosen). */
export function rootOptions(): BuilderOption[] {
  return [
    {
      key: "area:repo",
      label: "Repository",
      url: "",
      loadChildren: async () => repositories()
    },
    {
      key: "area:pr",
      label: "Pull request",
      url: "",
      loadChildren: async () => repositories()
    },
    {
      key: "area:build",
      label: "Pipeline",
      url: "",
      loadChildren: async () => pipelines()
    },
    {
      // Fixed: the admin types any http(s) URL. This is also the area for links published by the
      // PublishLink pipeline task ("fixed pipeline artifact"). It is terminal on its own, and it
      // contributes no URL fragment (the URL comes from the field).
      key: "area:fixed",
      label: "Fixed (any URL)",
      url: "",
      terminal: true
    }
  ];
}

/** The project's repositories, sorted by name. */
async function repositories(): Promise<BuilderOption[]> {
  try {
    const repos = await listRepositories();
    return repos
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((repo) => ({
        key: "repo:" + repo.id,
        label: repo.name,
        url: "",
        loadChildren: async () => repositoryChildren(repo)
      }));
  } catch (error) {
    return [];
  }
}

/** What you can point at inside a repository: named targets (no numbers except a PR's id). */
async function repositoryChildren(repo: RepositoryInfo): Promise<BuilderOption[]> {
  const branch = repo.defaultBranch || "main";
  const options: BuilderOption[] = [
    {
      key: "repo-root",
      label: "Repository root",
      url: "/_git/" + encodeURIComponent(repo.name),
      terminal: true
    },
    {
      key: "branches",
      label: "Branches",
      url: "/_git/" + encodeURIComponent(repo.name) + "/branches",
      terminal: true
    },
    {
      key: "tags",
      label: "Tags",
      url: "/_git/" + encodeURIComponent(repo.name) + "/tags",
      terminal: true
    },
    {
      key: "pr-list",
      label: "Pull requests (active)",
      url: "/_git/" + encodeURIComponent(repo.name) + "/pullrequests?_a=active",
      terminal: true
    },
    {
      key: "commit:default",
      label: `Latest commit on ${branch} (dynamic)`,
      url: "/_git/" + encodeURIComponent(repo.name) + "/commit/" + DYNAMIC_TOKEN,
      terminal: true,
      dynamic: { kind: "commit", repositoryId: repo.id, branch }
    },
    {
      key: "pr:newest-open",
      label: "Newest open pull request (dynamic)",
      url: "/_git/" + encodeURIComponent(repo.name) + "/pullrequest/" + DYNAMIC_TOKEN,
      terminal: true,
      dynamic: { kind: "pr", prScope: "newest-open", repositoryId: repo.id }
    },
    {
      key: "pr:oldest-open",
      label: "Oldest open pull request (dynamic)",
      url: "/_git/" + encodeURIComponent(repo.name) + "/pullrequest/" + DYNAMIC_TOKEN,
      terminal: true,
      dynamic: { kind: "pr", prScope: "oldest-open", repositoryId: repo.id }
    },
    {
      key: "commit:branch",
      label: "Latest commit on another branch...",
      url: "",
      loadChildren: async () => {
        const names = await listBranches(repo.id);
        return names.map((name) => ({
          key: "branch:" + name,
          label: name,
          url: "/_git/" + encodeURIComponent(repo.name) + "/commit/" + DYNAMIC_TOKEN,
          terminal: true,
          dynamic: { kind: "commit", repositoryId: repo.id, branch: name }
        }));
      }
    }
  ];
  // Named open pull requests (so a PR is chosen by title, not by number).
  try {
    const prs = await listOpenPullRequests(repo.id);
    prs.forEach((pr) => {
      options.push({
        key: "pullrequest:" + pr.id,
        label: `PR ${pr.id}: ${pr.title}`,
        url: "/_git/" + encodeURIComponent(repo.name) + "/pullrequest/" + pr.id,
        terminal: true
      });
    });
  } catch (error) {
    // A missing Git permission just omits the named PRs; the other targets still work.
  }
  return options;
}

/** Pipelines (definitions) in the project (needs `vso.build`; empty when unavailable). */
async function pipelines(): Promise<BuilderOption[]> {
  try {
    const definitions = await listDefinitions();
    return definitions.map((definition) => ({
      key: "pipe:" + definition.id,
      label: definition.name,
      url: "",
      loadChildren: async () => buildModes(definition.id)
    }));
  } catch (error) {
    return [];
  }
}

/** How a build is chosen: latest / latest succeeded / latest failed / a fixed build. */
function buildModes(definitionId: number): BuilderOption[] {
  const mode = (
    value: "latest" | "latest-succeeded" | "latest-failed",
    label: string
  ): BuilderOption => ({
    key: "mode:" + value,
    label,
    url: "/_build/results?buildId=" + DYNAMIC_TOKEN,
    terminal: true,
    dynamic: { kind: "build", buildMode: value, definitionId },
    loadChildren: async () => buildTargets()
  });
  return [
    mode("latest", "Latest build"),
    mode("latest-succeeded", "Latest succeeded build"),
    mode("latest-failed", "Latest failed build"),
    {
      key: "mode:fixed",
      label: "Specific build...",
      url: "",
      loadChildren: async () => buildNumbers(definitionId)
    }
  ];
}

/** The pipeline's recent builds (for a fixed-build chain), named by result. */
async function buildNumbers(definitionId: number): Promise<BuilderOption[]> {
  try {
    const builds = await listRecentBuilds(definitionId, 40);
    return builds.map((build) => ({
      key: "build:" + build.id,
      label: `Build ${build.id}${build.result ? " (" + build.result + ")" : ""}${
        build.finishTime ? " - " + shortDate(build.finishTime) : ""
      }`,
      url: "/_build/results?buildId=" + build.id,
      terminal: true,
      loadChildren: async () => buildTargets(build.id)
    }));
  } catch (error) {
    return [];
  }
}

/**
 * One flat, clearly named list of link targets for a build:
 *  - the standard views ("View: Results", "View: Logs", ...), and
 *  - for a concrete build, every log target as "Logs: <stage> / <job> / <task>".
 * Log targets are stored as NAME PLACEHOLDERS ({{stage}}/{{job}}/{{task}}), not per-build ids, so
 * the target survives any change of pipeline/build/mode and is resolved (or gracefully reported
 * missing) against whichever build the link points at when it is opened.
 */
export async function buildTargets(buildId?: number): Promise<BuilderOption[]> {
  const views: BuilderOption[] = buildViewSpecs().map((spec) => ({
    key: spec.key,
    label: spec.label,
    url: spec.url,
    terminal: true
  }));
  if (!buildId) {
    return views;
  }
  let records: TimelineRecord[] = [];
  try {
    records = await timeline(buildId);
  } catch (error) {
    return views;
  }

  // Group records by parent so the tree can be walked once. ADO nests logs as
  // Stage -> Phase -> Job -> Task; we flatten every level into a named target.
  const byParent = new Map<string, TimelineRecord[]>();
  records.forEach((record) => {
    const key = record.parentId || "";
    const list = byParent.get(key);
    if (list) {
      list.push(record);
    } else {
      byParent.set(key, [record]);
    }
  });

  const targets: BuilderOption[] = [...views];
  const used = new Set<string>();
  // Names can repeat (e.g. two "Build" jobs); disambiguate by appending an index for uniqueness.
  const uniqueKey = (base: string): string => {
    let key = base;
    let index = 2;
    while (used.has(key)) {
      key = `${base} #${index}`;
      index += 1;
    }
    used.add(key);
    return key;
  };
  const nearest = (stack: TimelineRecord[], type: string): TimelineRecord | undefined =>
    [...stack].reverse().find((record) => (record.type || "").toLowerCase() === type);

  const walk = (parentId: string, stack: TimelineRecord[]): void => {
    (byParent.get(parentId) || []).forEach((record) => {
      const type = (record.type || "").toLowerCase();
      const name = record.name || "(unnamed)";
      const stage = nearest(stack, "stage");
      const job = nearest(stack, "job") || nearest(stack, "phase");
      if (type === "stage") {
        targets.push({
          key: uniqueKey(`target:logs:${name}`),
          label: `Logs: ${name}`,
          url: `&view=logs&s=${LOG_STAGE_TOKEN}`,
          terminal: true,
          names: { stage: name },
          dynamic: { kind: "build", logTarget: { view: "logs", stage: name } }
        });
      } else if (type === "job" || type === "phase") {
        const label = stage ? `${stage.name} / ${name}` : name;
        targets.push({
          key: uniqueKey(`target:logs:${label}`),
          label: `Logs: ${label}`,
          url: `&view=logs&s=${LOG_STAGE_TOKEN}&j=${LOG_JOB_TOKEN}`,
          terminal: true,
          names: { stage: stage && stage.name, job: name },
          dynamic: { kind: "build", logTarget: { view: "logs", stage: stage && stage.name, job: name } }
        });
      } else if (type === "task") {
        const label = [stage && stage.name, job && job.name, name].filter(Boolean).join(" / ");
        targets.push({
          key: uniqueKey(`target:logs:${label}`),
          label: `Logs: ${label}`,
          url: `&view=logs&s=${LOG_STAGE_TOKEN}&j=${LOG_JOB_TOKEN}&t=${LOG_TASK_TOKEN}`,
          terminal: true,
          names: { stage: stage && stage.name, job: job && job.name, task: name },
          dynamic: {
            kind: "build",
            logTarget: {
              view: "logs",
              stage: stage && stage.name,
              job: job && job.name,
              task: name
            }
          }
        });
      }
      walk(record.id, [...stack, record]);
    });
  };
  walk("", []);
  return targets;
}

/** A short, local date for a build summary (name-first, number only when useful). */
function shortDate(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return iso;
  }
  return new Date(parsed).toISOString().slice(0, 10);
}

// Cache the timeline per build so nested levels do not re-fetch it.
type TimelineRecord = { id: string; name: string; type: string; parentId?: string };
const timelineCache = new Map<number, TimelineRecord[]>();
async function timeline(buildId: number): Promise<TimelineRecord[]> {
  let records = timelineCache.get(buildId);
  if (!records) {
    records = await getBuildTimeline(String(buildId));
    timelineCache.set(buildId, records);
  }
  return records;
}
