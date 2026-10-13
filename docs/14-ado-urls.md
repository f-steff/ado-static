# 14  -  Azure DevOps URL catalog (parser test corpus)

Every in-project URL shape we know of, used to test the Links parser/editor on **every** version.
Each row notes how the builder represents it. Add new shapes here (and to
[`tests/logic.test.ts`](../tests/logic.test.ts)) whenever one appears.

Base: `https://dev.azure.com/{org}/{project}`. Organization and project are fixed; only the path
and query after the project are stored by a link.

> Several ADO URLs use the **project GUID** instead of the project name (for example a wiki page:
> `/{projectId}/_wiki/wikis/{wikiId}?pagePath=/Home`). The parser accepts either the name or the
> project GUID as the project segment.

| # | Shape | Example (after the project) | Builder chain | Notes |
| --- | --- | --- | --- | --- |
| R1 | Repository root | `/_git/{repo}` | Repository -> repo | valid at the repo |
| R2 | File / folder | `/_git/{repo}?path=/dir/file&version=GBmain&line=10` | Repository -> repo -> (fixed params) | params kept verbatim |
| R3 | Commit | `/_git/{repo}/commit/{sha}` | Repository -> repo -> (fixed commit) | concrete sha |
| R4 | Branches | `/_git/{repo}/branches` | Repository -> repo -> (fixed) | |
| R5 | Tags | `/_git/{repo}/tags` | Repository -> repo -> (fixed) | |
| R6 | Pull requests list | `/_git/{repo}/pullrequests?_a=active` | Repository -> repo -> (fixed) | `_a` = active/all/completed |
| R7 | Pull request | `/_git/{repo}/pullrequest/{id}` | Repository -> repo -> (fixed id) | |
| R8 | Newest open PR (dynamic) | `/_git/{repo}/pullrequest/{{dyn}}` | Repository -> repo -> newest open | token `{{dyn}}` |
| R9 | Oldest open PR (dynamic) | `/_git/{repo}/pullrequest/{{dyn}}` | Repository -> repo -> oldest open | |
| R10 | Latest commit (dynamic) | `/_git/{repo}/commit/{{dyn}}` | Repository -> repo -> latest commit | |
| P1 | Pipeline list | `/_build` | Pipeline -> pipeline | |
| P2 | Pipeline summary | `/_build?definitionId={id}` | Pipeline -> pipeline | |
| P3 | Build results | `/_build/results?buildId={id}&view=results` | Pipeline -> pipeline -> Fixed -> Build {id} -> Results | |
| P4 | Code coverage | `/_build/results?buildId={id}&view=codecoverage-tab` | ... -> Code coverage | |
| P5 | Artifacts | `/_build/results?buildId={id}&view=artifacts&pathAsName=false&type=publishedArtifacts` | ... -> Artifacts | |
| P6 | Artifact path | `...&view=artifacts&...&path=/drop/bin` | ... -> Artifacts -> Path: /drop/bin | path kept |
| P7 | Logs (build) | `/_build/results?buildId={id}&view=logs` | ... -> Logs | whole build log |
| P8 | Logs (stage/job) | `...&view=logs&s={stageId}&j={jobId}` | ... -> Logs -> Stage -> Job | names from the timeline |
| P9 | Logs (task) | `...&view=logs&s={stageId}&j={jobId}&t={taskId}` | ... -> Logs -> Stage -> Job -> Task | |
| P10 | Team-prefixed build | `/{team}/_build/results?...` (e.g. `Sample%20Team`) | same as P3..P9 | optional team segment |
| P11 | Extension view id | `...&view={publisher}.{extension}.{contribution}` (e.g. an HTML-reports tab) | ... -> (fixed view) | unknown views are `fixed` |
| P12 | Latest build (dynamic) | `/_build/results?buildId={{dyn}}&view=results` | Pipeline -> pipeline -> Latest -> Results | token |
| P13 | Latest succeeded (dynamic) | `...&view=results` with mode latest-succeeded | Pipeline -> pipeline -> Latest succeeded | |
| P14 | Latest failed (dynamic) | `...&view=results` with mode latest-failed | Pipeline -> pipeline -> Latest failed | |

## Shapes we deliberately store as a fixed link

Anything not covered above (Boards/Work, Wiki, Test Plans, Dashboards, Environments, Releases,
Packages, other project settings pages) is an in-project URL that we cannot parameterise. Pasting
one stores it as a **fixed link** and shows it as a single fixed level. Examples:

| # | Area | Example (after the project) |
| --- | --- | --- |
| X1 | Work item | `/_workitems/edit/{id}` |
| X2 | Query | `/_queries/query/{id}` |
| X3 | Wiki page | `/_wiki/wikis/{wikiId}?pagePath=/Page` |
| X4 | Test plan | `/_testPlans/define?planId={id}&suiteId={id}` |
| X5 | Dashboard | `/_dashboards/dashboard/{id}` |
| X6 | Environment | `/_environments/{id}` |
| X7 | Release | `/_release?definitionId={id}&releaseId={id}` |
| X8 | Package feed | `/_artifacts/feed/{feed}` |

## How this is tested

- **Automated:** `tests/logic.test.ts` asserts `describeProjectUrl` for the R*/P* shapes
  (area, ids, view, params, lossless reconstruction) on every run.
- **On the deployed extension:** paste each example into Links (TC-46) and confirm the chain shows
  the expected levels and the URL is not truncated; the Pipelines/Repos tabs create links (TC-47).
