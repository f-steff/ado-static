import * as SDK from "azure-devops-extension-sdk";

import { addContribution, Contributor, topContributor } from "./contributors";
import { describeError, logDebug } from "./log";
import { PullRequestLocation, pullRequestWebUrl } from "./pr-url";

/**
 * Read-only Git REST access for the Repos hub.
 *
 * Rationale: the hub shows each repository with a few all-time statistics. The extension only
 * needs read access, so this wraps the handful of endpoints used and keeps error handling and
 * paging in one place. Requires the `vso.code` scope (declared in the manifest).
 */

const API_VERSION = "7.1";
// Commits are paged with $skip/$top; 1000 keeps each request small while bounded by MAX_PAGES.
const COMMIT_PAGE_SIZE = 1000;
// Safety cap so a very large repository cannot issue unbounded requests (100k commits).
const MAX_COMMIT_PAGES = 100;

export interface PullRequestInfo {
  id: number;
  // `name` mirrors the title so the shared list filter can be reused.
  name: string;
  title: string;
  author: string;
  createdUtc: string;
  status: string;
  sourceBranch: string;
  targetBranch: string;
  repository: string;
  draft: boolean;
  webUrl: string;
}

// Minimal shapes for the pull request fields we read.
interface GitPullRequest extends PullRequestLocation {
  pullRequestId: number;
  title?: string;
  status?: string;
  creationDate?: string;
  isDraft?: boolean;
  createdBy?: { displayName?: string };
  sourceRefName?: string;
  targetRefName?: string;
  repository?: { name?: string; project?: { id?: string; name?: string } };
}

/** A pull request resolved by id across the organization. */
export interface GlobalPullRequest {
  id: number;
  title: string;
  status: string;
  repository: string;
  webUrl: string;
}

/** Lists all pull requests in the project (all statuses), newest first. */
export async function listPullRequests(): Promise<PullRequestInfo[]> {
  const data = await gitGet<GitList<GitPullRequest>>(
    `pullrequests?searchCriteria.status=all&api-version=${API_VERSION}`
  );
  return (data.value || []).map(mapPullRequest);
}

/**
 * Finds a pull request by id across the whole organization. Rationale: PR ids are org-global, so a
 * number alone identifies a PR even though its project and repository vary. Uses the org-level
 * `_apis/git/pullrequests/{id}` route (no project segment). Returns null when no PR has that id.
 */
export async function getPullRequestById(id: number): Promise<GlobalPullRequest | null> {
  const organization = orgName();
  if (!organization || !id) {
    return null;
  }
  const token = await SDK.getAccessToken();
  const url = `https://dev.azure.com/${organization}/_apis/git/pullrequests/${id}?api-version=${API_VERSION}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`GET pullrequests/${id} -> ${response.status}`);
  }
  const pr = (await response.json()) as GitPullRequest;
  return {
    id: pr.pullRequestId,
    title: pr.title || "",
    status: pr.status || "",
    repository: (pr.repository && pr.repository.name) || "",
    webUrl: pullRequestWebUrl(organization, pr)
  };
}

/** Lists the active (open) pull requests for one repository (for dynamic links). */
export async function listOpenPullRequests(repositoryId: string): Promise<PullRequestInfo[]> {
  const data = await gitGet<GitList<GitPullRequest>>(
    `repositories/${repositoryId}/pullrequests?searchCriteria.status=active&api-version=${API_VERSION}`
  );
  return (data.value || []).map(mapPullRequest);
}

/** Returns the id of the newest commit on a branch (for dynamic links). */
export async function latestCommitId(repositoryId: string, branch: string): Promise<string> {
  const ref = branch || "main";
  const data = await gitGet<GitList<GitCommit>>(
    `repositories/${repositoryId}/commits?api-version=${API_VERSION}` +
      `&searchCriteria.itemVersion.version=${encodeURIComponent(ref)}&searchCriteria.$top=1`
  );
  const first = (data.value || [])[0];
  return first && first.commitId ? first.commitId : "";
}

/** Maps a raw Git pull request into the UI shape. */
function mapPullRequest(pr: GitPullRequest): PullRequestInfo {
  const organization = orgName();
  const project = projectName();
  const repo = pr.repository && pr.repository.name ? pr.repository.name : "";
  const title = pr.title || `PR ${pr.pullRequestId}`;
  return {
    id: pr.pullRequestId,
    name: title,
    title,
    author: (pr.createdBy && pr.createdBy.displayName) || "",
    createdUtc: pr.creationDate || "",
    status: pr.status || "",
    sourceBranch: shortBranch(pr.sourceRefName),
    targetBranch: shortBranch(pr.targetRefName),
    repository: repo,
    draft: Boolean(pr.isDraft),
    webUrl:
      `https://dev.azure.com/${organization}/${encodeURIComponent(project)}` +
      `/_git/${encodeURIComponent(repo)}/pullrequest/${pr.pullRequestId}`
  };
}

/** Basic repository info for the Repos hub list. */
export interface RepositoryInfo {
  id: string;
  name: string;
  defaultBranch: string;
  webUrl: string;
}

export interface RepoStats {
  lastCommitUtc: string;
  lastCommitBy: string;
  commits: number;
  commitsCapped: boolean;
  committers: number;
  branches: number;
  // Author with the most commits (all time); empty when the repository has no commits.
  mainContributor: string;
}

// Minimal shapes for the Git fields we read (the API returns much more).
interface GitList<T> {
  value?: T[];
}
interface GitRepository {
  id: string;
  name: string;
  defaultBranch?: string;
  webUrl?: string;
}
interface GitRef {
  name?: string;
}
interface GitIdentityRef {
  name?: string;
  date?: string;
}
interface GitCommit {
  commitId?: string;
  author?: GitIdentityRef;
  committer?: GitIdentityRef;
}

/** The organization name and current project name from the SDK context. */
function orgName(): string {
  const host = SDK.getHost();
  return host ? host.name : "";
}

function projectName(): string {
  const web = SDK.getWebContext();
  return web && web.project ? web.project.name : "";
}

/** Issues an authenticated Git REST GET and returns the parsed JSON. */
async function gitGet<T>(path: string): Promise<T> {
  const organization = orgName();
  const project = projectName();
  if (!organization || !project) {
    throw new Error("Cannot call the Git API without an organization and project context.");
  }
  const token = await SDK.getAccessToken();
  const url = `https://dev.azure.com/${organization}/${encodeURIComponent(project)}/_apis/git/${path}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`GET git/${path} -> ${response.status} ${describeError(await response.text())}`);
  }
  return (await response.json()) as T;
}

/** Strips the `refs/heads/` prefix for display (e.g. `refs/heads/main` -> `main`). */
function shortBranch(ref: string | undefined): string {
  return (ref || "").replace(/^refs\/heads\//, "");
}

/** Lists the repositories in the current project. */
export async function listRepositories(): Promise<RepositoryInfo[]> {
  const data = await gitGet<GitList<GitRepository>>(`repositories?api-version=${API_VERSION}`);
  return (data.value || []).map((repo) => ({
    id: repo.id,
    name: repo.name,
    defaultBranch: shortBranch(repo.defaultBranch),
    webUrl: repo.webUrl || ""
  }));
}

/** Counts the repositories in a specific project (organization overview; best-effort). */
export async function countProjectRepositories(projectId: string): Promise<number> {
  const organization = orgName();
  if (!organization) {
    throw new Error("Cannot count repositories without an organization context.");
  }
  const token = await SDK.getAccessToken();
  const url =
    `https://dev.azure.com/${organization}/${encodeURIComponent(projectId)}` +
    `/_apis/git/repositories?api-version=${API_VERSION}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`GET repositories -> ${response.status}`);
  }
  const data = (await response.json()) as GitList<GitRepository>;
  return (data.value || []).length;
}

/** Counts the *active* (open) pull requests in a specific project (organization overview). */
export async function countOpenPullRequests(projectId: string): Promise<number> {
  const organization = orgName();
  if (!organization) {
    throw new Error("Cannot count pull requests without an organization context.");
  }
  const token = await SDK.getAccessToken();
  const url =
    `https://dev.azure.com/${organization}/${encodeURIComponent(projectId)}` +
    `/_apis/git/pullrequests?searchCriteria.status=active&api-version=${API_VERSION}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`GET pullrequests -> ${response.status}`);
  }
  const data = (await response.json()) as GitList<GitPullRequest>;
  return (data.value || []).length;
}

/** Lists the branch names (without `refs/heads/`) for one repository. */
export async function listBranches(repositoryId: string): Promise<string[]> {
  const data = await gitGet<GitList<GitRef>>(
    `repositories/${repositoryId}/refs?api-version=${API_VERSION}&filter=heads/`
  );
  return (data.value || [])
    .map((ref) => shortBranch(ref.name))
    .filter((name) => name.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Computes all-time statistics for one repository: last commit, total commits and distinct
 * committers on the default branch (the branch the commits API defaults to), and branch count.
 * Commits are paged; on the safety cap, `commitsCapped` is set so the UI can show "100000+".
 */
export async function getRepoStats(repoId: string): Promise<RepoStats> {
  try {
    const refs = await gitGet<GitList<GitRef>>(
      `repositories/${repoId}/refs?api-version=${API_VERSION}&filter=heads/`
    );
    const tally = new Map<string, Contributor>();
    let commits = 0;
    let capped = false;
    let last: GitCommit | null = null;

    for (let page = 0; page < MAX_COMMIT_PAGES; page += 1) {
      const skip = page * COMMIT_PAGE_SIZE;
      const data = await gitGet<GitList<GitCommit>>(
        `repositories/${repoId}/commits?api-version=${API_VERSION}` +
          `&searchCriteria.$skip=${skip}&searchCriteria.$top=${COMMIT_PAGE_SIZE}`
      );
      const values = data.value || [];
      if (values.length === 0) {
        break;
      }
      if (!last) {
        last = values[0];
      }
      commits += values.length;
      values.forEach((commit) => {
        const name =
          (commit.author && commit.author.name) || (commit.committer && commit.committer.name) || "";
        addContribution(tally, name);
      });
      if (values.length < COMMIT_PAGE_SIZE) {
        break;
      }
      if (page === MAX_COMMIT_PAGES - 1) {
        capped = true;
      }
    }

    const lastIdentity = last ? last.committer || last.author : undefined;
    const main = topContributor(tally);
    return {
      lastCommitUtc: (lastIdentity && lastIdentity.date) || "",
      lastCommitBy:
        (last && last.committer && last.committer.name) ||
        (last && last.author && last.author.name) ||
        "",
      commits,
      commitsCapped: capped,
      committers: tally.size,
      branches: (refs.value || []).length,
      mainContributor: main ? main.name : ""
    };
  } catch (error) {
    // A single repo failing (permissions, empty) must not blank the whole list.
    logDebug("failed to read repository stats.", { repoId, error });
    return {
      lastCommitUtc: "",
      lastCommitBy: "",
      commits: 0,
      commitsCapped: false,
      committers: 0,
      branches: 0,
      mainContributor: ""
    };
  }
}
