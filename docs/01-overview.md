# 01  -  Overview

## Problem

Azure DevOps has no first-class way to host arbitrary, self-contained HTML/CSS content (rich
reports, dashboards, generated coverage/test output) inside the normal project navigation. It also
has no good way to bookmark deep links to transient run detail - a specific build's job log, the
latest succeeded build, the newest open pull request - because those links carry ids that change.

Wiki renders Markdown, Dashboards render widgets, and Repos will not serve raw HTML on the
`dev.azure.com` origin. Teams therefore lose generated HTML in short-lived pipeline artifacts (or
publish it outside Azure DevOps), and their deep links break.

## Vision

Add a single, always-on **Static** group to every project's sidebar: a curated, bookmarkable
directory of the project. Under it the project curates **Links**, **Pages**, **Pipelines**, **PR**
and **Repos**. Pages are self-contained HTML published by pipelines and rendered in a sandboxed
viewer under a clean, stable URL. Links are curated bookmarks - including *dynamic* links that
re-resolve to the latest build, the newest open pull request, or the tip of a branch when opened.

## Goals

1. **Familiar navigation.** Static sits alongside `Overview`, `Repos` and `Pipelines` as a
   top-level project-navigation group, with the hubs **Links**, **Pages**, **Pipelines**, **PR** and
   **Repos**.
2. **Always available.** Installing the extension adds the group; there is no per-project or
   organization-wide switch.
3. **Admin-curated.** Administrators can add, edit, delete, clear, enable/disable, hide/unhide and
   reorder links and pages, and can see each page's size, comment and last-updated time.
   Administrators never view or edit page **content** through the UI.
4. **Pipeline-published content.** Pages, report tabs and links come from Azure Pipelines via the
   `PublishPage@0` and `PublishLink@0` tasks.
5. **Stable, bookmarkable URLs.** Every page/link has a clean slug URL; dynamic links re-resolve at
   open time, and log targets are stored by name so they survive id changes.
6. **Project insight.** The Pipelines, PR and Repos hubs summarise the project, and a
   **Global PR #** jump resolves any pull-request number in the organization.
7. **Reach otherwise inaccessible places.** Bookmark a specific build's stage/job/task log, the
   latest succeeded build, the newest open PR, or the tip of a branch.

## Non-goals

- Rendering Markdown (use Wiki).
- Editing HTML in the browser (content is pipeline-owned).
- Cross-project or organization-wide publishing (project-scoped by design).
- On-premises **Azure DevOps Server**: distribution targets Azure DevOps Services (cloud) only (D21).
- A general-purpose content management system; this is deliberately narrow.

## Personas

| Persona | Needs |
| --- | --- |
| **Project administrator** | Curate links and pages, manage metadata and visibility. |
| **Pipeline author** | Publish or update a page, a report tab, or a link from a pipeline. |
| **Team member / viewer** | Browse the directory and read published pages. |

## Key concepts

- **Page**: a named, slugged HTML document plus metadata; content is opaque to the UI.
- **Link**: a curated bookmark, either *fixed* (a stored URL, possibly outside the project) or
  *dynamic* (re-resolved at open).
- **Content store**: Azure DevOps **Extension Data Service**, project-scoped (the
  `static-{projectId}` collection).
- **Publisher tasks**: `PublishPage@0` (a page and/or a report tab), `PublishLink@0` (a link) and
  `StaticAdmin@0` (back up or restore every project's data, used to move between editions).
- **Hub group**: **Static**, containing the hubs Links, Pages, Pipelines, PR and Repos.

## High-level flow

```
                    +--------------------------------------+
                    | Azure DevOps project sidebar         |
                    |  Overview | Repos | Pipelines | ...  |
                    |  [ Static ]  <-- new hub group        |
                    +------------------+-------------------+
                                       | select a hub
                                       v
        +----------------------------------------------------------+
        | Static hubs (extension iframes)                          |
        |  Links - curated/dynamic links                           |
        |  Pages - page list + sandboxed viewer                    |
        |  Pipelines | PR | Repos - project summaries              |
        +-------------------^--------------------------------------+
                            | reads
        +-------------------+--------------------------------------+
        | Extension Data Service (project scope)                   |
        |  - links index            - page metadata (index)        |
        |  - page content chunks                                   |
        +-------------------^--------------------------------------+
                            | writes
        +-------------------+--------------------------------------+
        | Azure Pipeline -> PublishPage / PublishLink tasks        |
        +----------------------------------------------------------+
```

## Success criteria

- A fresh project gets the **Static** sidebar group immediately, with no repository changes.
- A pipeline can publish or update a page, a report tab, and a link in a task step.
- The address bar shows a clean URL for every page and link.
- No counter, GUID, or hash ever appears in a user-visible URL.
