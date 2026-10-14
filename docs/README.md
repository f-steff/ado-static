# Static - Azure DevOps extension documentation

This folder is the source of truth for **Static**: a custom Azure DevOps project-navigation group
that gives a project a curated, bookmarkable directory of links, pages, pipelines, pull requests and
repositories. Content and links can be published straight from a pipeline.

## Status legend

| Tag | Meaning |
| --- | --- |
| OK | Decision - agreed; safe to build on. |
| DRAFT | Proposal - recommended, awaiting confirmation. |
| NOTE | Constraint - imposed by the Azure DevOps platform; work around it, don't fight it. |
| SPIKE | Must be validated with a small prototype before committing (none open today). |

## Index

| Document | Purpose |
| --- | --- |
| [01-overview.md](01-overview.md) | Vision, goals, non-goals, personas, key concepts. |
| [02-requirements.md](02-requirements.md) | Functional and non-functional requirements, acceptance criteria. |
| [03-architecture.md](03-architecture.md) | Components, contributions, hosting, security, scopes. |
| [04-data-model.md](04-data-model.md) | Settings, page/link metadata, content storage in the Extension Data Service. |
| [05-navigation-and-urls.md](05-navigation-and-urls.md) | Hub groups, routes, clean URL scheme, deep links. |
| [06-pipeline-integration.md](06-pipeline-integration.md) | Publisher tasks (PublishPage/PublishLink), the report tab, lifecycle, YAML examples. |
| [07-admin-experience.md](07-admin-experience.md) | Link/page/pipeline/repo administration and the settings pages. |
| [08-open-questions.md](08-open-questions.md) | Decisions log, open questions, risks. |
| [09-references.md](09-references.md) | Microsoft and third-party references. |
| [10-development.md](10-development.md) | Toolchain, repository layout, build/packaging, conventions. |
| [11-url-parameter-bridge.md](11-url-parameter-bridge.md) | Two-way sync of `?` variables between the top URL and page content. |
| [12-spike-probes.md](12-spike-probes.md) | Retained results of the completed routing/storage/auth investigations. |
| [13-test-plan.md](13-test-plan.md) | Repeatable per-version test plan and results log. |
| [14-ado-urls.md](14-ado-urls.md) | Catalog of every in-project Azure DevOps URL shape; the parser test corpus. |
| [15-ado-other-areas.md](15-ado-other-areas.md) | Wiki/Dashboards/Boards/Test Plans/Artifacts/Environments/Releases: URLs and integration notes. |

## Glossary

| Term | Meaning |
| --- | --- |
| **Static** | The top-level project-navigation group created by this extension (also the extension name). |
| **Hub** | One entry inside the Static group: **Links**, **Pages**, **Pipelines**, **PR**, **Repos**. |
| **Page** | One pipeline-published, self-contained HTML document, addressed by a slug. |
| **Link** | A curated bookmarkable link; either *fixed* (a stored URL) or *dynamic* (re-resolved at open). |
| **Fixed link** | A stored URL that may point outside the project. Also the area used for links published by a pipeline. |
| **Dynamic link** | A link whose URL contains `{{dyn}}` (and optionally `{{stage}}`/`{{job}}`/`{{task}}`) and stores how to resolve it. |
| **Area** | The builder category for a link: **Repo**, **PR**, **Pipeline**, **Artifact**, **Fixed**. |
| **Slug** | The stable, human-readable URL segment for a page/link (`my-report`). Never a counter or hash. |
| **Publisher task** | `PublishPage@0` (publish a page and/or a report tab), `PublishLink@0` (publish a link) and `StaticAdmin@0` (back up/restore a whole organization). |
| **Extension Data Service** | Azure DevOps storage for extension settings and documents (the content store). |
| **Hub group** | A top-level section of the project sidebar (Overview, Repos, Pipelines, Static, ...). |
| **Tab / Pivot** | A tab strip inside a hub or settings page, switched in-page (instant, with real Back). |
| **Top URL** | The browser address bar of the Azure DevOps host window, not the extension iframe's URL. |

## Conventions used in these docs

- Repository-wide agent rules: [`../AGENTS.md`](../AGENTS.md).
- Example organization: `contoso`; example project: `SampleProject`.
- Identifiers such as `<publisher>` and `<extension>` are placeholders.
- The product/extension/group is **Static**; a **page** (lowercase) is one HTML document, and
  **Pages** (capitalised) names the hub that lists pages.
