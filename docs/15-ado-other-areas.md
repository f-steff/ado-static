# 15  -  Other Azure DevOps areas (links we may support)

This document explains the in-project areas we do **not** yet have a native link builder for,
their URL shapes, and how we could integrate them. It also records the plan to stand up test
content in a private test project so each shape can be verified.

Status tags: OK (supported), SPIKE (to verify), TODO (planned).

## What each area is

| Area | What it is | Available to us? |
| --- | --- | --- |
| **Wiki** | A project wiki: Markdown pages stored either in a Git repository (code wiki) or as a provisioned wiki. | OK as a **fixed** link today; a native builder is feasible. |
| **Dashboards** | A grid of widgets on the Overview page; each dashboard has a stable id. | OK as a **fixed** link; native is trivial (id in the URL). |
| **Test Plans** | Test plans/suites in Azure Test Plans: static/manual test cases and their runs. | SPIKE (needs the Test Plans service; may not be licensed). |
| **Artifacts** | Azure Artifacts feeds (NuGet/npm/etc.) and build artifacts. Build artifacts are already reachable via the build chain; feeds need a feed id. | Feed links: fixed. |
| **Boards** | Work items and boards/backlogs/sprints (Azure Boards). | Work-item links: fixed; board/backlog links are team-scoped. |
| **Environments** | Pipelines **Environments**: deployment targets (VMs, Kubernetes) plus their deployment history/checks. Only present if a pipeline uses them. | SPIKE; likely `/_environments/{id}`. |
| **Releases** | **Classic** release pipelines (the older, UI-defined release model with stages/approvals), separate from YAML pipelines. Only present if the project uses classic releases. | SPIKE; `/_release?...`. |

**Environments** and **Releases** in plain terms:

- **Environments** are the modern deployment targets for YAML pipelines. A pipeline references an
  environment (`environment: my-env`) and the environment records every deployment to it, with
  approvals/checks. If a project never uses `environment:` in YAML, the Environments list is empty.
  Link shape (Build/environment service): `/{project}/_environments/{environmentId}`.
- **Releases** are the older **classic** pipelines: you define stages, artifacts, and approvals in
  a web editor (no YAML). They live under **Pipelines -> Releases**. Link shapes:
  `/{project}/_release?_a=releases` (list), `/{project}/_release?definitionId={id}` (definition),
  `/{project}/_releaseProgress?releaseId={id}` (a specific run).

Both are optional services; the Sidebar entries and URLs only exist when the project has them.

## URL patterns (candidates for the parser)

Base is `https://dev.azure.com/{org}/{project}`. Add new shapes to
[`14-ado-urls.md`](14-ado-urls.md) and `tests/logic.test.ts` when supported.

| # | Area | Shape | Notes |
| --- | --- | --- | --- |
| W1 | Wiki | `/_wiki/wikis/{wikiId}` | Wiki home. |
| W2 | Wiki | `/_wiki/wikis/{wikiId}?pagePath=/Folder/Page` | A specific page. |
| W3 | Wiki | `/_wiki/wikis/{wikiId}/{pageId}` | Page by id (older form). |
| D1 | Dashboard | `/_dashboards/dashboard/{dashboardId}` | Dashboard by id. |
| D2 | Dashboard | `/_dashboards` | Dashboard list. |
| T1 | Test Plans | `/_testPlans/define?planId={id}&suiteId={id}` | Plan/suite (Test Plans service). |
| T2 | Test Plans | `/_test/runs?runId={id}` | A run. |
| A1 | Artifacts (feed) | `/_artifacts/feed/{feedName}` | Package feed. |
| A2 | Artifacts (package) | `/_artifacts/feed/{feed}/@{protocol}/{package}` | A package view. |
| B1 | Work item | `/_workitems/edit/{id}` | A work item. |
| B2 | Query | `/_queries/query/{queryId}` | A shared query. |
| B3 | Board | `/{team}/_boards/board/{boardId}?workitem={id}` | Team-scoped board. |
| B4 | Backlog | `/{team}/_backlogs/backlog/{backlogId}/{level}` | Team-scoped backlog. |
| B5 | Sprint | `/{team}/_sprints/taskboard/{team}/{iteration}` | Task board for an iteration. |
| E1 | Environment | `/_environments/{environmentId}` | YAML deployment environment. |
| R1 | Release list | `/_release?_a=releases` | Classic releases. |
| R2 | Release def | `/_release?definitionId={id}` | Classic release definition. |
| R3 | Release run | `/_releaseProgress?releaseId={id}` | A specific classic release. |

## Integration assessment

- **Dashboard** and **Wiki** are the best next native areas: the id is stable and the URL is
  simple. `D1` and `W2` are bookmark-safe.
- **Work item / Query / Board** links depend on team scoping and on the Boards service; a native
  area is possible but the team segment makes the builder more involved. They are good **fixed**
  links today.
- **Test Plans / Artifacts / Environments / Releases** depend on optional services. We keep them as
  fixed links until real test content proves the shapes, then decide.

## Test plan (a private test project)

Goal: create content for every area so we can enumerate the **real** URLs each feature generates
(not our guesses), then extend the parser and tests.

| Step | Create | URL to capture |
| --- | --- | --- |
| S1 | A Git repo `my-repo` with a README and a subfolder. | repo/file/commit/branch/tag/PR links |
| S2 | A **project wiki** with a page and a sub-page. | `W1`, `W2`, `W3` |
| S3 | A **dashboard** with a couple of widgets. | `D1`, `D2` |
| S4 | A **work item** + a **shared query** + a **board** (if Boards is enabled). | `B1`, `B2`, `B3`, `B4`, `B5` |
| S5 | A **Test Plan** with a suite and a run (if Test Plans is enabled). | `T1`, `T2` |
| S6 | A **package feed** with a published package. | `A1`, `A2` |
| S7 | A YAML pipeline that uses an **environment** (and a build artifact). | `E1`, build/artifact links |
| S8 | A **classic release** pipeline (if allowed). | `R1`, `R2`, `R3` |

For each captured URL we record: does `describeProjectUrl` classify it, is it stored losslessly as
fixed, and does the resolver/links hub open it.

### Test content created (example)

Created via the REST API in a private test project; identifiers are placeholders here:

| Thing | Id / value | Resulting URL (shape) |
| --- | --- | --- |
| Repo `my-repo` | `{repoId}` | `/{project}/_git/my-repo` |
| File | `/README.md`, `/reports/index.html` | `/{project}/_git/my-repo?path=/README.md&version=GBmain` |
| Commit | `{sha}` | `/{project}/_git/my-repo/commit/{sha}` |
| Branch `feature` | at `{sha}` | `/{project}/_git/my-repo?version=GBfeature` |
| Tag `v1.0.0` | at `{sha}` | `/{project}/_git/my-repo?version=GTv1.0.0` |
| PR | `413` | `/{project}/_git/my-repo/pullrequest/413` |
| Project wiki | `{wikiId}` | `/{project}/_wiki/wikis/my-repo.wiki` |
| Wiki pages | `/Home`, `/Guide`, `/Guide/Setup` | `/{projectId}/_wiki/wikis/{wikiId}?pagePath=%2FGuide%2FSetup` |
| Work item | `{workItemId}` (Task) | `/{project}/_workitems/edit/{workItemId}` |
| Dashboard | `{dashboardId}` | `/{project}/_dashboards/dashboard/{id}` |
| Environment | `my-env` (id 1) | `/{project}/_environments/1` |

Not available in this organization (create returned 403/404):

- **Test Plans** - `_apis/testplan/plans` and `_apis/test/plans` -> **403 not authorized** (the Test
  Plans service is not enabled/licensed). Test-plan URLs remain fixed links only.
- **Artifacts (feeds)** - `_apis/packaging/feeds` -> 404 on both `dev.azure.com` and
  `pkgs.dev.azure.com` (feeds REST not reachable from the browser session). Package links stay
  fixed links.
- **Classic Releases** - not attempted; the project uses YAML pipelines. Release URLs stay fixed.

Parser impact: the repo/file/commit/branch/tag/PR shapes are already covered (Repository / Pull
request areas); the wiki page confirmed the **project-GUID** segment (now accepted); work-item,
dashboard and environment links are stored as fixed links. No new parser shape is strictly required,
but a **Dashboard** and **Wiki** native area are the best next candidates (stable ids).

### Findings log

Observed on the real project (2026-10-11): the project already exposes a **wiki** and an
**Environments** entry. The wiki page link uses the **project GUID** and a wiki GUID with a
`pagePath` query - our parser now accepts the project GUID too (see [14](14-ado-urls.md)).

| Area | Captured | Parser stored as | New shape needed? |
| --- | --- | --- | --- |
| Wiki | `/{project}/_wiki/wikis`, `/{project}/_wiki/wikis/{project}.wiki`, `/{projectId}/_wiki/wikis/{wikiId}?pagePath=%2F<Page>` | fixed (GUID project now accepted) | Optional native area (id stable). |
| Dashboards | `/{project}/_dashboards` (list) | fixed | Native area is easy (id in URL). |
| Boards | TODO |  -  |  -  |
| Test Plans | TODO |  -  |  -  |
| Artifacts | TODO |  -  |  -  |
| Environments | `/{project}/_environments` (present in this project) | fixed | Verify `/{project}/_environments/{id}`. |
| Releases | TODO (classic) |  -  | Only if the project uses classic releases. |
