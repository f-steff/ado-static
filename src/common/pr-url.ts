// Pure helpers for resolving a pull request by its (organization-global) number.
//
// Rationale: pull-request ids are a single sequence across the whole organization, so a number
// alone identifies a PR - but its project and repository are only known after a lookup. These
// helpers build the web URL from the lookup result and are pure, so they are unit-testable.

/** The subset of an Azure DevOps pull request needed to build its web URL. */
export interface PullRequestLocation {
  pullRequestId: number;
  repository?: {
    name?: string;
    project?: { id?: string; name?: string };
  };
}

/**
 * Builds the web URL for a pull request: `https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}`.
 * The project segment prefers the project id (always present in the API response).
 */
export function pullRequestWebUrl(organization: string, pr: PullRequestLocation): string {
  const project = pr.repository?.project;
  const projectSegment = project?.id || project?.name || "";
  const repoName = pr.repository?.name || "";
  return (
    `https://dev.azure.com/${organization}/${encodeURIComponent(projectSegment)}` +
    `/_git/${encodeURIComponent(repoName)}/pullrequest/${pr.pullRequestId}`
  );
}

/** True when the pull request id is a positive integer (the input accepts digits only). */
export function isValidPullRequestId(value: string): boolean {
  return /^[1-9][0-9]*$/.test((value || "").trim());
}
