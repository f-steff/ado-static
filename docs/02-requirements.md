# 02  -  Requirements

Requirements use `FR-` (functional) and `NFR-` (non-functional) IDs. `NOTE` marks a platform
constraint that shapes the requirement (see [05-navigation-and-urls.md](05-navigation-and-urls.md)).

## Functional requirements

### Navigation

| ID | Requirement |
| --- | --- |
| FR-NAV-1 | A new **top-level** project-navigation group named **Static** appears in every project. |
| FR-NAV-2 | The group contains the hubs **Links**, **Pages**, **Pipelines**, **PR** and **Repos**. NOTE Azure DevOps navigation items are declared statically in the extension manifest. |
| FR-NAV-3 | The active page or link is addressable by a clean URL (FR-URL-2). |
| FR-NAV-4 | Hub order is Links (1), Pages (2), Pipelines (3), PR (4), Repos (5). |

### Administration

| ID | Requirement |
| --- | --- |
| FR-ADM-1 | Project settings -> Pages lists all pages for the project. |
| FR-ADM-2 | Administrators can **add** a page (name + slug). |
| FR-ADM-3 | Administrators can **edit** a page (name and, optionally, its slug, plus comment). |
| FR-ADM-4 | Administrators can **delete** a page. |
| FR-ADM-5 | Administrators can **clear** a page's content (reset to empty) without deleting the page. |
| FR-ADM-6 | Administrators can **enable/disable** and **hide/unhide** a page. |
| FR-ADM-7 | Administrators can **reorder** pages. |
| FR-ADM-8 | Administrators can view each page's **size** (1024-based KiB/MiB), **comment** and **last-updated** value. |
| FR-ADM-9 | Page content is neither viewable nor editable through the UI (FR-PRIV-1). |
| FR-ADM-10 | Deleting a page or link moves it to a shared **Trash** where it can be **restored** or **deleted instantly**; trashed slugs stay reserved and entries are purged after **5 days**. |
| FR-ADM-11 | Administrators can add/edit/delete **links** (Title, unique slug, URL, comment) using a cascading builder. |
| FR-ADM-12 | The Trash table shows a **Permanent delete by** column (`deletedUtc` + 5 days). |
| FR-ADM-13 | The settings page accepts `?url=<page URL>` and pre-fills the **project** link form with it. Only absolute `http(s)` URLs are accepted, and the value is neither logged nor stored unless the link is saved. The About tab's bookmarklet does not use this page - it targets the Links hub so the link is private (FR-LINK-8). |

### Content & publishing

| ID | Requirement |
| --- | --- |
| FR-PUB-1 | A page's content is **empty by default**. |
| FR-PUB-2 | Content can only be written by **Azure Pipelines**, via a publisher task. |
| FR-PUB-3 | `PublishPage@0` publishes a page when `page` is set and/or a build report tab when `tabName` is set (independent enablers); `sourcePath` is required. |
| FR-PUB-4 | Publishing creates the page if missing (per `createIfMissing`), otherwise updates it; content is replaced atomically. |
| FR-PUB-5 | Publishing records the source build identity, timestamp, and resulting size. |
| FR-PUB-6 | A failed publish reports an actionable error (missing input, reserved/trashed slug, size, auth). |
| FR-PUB-7 | When `tabName` is set, the same HTML is attached to the build as a **Static page** report tab (opt-in). |
| FR-PUB-8 | `PublishLink@0` creates or updates a fixed link; the URL comes from `url` or, when empty, the first line of `urlFile`. |

### Rendering

| ID | Requirement |
| --- | --- |
| FR-RND-1 | Selecting a page renders its HTML full-bleed in a single `<iframe>`. |
| FR-RND-2 | The iframe is sandboxed so page scripts cannot access the Azure DevOps host. |
| FR-RND-3 | Published HTML may run its own JavaScript. |
| FR-RND-4 | v1: content is **self-contained** (a single HTML file). |
| FR-RND-5 | The list and empty/disabled/not-found/error states render in the same region. |

### Links hub

| ID | Requirement |
| --- | --- |
| FR-LINK-1 | A **Links** hub lists curated, bookmarkable links for the project. |
| FR-LINK-2 | A link has a **Title**, a unique slug, a URL and a comment. |
| FR-LINK-3 | A **fixed** link may be any absolute `http(s)` URL (it need not be in-project); links built from the project are validated to be in the current organization/project. |
| FR-LINK-4 | Each link is addressed by `?page={slug}`; selecting it navigates the host to the target in the same tab. |
| FR-LINK-5 | A link may be **dynamic**: its URL carries `{{dyn}}` and a spec (latest / latest-succeeded / latest-failed build; newest/oldest open PR; latest commit on a branch) resolved when the link is opened. |
| FR-LINK-6 | A dynamic build link may also target a **log** location, stored **by name** (`{{stage}}`/`{{job}}`/`{{task}}`) and resolved against the build at open time; a missing target shows a clear message. |
| FR-LINK-7 | The Area column shows a short category: **Repo**, **PR**, **Pipeline**, **Artifact**, **Fixed**. |
| FR-LINK-8 | The Links hub shows an **info** button (a circled i) beside its subtitle; it opens a dialog that explains the bookmarklet and offers a draggable link (right-click -> Bookmark link) built for the installed edition and pinned to this project. The hub accepts `?url=<page URL>` and opens the **private-link** editor pre-filled. A page inside a project uses that project; any other page (a fixed link, an organization page) uses the pinned project. A click outside the dialog or Escape closes it. Only absolute `http(s)` URLs are accepted. |
| FR-LINK-9 | The Links hub shows a red pending-proposal indicator with the number of **all** proposed links in the project to a caller who can open the project settings page; it opens that page, where the proposals are accepted or rejected. An unknown permission keeps it visible (D27), and it disappears when no proposal is left. |

### PR hub

| ID | Requirement |
| --- | --- |
| FR-PR-1 | A **PR** hub lists the project's pull requests with repository, author, age, status (incl. draft) and source -> target branches (open by default). |
| FR-PR-2 | The list is filtered by a case-insensitive substring. |
| FR-PR-3 | A **Global PR #** jump resolves any pull-request number in the organization (any project, any state); an unknown number shows a brief message and keeps the number for correction. |

### Pipelines hub

| ID | Requirement |
| --- | --- |
| FR-PIPE-1 | A **Pipelines** hub lists the project's pipelines with run count, last result (linked to the build), last run time, and fails since the last success. |
| FR-PIPE-2 | The list is filtered by a case-insensitive substring. |

### Repos hub

| ID | Requirement |
| --- | --- |
| FR-REPO-1 | The **Repos** hub lists every repository in the project as a link that opens it. |
| FR-REPO-2 | Each row shows brief **all-time** statistics: main contributor, default branch, last commit, commits, committers, and branches. |
| FR-REPO-3 | The list is filtered by a case-insensitive substring. |

### UI conventions

| ID | Requirement |
| --- | --- |
| FR-UI-1 | The extension never uses native `window.confirm`/`alert`/`prompt`; confirmations render into the extension DOM. |
| FR-UI-2 | The running extension version is shown, centered, at the bottom of the frames. |
| FR-UI-3 | The browser Back button returns from a viewer to the list (real host navigation). |
| FR-UI-4 | Every hub/settings heading shows its own icon; headings paint before data loads. |

### URLs

| ID | Requirement |
| --- | --- |
| FR-URL-1 | Hub base: `https://dev.azure.com/{org}/{project}/_apps/hub/{publisher}.{extension}.{hubId}` (platform-fixed). |
| FR-URL-2 | Page/link: the hub URL with `?page={slug}`. |
| FR-URL-3 | Page/link **slugs** are stable and readable (never counters or hashes). A link's **target** may legitimately include build/log ids - that is the feature - and they live in the stored link, not the hub URL. |
| FR-URL-4 | Slugs are lowercase, unique within the project, and validated on save. |
| FR-URL-5 | Opening a deep link directly (bookmark/refresh) renders the target. |
| FR-URL-6 | Page-owned `?` parameters sync **both ways** between the top URL and the page content (see [11](11-url-parameter-bridge.md)). |

### Privacy & permissions

| ID | Requirement |
| --- | --- |
| FR-PRIV-1 | Page HTML is stored as background data and is not browsable or editable in the UI. |
| FR-PRIV-2 | Internal identifiers (content hashes, revision counters) never appear in user-visible page/link URLs. |
| FR-PRM-1 | Administration requires project-administrator permission. |
| FR-PRM-2 | Viewing obeys the project's normal read permissions. |

## Non-functional requirements

| ID | Requirement |
| --- | --- |
| NFR-SEC-1 | Sandboxed iframe with a restrictive `sandbox`/CSP; no top-navigation, no same-origin access to the host. |
| NFR-SEC-2 | Publisher tasks authenticate with a scoped token; least-privilege scopes. |
| NFR-SEC-3 | Content is treated as untrusted input; never injected into the host document. |
| NFR-PERF-1 | A hub paints its heading immediately, then fills rows progressively. |
| NFR-SCALE-1 | Must handle pages from a few KiB up to tens of MiB by chunking content (see [04](04-data-model.md)). |
| NFR-REL-1 | A failed/partial publish never leaves a page corrupt (atomic swap: chunks, meta, index). |
| NFR-REL-2 | Concurrent publishes to the same page are serialized or last-writer-wins with a detectable revision conflict. |
| NFR-COMPAT-1 | Azure DevOps Services only; Azure DevOps Server is out of scope (the data layer uses the cloud-only `extmgmt.dev.azure.com` endpoint). |
| NFR-OBS-1 | Dev/prod configurable logging, prefix-filterable. |
| NFR-A11Y-1 | Admin tables and hub controls are keyboard-accessible. |

## Acceptance criteria (v1)

1. In project `SampleProject`, an admin adds a page with slug `my-report`; the hub lists it with
   size `0 B`, no comment, and "never updated".
2. A pipeline runs `PublishPage@0` against `my-report`; the hub then shows the content, a non-zero
   1024-based size, the comment, and the update time.
3. The address bar reads
   `https://dev.azure.com/contoso/SampleProject/_apps/hub/<publisher>.<extension>.static?page=my-report`.
4. Refreshing or bookmarking that URL opens the same page.
5. A page containing `<script>document.body.textContent='hi'</script>` runs in the iframe but cannot
   access or alter the surrounding Azure DevOps page.
6. Deleting the page removes it from the hub and shows the not-found state at its URL.
7. A pipeline runs `PublishLink@0`; the link appears in the Links hub with a short Area label.
