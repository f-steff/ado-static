# 07  -  UI and Administration

Three surfaces:

1. The **hubs** - what project members see: Links, Pages, Pipelines, PR, Repos.
2. **Project settings -> Static** - what administrators manage (tabbed).
3. **Organization settings -> Static** - usage across the organization's projects.

## Part A  -  The hubs

### Links hub (the `Links` entry)

Two tables under one heading:

| Table | Content |
| --- | --- |
| **Project links** | The curated list: Title, slug, Area, comment. Each row's href is the extension URL `?page={slug}` (copyable); a plain click navigates the host to the target in the same tab. A link is either **fixed** (a stored URL, possibly outside the project) or **dynamic** (re-resolved at open). The **Area** column shows a short category: Repo, PR, Pipeline, Artifact, Fixed. |
| **Private links** | What the signed-in member created for themselves, with **Edit / Delete / Share** icons on one row and a **Status** column (Private, Proposed, or Not accepted). Readable by nobody else (user-scoped storage, [04](04-data-model.md)). |

An **Add private link** button opens the same editor as the settings page (title, slug, URL, comment
and the cascading builder), in-page, with Save/Cancel; the view is addressable (`#add`, `#edit=...`) so
Back works.

**Share** offers a private link to the project: a confirmation explains what is sent, then a frozen
snapshot appears on the project settings page as a **proposed link**, where anyone who can open those
settings may add it. Adding it promotes the link to the project (the project owns it; the member's
private original is cleaned up on their next visit) and rejecting it returns the private link with a
message. A private link resolves a `?page=<slug>` bookmark only when no project link owns that slug.

The projects table's empty state follows the permission probe: a member who cannot open Project
settings is told to ask a project administrator (or to add a private link) instead of being pointed at
a page they cannot reach.

### Pages hub (the `Pages` entry)

The landing view lists the project's published pages: **name** (a link that opens the page), slug,
size, comment and updated. Empty by default, with a hint that content arrives from pipelines. Hidden
pages are omitted; disabled pages are still listed but show a notice when opened. Selecting a page
opens it full-bleed in a sandboxed iframe (see [03](03-architecture.md)).

### Pipelines hub (the `Pipelines` entry)

Lists the project's pipelines (Build REST, `vso.build`) with run count, last result (linked to the
build), last run time, and fails since the last success; filtered by name.

### PR hub (the `PR` entry)

Lists the project's pull requests (open by default; completed/abandoned optional) with repository,
author, age, status and source -> target branches; filtered by name. A **Global PR #** box jumps to
any pull-request number in the organization (any project, any state); an unknown number shows a
brief message and keeps the number.

### Repos hub (the `Repos` entry)

Lists the project's repositories (Git REST, `vso.code`) with a brief all-time statistics line and a
name filter:

| Column | Source | Notes |
| --- | --- | --- |
| Repository | Git REST (`/git/repositories`) | Name + a link that opens the repo. |
| Main contributor | Derived from commits | Most commits; first name shown, full name on hover. |
| Default branch | Git REST | |
| Last commit | Git REST (`/commits?$top=1`) | Relative time and author. |
| Commits | Git REST (`/commits`, paged) | All-time count on the default branch. |
| Committers | Derived from commits | Distinct authors, all-time. |
| Branches | Git REST (`/refs?filter=heads/`) | |

## Part B  -  Project settings -> Static

Targets `ms.vss-web.project-admin-hub-group`; visible to project administrators. A **tabbed**
interface: **Links**, **Pages**, **Pipelines**, **Repos**, **Trash**, **Org.Settings** (a button to
the organization settings) and **About**. Tabs switch in-page (see [05](05-navigation-and-urls.md)).

### Links tab

An add/edit form (Title, Slug, URL, Comment) with a **cascading builder** for the URL: choose an
Area (Repository, Pull request, Pipeline, Fixed) and keep choosing until an option is marked
`[valid]`; a long option list gets a filter box. Pasting a full URL pre-selects the closest match;
an out-of-project URL is stored as **Fixed**. The table lists Title, Slug, Area, URL and Comment,
with View / Edit / Delete per row, and a links **Trash**. The same form (and its validation) is shared
with the Links hub, where members use it for private links.

#### Proposed links

Under the links table, **Proposed links (N)** lists the private links members offered to this project:
Title, Slug, Area, URL, Comment and **Proposed by**, with **Add to project** and **Reject** per row.
Adding creates an ordinary project link from the frozen snapshot (attributed to the proposer via
`proposedBy`) and behaves exactly like a link added here; rejecting returns the private link to its
owner with a message. A proposal whose slug was taken since it was offered, or whose URL no longer has
a valid shape, explains why and offers only **Reject**.

### Pages tab

Add/edit form (name, slug, comment) plus a summary line (`N page(s), total content size ...`), then
the page table:

| Column | Content |
| --- | --- |
| Name | Display name. |
| Slug | URL segment (immutable while editing). |
| Size | Formatted 1024-based (`KiB`/`MiB`). |
| Comment | Free text describing the content. |
| Updated | `updatedUtc` + `updatedBy`. |
| Status | enabled / disabled / hidden / empty. |

Per-row actions: **View** (opens the page in a new tab), Edit, Clear, Enable/Disable, Hide/Unhide,
reorder (up/down), Delete.

### Pipelines tab

The project's pipelines with a Link type + Create shortcut (builds a link in the Links tab), plus
per-pipeline visibility and quick link creation.

### Repos tab

The project's repositories with a per-repo **hide** toggle (hidden repos are omitted from the Repos
hub), a Link type and Create shortcut.

### Trash tab

A shared Trash for pages **and** links with a **Type** column, a **Deleted** column, and a
**Permanent delete by** column (`deletedUtc` + 5 days). Actions: **Restore** and **Delete
instantly**. Entries older than 5 days are purged automatically on load (see [04](04-data-model.md)).

### About tab

What Static is, the two publishing sections (page / link) with example YAML and the
`createIfMissing` behaviour, the dynamic-link and trash notes, permissions, and the package details.

Contents are never shown or editable in settings (FR-ADM-9); only metadata.

## Part C  -  Organization settings -> Static

Targets `ms.vss-web.collection-admin-hub-group`. A **tabbed** interface: **Overview**, **Backup**,
and **About**. The overview lists the organization's projects with their Links, Pages, Pipelines, PRs
and Repos counts (aligned right except the Project column). Each project links to its Static settings
page, which links back here. There is no enable/disable switch: Static is always available.

### Backup tab

> The **release** (`static`) and **development** (`static-dev`) editions keep **separate** data, so
> installing one in place of the other starts from an empty project. Switching editions therefore
> means: **Download** a backup, install the other edition, then **Restore** it (here or from a
> pipeline). Without that sequence the data looks lost - it is still in the other edition's scope
> and only becomes visible again after switching back.

**Download backup** reads every project's collection and saves a single ZIP
(`static-backup-{organization}-{date}.zip`) holding `static-backup.json` (`format: "static-export"`,
`schemaVersion: 2`, `source`, and a `projects` list). Pages are included **in full**, because their
content chunks are ordinary documents in the same collection, and no document carries the
installation-specific `__etag`.

Choosing a **Backup file (ZIP)** only reads and validates it; the summary
(`<file>: N project(s), M document(s) from <org>`) appears between the file field and the buttons.
Restoring is then an explicit sequence on one button row - `Restore`, `Clear`, `Confirm restore`:

| State | Restore | Clear | Confirm restore |
| --- | --- | --- | --- |
| Nothing chosen | inactive | inactive | hidden |
| Usable file chosen | **active** | **active** | hidden |
| `Restore` pressed | inactive | active | **shown** (the status line asks the question) |
| `Clear` pressed | inactive | inactive | hidden - the file and summary are cleared |
| `Confirm restore` pressed | inactive | inactive | inactive while it runs, then the status line reports the result and the row returns to its initial state |

For every project in the archive that still exists, its data
is **replaced** by the backup's (documents the backup does not contain are removed); projects that no
longer exist are skipped and reported. The tab also shows a single `StaticAdmin@0` pipeline that
backs up by default and, with `mode = restore`, restores the newest backup of that same pipeline.

Rationale: extension data is scoped per extension id, so the stable and dev editions keep separate
stores; the archive is how an organization is copied between them (for example to seed dev with
stable data before a release) and doubles as a backup.

## Permissions

| Capability | Required |
| --- | --- |
| View hubs / read a page | Normal project read access. |
| Private links (add, edit, delete, share) | Normal project read access - the store is user-scoped, so only its owner can reach it. |
| Manage links/pages, and add a proposed link | Project administrator (the settings hub is only reachable via Project settings). |
| Use the organization settings (Overview, Backup) | Collection administrator (the organization settings hub is only reachable there). |

Enforcement: the settings hub is only reached via Project settings; data writes use the caller's
token, so unauthorized writes fail server-side (defence in depth). What the UI *offers* is decided by
the permission probes in [03](03-architecture.md#permission-aware-ui-d27): the project settings page
hides its **Org.Settings** button when the caller cannot open the organization settings, and the Links
hub tells a member who cannot open Project settings to ask an administrator instead of pointing them
at a page they cannot reach.

## Accessibility and theming

- Use native controls and semantic tables; ensure keyboard focus order and screen-reader labels
  (NFR-A11Y-1).
- Respect the host theme (light/dark); ADO passes theme data via the SDK.
- **ADO palette variables are RGB triplets**, not colors: `--palette-neutral-10` is `218, 218, 218`.
  Use them as `rgba(var(--palette-neutral-10, 218, 218, 218), 1)`; using the variable directly is
  invalid and silently drops the border/background.
- Logging uses the shared `[pages-ext]` prefix with `__DEV__` verbosity (NFR-OBS-1).
