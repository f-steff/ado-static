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
| D21 | Distribution targets **Azure DevOps Services (cloud) only**. On-premises Azure DevOps Server is a conscious non-goal: the packaged `extension.vsixmanifest` declares `<InstallationTarget Id="Microsoft.VisualStudio.Services.Cloud"/>` only, and every data call is cloud-fixed (`extmgmt.dev.azure.com` in the web extension and all three tasks, `dev.azure.com` in `listProjects`, and `organizationFromUrl` understands only `dev.azure.com` / `{org}.visualstudio.com`) - see the research note in [08](08-open-questions.md#research-kept-distribution-on-premises-and-vsix-artifacts). | OK |
| D22 | Publishing tasks resolve the edition at run time: `extension: auto` (the default) uses whichever edition is installed, so one pipeline serves a test organization and production; pin `static` to force release-only publishing, which then **fails** while only the development edition is installed (that failure is the point). | OK |
| D23 | Data is moved between the two editions with the **backup and restore** sequence (project-independent: organization settings -> Backup, or the `StaticAdmin@0` task). Only **one** edition can be installed in an organization at a time, and each owns a separate data scope, so a swap starts from an empty project - always back up first, uninstall, install the other edition, then restore. | OK |
| D24 | Both editions share **one tag sequence**: a `develop` merge publishes dev at `<released minor>.<revision + 1>` and a release (`main`) publishes **both** editions at the same version. A dev version therefore means "the current release plus N merges", and on release day a tester runs exactly the released code. | OK |

| D25 | The organizations the private dev edition is shared with are **confidential**: the share workflow takes the organization as a dispatch input, masks it with `::add-mask::` before use (which also redacts tfx's own output), and reports only a **count**; the names exist solely on the Marketplace publisher page. | OK |
| D26 | Only `main` and `develop` are long-lived branches; a branch is deleted when its pull request merges, and `main` can only be reached from `develop` (enforced by the `release-guard` check). Both branches require a pull request and the `build` check. | OK |
| D27 | Controls that only work for some users are **permission-aware**. The project settings page shows its **Org.Settings** button, and the Links hub words its empty state, from a Security REST probe of the caller (`GET /_apis/permissions/{namespaceId}/{bit}?alwaysAllowAdministrators=true`, the bit resolved from the namespace definition by action name). A probe that cannot be evaluated counts as **unknown** and the control stays visible: hiding something from a user who does have access is the worse failure, and the host denies the action anyway. | OK |
| D28 | **Private links** are stored in the extension data service's **User scope** (`User/Me`), never in the shared project collection behind an owner filter, so the service isolates them per user. A private link can be **shared**: that writes a frozen **snapshot** to the project's `link-proposals`, where anyone with access to that project's settings may **accept** (the link is promoted - the project owns it and it behaves like any added link) or **reject** (the owner keeps the private link and is told). The reviewer never writes to another user's store; the owner's client applies the outcome on its next visit, and an accepted proposal removes the private original. Private links are excluded from organization backups (the backup reads project collections only). | OK |
| D29 | A publish **tags as soon as the upload is accepted**: `scripts/tfx.js publish` passes `--no-wait-validation`, and the asynchronous Marketplace validation is *reported* (a `validate` step writes its output into the run summary) but never gates the tag. Rationale: the tag is the version source of truth (D20/D24), so a flaky validation status poll once left a published version untagged, after which every later publish of that branch failed with "Version number must increase" (Q19). | OK |

## Open questions

| # | Question | Why it matters | Handling |
| --- | --- | --- | --- |
| Q4 | Do we support **public projects**? Extension Data is unavailable to non-member users there. | Audience and error handling. | Out of scope for v1; document the limitation. |
| Q9 | Is a **comment** a single current value or a history? | Data model and UI. | Single current comment; revisit if requested. |
| Q10 | Should renaming a slug keep **redirects** from old slugs? | Link stability. | Defer; warn admins on rename. |
| Q13 | Repo table performance for projects with many/large repos. | NFR-PERF-1. | Commit counts are paged with a cap and loaded progressively. |
| Q14 | Should content ever be shared across projects? | Scope model. | No for v1. |
| Q15 | How should **multi-file pages** be supported? | Authoring model and effort. | v1 single file; then bundle/inline at publish; then a virtual file host. See [03](03-architecture.md#multi-file-pages). |
| Q16 | Should the **published VSIX** also be attached as a workflow artifact and/or a GitHub Release? | Consumer verification, archival, and installs on on-premises servers (D21). | Cheap as a workflow artifact on every publish; a GitHub Release only for **stable** tags is the useful part. Research kept below; not scheduled. |
| Q17 | The permission probes (D27) are only exercised with an **administrator** identity so far, which always answers "granted". | TC-83/TC-84 include the *negative* path. | Run them with a plain project member account; if a probe cannot be evaluated there, record `unknown` and keep the neutral wording. |
| Q18 | Private-link isolation (D28) and the proposal round trip are only exercised with **one** identity so far. | TC-85..TC-89 include "another member cannot see or change my links". | Run them with a second member account in the same project; the user-scoped store is the guarantee, and the case confirms it end to end. |

Resolved questions (kept for context): dynamic sidebar children (D6); path vs query and round-trip
(D7, D8); per-document size limit = 5,244,928 bytes (D12, [04](04-data-model.md)); publisher/ids
(D15); gzip compression is the default; `System.AccessToken` publishing works; a failed validation poll no longer blocks the version tag (Q19 -> D29).

## Research kept: distribution, on-premises and VSIX artifacts

Recorded while deciding D21 and Q16; kept because it answers recurring questions.

### Can a downloaded VSIX be installed by someone else?

- **Cloud: practically no.** Azure DevOps Services orgs install from the Marketplace; there is no
  per-organization VSIX upload. Only a **publisher** can upload a VSIX, and the package's identity
  (`<Identity Publisher="f-steff">`) binds it to that publisher, so a third party cannot re-upload it
  under their own account. Testers are therefore served the way `static-dev` works today: the
  private edition is shared with their organization and installed from *Shared with me* (D15).
- **On-premises: no, and that is deliberate (D21).** Three independent blockers: the packaged
  manifest installs only on `Microsoft.VisualStudio.Services.Cloud`; all data calls are cloud-fixed
  (`extmgmt.dev.azure.com`, `dev.azure.com`); and Azure DevOps Server uses a local extension gallery
  rather than Marketplace sharing. Supporting it would need the Server installation target plus
  host-derived URLs in four places (the web extension and the three tasks), plus testing on a server.

So a VSIX asset is valuable for **provenance and archival**, not as a distribution channel.

### Attaching the published VSIX (artifact and/or GitHub Release)

| Pros | Cons |
| --- | --- |
| The exact bytes published are archived and hash-verifiable. | Implies support for sideloaded builds, which bypass Marketplace validation and auto-update. |
| Gives GitHub Releases a home for per-version notes (`/releases/latest`, notifications). | Suggests on-premises support that does not exist, unless documented. |
| A Release per **stable** version is a citable artifact for audits/enterprise review. | A Release per `develop` merge would be meaningless noise. |
| Becomes the natural install channel if on-premises is ever supported. | The packaged VSIX is not covered by `verify:clean` (that scans the source). |
| Nearly free: CI already builds the VSIX. | If the release job rebuilds instead of reusing the uploaded file, hashes can differ. |

If it is ever implemented: attach the VSIX as a **workflow artifact on every publish** (dev and
stable); create a **GitHub Release only for stable tags**, using the same file that was published
(build once, reuse it) plus a `SHA256SUMS` and a note that the Marketplace is the only supported
install path; name development assets `static-dev-<version>.vsix` and never attach them to a Release.

### Publisher verification (the badge) and the flaky Details tab

Kept from the migration notes, because it explains why the verified-publisher badge is still pending.

- Verification is a **trust badge, not a publish gate** - publishing (including going public) works
  without it.
- Prerequisites: at least one **published extension for 6+ months**, and a **domain registered 6+
  months** ago.
- Flow: open the publisher's **Details** tab, save the domain, then add a **DNS TXT record** of the
  form `_visual-studio-marketplace-<publisher>.<domain>`.
- **Known fault:** on the publisher account the Details tab does not work - on page load
  `GET /_apis/gallery/publishers/<publisher>/azurepublisher` returns 404, and pressing Save fires no
  request, so no Details field persists. Believed to be a partially provisioned publisher / Entra ID
  (Azure AD) namespace association. It does not block publishing.
- Revisit before applying for the badge; if it persists, raise it with Marketplace publisher support
  rather than working around it.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Extension Data size ceiling too small for huge reports | A very large page can't be stored | Chunk + compress; a clear failure when a chunk still exceeds the limit. |
| Publish races / partial writes | Corrupt or stale pages | Content-first ordering; `__etag` read-modify-write; reconciliation. |
| Azure DevOps global PAT retirement (2026-12-01) | Publish pipeline breaks | Migrate publishing to Microsoft Entra ID via GitHub OIDC **before then**: a service principal added as a publisher member, so no long-lived secret is stored. |
| Marketplace publisher verification pending | Only the "verified" badge; not a publish gate | Prerequisites (6+ months published, 6+ months domain) plus a known publisher-side Details-tab fault - see the research note on publisher verification below. |
| Public projects unsupported | Audience limitation | Scope v1 to private projects; document. |

## Resolved-by-design notes

- Internal ids, content hashes and revision counters are storage-only and never surface in
  user-visible page/link URLs (FR-PRIV-2).
- The admin UI never renders or accepts HTML (FR-PRIV-1).
