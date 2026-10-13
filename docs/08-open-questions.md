# 08  -  Decisions, Open Questions, Risks

## Decisions log

| # | Decision | Status |
| --- | --- | --- |
| D1 | Content, links and settings are stored in the **Extension Data Service**, project-scoped (collection `static-{projectId}`). | OK |
| D2 | Links and pages are **project-scoped**. | OK |
| D3 | Published HTML may run **JavaScript** inside a sandboxed iframe (opaque origin, no `allow-same-origin`). | OK |
| D4 | A full documentation set is maintained in `docs/`. | OK |
| D5 | Follow established Azure DevOps extension conventions (manifest contributions, SDK lifecycle, Extension Data Service). | OK |
| D6 | The **Static** group's hubs are static manifest contributions: **Links, Pages, Pipelines, PR, Repos**. Admin-defined items live inside the hubs (`?page={slug}`), not as sidebar children. | OK |
| D7 | A readable query form `?page={slug}` is the accepted item URL (a clean path form is not available). | OK |
| D8 | Two-way sync of page-owned `?` variables is in scope (see [11](11-url-parameter-bridge.md)). | OK |
| D9 | The hub base URL is static; item state goes after `?`. | OK |
| D10 | A custom hub's base URL is platform-generated (`/{org}/{project}/_apps/hub/{publisher}.{extension}.{hubId}`); item identity is `?page={slug}`. A clean path is not achievable. | OK |
| D11 | Documents are addressed by an explicit `id` in the body; `DELETE` by id works; an empty collection `LIST` returns 404. | OK |
| D12 | Sizes use **1024-based (IEC)** units (`B`, `KiB`, `MiB`, `GiB`). | OK |
| D13 | v1 publishes a **single self-contained HTML file** per page; multi-file pages are a later enhancement (Q15). | OK |
| D14 | The **Static** group is **always visible**; there is no per-project or org-wide switch. Feature Management is CORS-blocked and contributions are static. | OK |
| D15 | Two Marketplace editions of one code base: **`static`** (stable, from `main`) and **`static-dev`** (private, from `develop`), publisher `f-steff`. | OK |
| D16 | Dynamic link targets that depend on a build are stored **by name** (`{{stage}}`/`{{job}}`/`{{task}}` plus `{{dyn}}`) and resolved at open time; a missing target shows a clear message. | OK |
| D17 | The optional report tab attaches the page HTML to the build as a `static-page-html` attachment, shown by our own build-results tab (distinct from Html Reports' `report-html`). | OK |
| D18 | The link builder's Area is short and derived from the URL: **Repo, PR, Pipeline, Artifact, Fixed**. | OK |
| D19 | The URL parser accepts the **project GUID** as well as the project name (some Azure DevOps URLs use the GUID). | OK |
| D20 | Publishing runs from **GitHub Actions**; versions are derived from git tags and each published version is tagged `vX.Y.Z`. | OK |

## Open questions

| # | Question | Why it matters | Handling |
| --- | --- | --- | --- |
| Q4 | Do we support **public projects**? Extension Data is unavailable to non-member users there. | Audience and error handling. | Out of scope for v1; document the limitation. |
| Q9 | Is a **comment** a single current value or a history? | Data model and UI. | Single current comment; revisit if requested. |
| Q10 | Should renaming a slug keep **redirects** from old slugs? | Link stability. | Defer; warn admins on rename. |
| Q13 | Repo table performance for projects with many/large repos. | NFR-PERF-1. | Commit counts are paged with a cap and loaded progressively. |
| Q14 | Should content ever be shared across projects? | Scope model. | No for v1. |
| Q15 | How should **multi-file pages** be supported? | Authoring model and effort. | v1 single file; then bundle/inline at publish; then a virtual file host. See [03](03-architecture.md#multi-file-pages). |

Resolved questions (kept for context): dynamic sidebar children (D6); path vs query and round-trip
(D7, D8); per-document size limit = 5,244,928 bytes (D12, [04](04-data-model.md)); publisher/ids
(D15); gzip compression is the default; `System.AccessToken` publishing works.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Extension Data size ceiling too small for huge reports | A very large page can't be stored | Chunk + compress; a clear failure when a chunk still exceeds the limit. |
| Publish races / partial writes | Corrupt or stale pages | Content-first ordering; `__etag` read-modify-write; reconciliation. |
| Azure DevOps global PAT retirement (2026-12-01) | Publish pipeline breaks | Migrate publishing to Microsoft Entra ID (GitHub OIDC) before then. |
| Marketplace publisher verification pending | Only the "verified" badge; the public listing may wait for it | Publisher created; verification is a background to-do. |
| Public projects unsupported | Audience limitation | Scope v1 to private projects; document. |

## Resolved-by-design notes

- Internal ids, content hashes and revision counters are storage-only and never surface in
  user-visible page/link URLs (FR-PRIV-2).
- The admin UI never renders or accepts HTML (FR-PRIV-1).
