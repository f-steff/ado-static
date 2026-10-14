# 13  -  Test Plan & Version Checklist

A repeatable plan run against **every** uploaded extension version. Every functional
requirement (FR-*) maps to at least one case below. Record results per version at the bottom;
revise the plan whenever a feature changes.

Required readings: [02-requirements.md](02-requirements.md), [04-data-model.md](04-data-model.md),
[05-navigation-and-urls.md](05-navigation-and-urls.md), [07-admin-experience.md](07-admin-experience.md).

## Process (per version)

1. Run the **automated** suite (`npm test`) and the type check (`npx tsc --noEmit`) - both must
   pass before building.
2. `npm run build:dev && npm run package:dev` -> `<publisher>.static-dev-<version>.vsix`.
3. Upload via the Marketplace publisher portal: publisher -> extension row -> context menu ->
   **Update** -> attach the `.vsix` -> **Upload**; wait until the publisher list shows the new
   version (verification takes minutes).
4. Confirm Azure DevOps installed it: **Organization settings -> Extensions** -> **Installed
   version** equals the new version.
5. Run the **automatic integration** cases (token/REST driven) and the **manual** cases in the
   dedicated debug browser (`AGENTS.md`, one tab).
6. Record Actual/Result per case, fix, bump the version, and repeat until all cases pass.

Legend: **OK** = pass, **NOTE** = partial (see Notes), **FAIL** = fail, **-** = not run /
not applicable, **MAN** = requires a human mouse (cross-origin iframe clicks cannot be scripted).

## Environment and preconditions

- Extension installed and shared with the test organization (`README.md`).
- Test projects: `SampleProject` (has pages/pipelines) and an empty project (for isolation checks).
- The `sandbox` repo pipeline uses the task alias `PublishPage@0`.
- A project-collection administrator account (for Project and Organization settings).
- Debug browser running (`chrome-live`), exactly one tab.

## Connections that must be exercised

| # | Connection | Where exercised | Notes |
| --- | --- | --- | --- |
| C1 | Marketplace upload + verification + ADO install | TC-01 | manual/publisher portal |
| C2 | Extension -> Extension Data REST (`extmgmt.dev.azure.com`) read | TC-17, TC-30 | CORS-allowed |
| C3 | Extension -> Extension Data REST write (create **and** update with `__etag`) | TC-04, TC-07, TC-10 | versioning; B2 |
| C4 | Extension -> `_apis/projects` (project list) | TC-15 | CORS-allowed |
| C5 | Extension -> Feature Management (must be rejected) | TC-28 | CORS-blocked (accepted) |
| C6 | Pipeline -> `PublishPage` task -> Extension Data (create + update) | TC-22, TC-23, TC-25 | `System.AccessToken` |
| C7 | Hub iframe <-> sandboxed content bridge (query params) | TC-20 | postMessage |
| C8 | Extension -> Git REST (`/git/repositories`, `/commits`, `/refs`) | TC-14 | `vso.code` |

## Automated tests (no ADO host required)

`npm test` bundles `tests/logic.test.ts` with esbuild and runs Node's test runner. It covers the
pure logic that previously had to be checked by hand:

| AT | Area | Verifies | Related case |
| --- | --- | --- | --- |
| AT-1 | Size formatting | 1024-based B/KiB/MiB/GiB/TiB, guards for 0/negative/NaN/Infinity | TC-17 |
| AT-2 | Slug validation | pattern, case-insensitive uniqueness, empty-is-neutral, reserved slugs | TC-04 |
| AT-3 | Add page | defaults (order/enabled/hidden), duplicate slug (live and trashed) rejected | TC-04, TC-13 |
| AT-4 | Immutability | mutations never modify the input index | TC-04, TC-10 |
| AT-5 | Update page | patches only the target page | TC-05, TC-07, TC-08, TC-09 |
| AT-6 | Trash | move-to-trash retains metadata; restore appends; purge reports pageId | TC-10, TC-11, TC-12 |
| AT-7 | Retention | strict 5-day cutoff for auto-purge | TC-13 |
| AT-8 | Clear | resets size, bumps `contentVersion`, clears updated stamp | TC-06 |
| AT-9 | Org stats | page count, total size, latest update | TC-15 |
| AT-10 | Feature URL | Feature Management route shape | TC-28 |
| AT-11 | URL helpers | `withQueryParam` insert/replace/remove while preserving others; hub/settings URL shapes | TC-16, TC-31 |
| AT-12 | Filter | case-insensitive substring; input order preserved | TC-14, TC-15 |
| AT-13 | Relative time | coarse ages; future timestamps clamped | TC-14 |

## Test cases

### TC-01  -  Upload, install, version  (C1)
Upload the new `.vsix`; wait for verification; open **Organization settings -> Extensions**.
**Expected:** the publisher list shows the new version; ADO **Installed version** = new version.

### TC-02  -  Sidebar navigation  (FR-NAV-1, FR-NAV-4)
Open `SampleProject`.
**Expected:** the **Static** group shows **Links**, **Pages**, **Pipelines**, **PR** and **Repos**
(always visible - D14).

### TC-03  -  Project settings loads  (FR-ADM-1, FR-PRM-1)
Open **Project settings -> Pages**.
**Expected:** loads without the ADO timeout, no console errors, ADO-themed borders/table header/
focus rings. The page is only reachable via Project settings (project-admin permission).

### TC-04  -  Add page and slug validation  (FR-ADM-2, FR-URL-4)
1. Empty form: the primary button is disabled; the hint is neutral (not red).
2. Enter an invalid slug (`My Report`, `a--b`, `-x`): red outline + guidance.
3. Enter a reserved slug (`static`): rejected with "reserved".
4. Add `my-report`: it appears in the table with size `0 B`, no comment, "never".
5. Reload: the page persists.
6. Try to add the same slug again (including different case): rejected ("already exists").
**Expected:** all of the above; the primary action never submits an invalid form.

### TC-05  -  Edit / rename / comment  (FR-ADM-3, FR-ADM-8)
Edit a page: change the name and comment; the slug field is locked; save.
**Expected:** the new name/comment persist after reload; the slug is unchanged.

### TC-06  -  Clear content  (FR-ADM-5)
Publish content (TC-22), then **Clear** the page and confirm.
**Expected:** confirmation shown; size returns to `0 B`; the page remains with its metadata;
"updated" becomes "never"; the content documents are gone (verify via TC-30).

### TC-07  -  Enable / disable a page  (FR-ADM-6)  [regression: B4]
Toggle a page's **Disable** then **Enable**.
**Expected:** the status column flips enabled/disabled. A disabled page's **name** is muted but
its action buttons remain normal (not ghosted) and clickable. (Previously the whole row was
dimmed, making "Enable" look disabled even though it worked.)

### TC-08  -  Hide / unhide a page  (FR-ADM-6)
Hide a page, then unhide it.
**Expected:** the status column shows "hidden"; the hidden page is omitted from the hub list
(TC-17) but a direct `?page=<slug>` link still renders it; unhide restores it to the list.

### TC-09  -  Reorder pages  (FR-ADM-7)
With two or more pages, press the up/down arrows.
**Expected:** the order changes and persists after reload; up is disabled on the first row and
down on the last.

### TC-10  -  Delete moves to Trash  (FR-ADM-11)
Delete a published page and confirm.
**Expected:** the page disappears from the table and appears under **Trash** with its name, slug
and delete timestamp; its content is retained (restorable). The slug is now reserved (TC-04.6).

### TC-11  -  Restore from Trash  (FR-ADM-11)
Restore the entry from TC-10.
**Expected:** the page returns to the end of the table with its size/comment intact; it is
removed from Trash.

### TC-12  -  Delete instantly  (FR-ADM-11)
Delete a trashed page with **Delete instantly** and confirm.
**Expected:** confirmation shown ("cannot be undone"); the entry and its content documents are
removed (verify via TC-30); the slug becomes free again.

### TC-13  -  Trash retention and slug reservation  (FR-ADM-11)
1. Move a page to Trash; try to create a new page with the same slug -> rejected.
2. Simulate an entry older than 5 days (edit `deletedUtc` via TC-30) and reload the admin.
**Expected:** on load, entries older than 5 days are auto-purged; the slug is then reusable.

### TC-14  -  Repos hub: list, statistics, filter, link  (FR-REPO, C8)
Open `SampleProject` -> **Repos**.
1. Every repository is listed, each name a link to the repository.
2. Statistics fill in: main contributor (first name; hover shows the full name), default branch,
   last commit, all-time commits, committers and branches.
3. Type in the filter: the list narrows case-insensitively, like the org project filter.
**Expected:** the list and statistics load with no errors; the git calls return 200; the repo
link opens the repository.

### TC-15  -  Organization project statistics and filter  (C4)
Organization settings -> Projects table.
**Expected:** columns **Project / Links / Pages / Pipelines / PRs / Repos** populate (values
right-aligned except the Project column); the case-insensitive name filter narrows the list.

### TC-16  -  Page link navigation and URL  (FR-NAV-2, FR-URL-2/3/5)
On the **Pages** landing, click a page name (first add an unrelated param, e.g. `&x=1`).
**Expected:** the hub reloads to the same URL with `page={slug}` inserted/replaced and `x=1`
preserved; the address bar carries the unique `?page=` URL; the view shows only that page's
content (no list). Refresh keeps the same page.

### TC-17  -  Hub list: size, hidden, disabled  (FR-ADM-9)
Open the Pages hub with several pages (published, hidden, disabled).
**Expected:** the list shows name/slug/**size (B/KiB/MiB)**/comment/updated/status; hidden pages
are omitted; a disabled page shows "disabled" and opening it shows a "Page disabled" notice
instead of content.

### TC-18  -  Hub render and sandbox  (FR-RND-1/2/3, NFR-SEC-1/3)
Open a published page containing
`<script>document.body.textContent='hi'</script>` and a script that tries to read
`parent.document` / `top.location`.
**Expected:** the script runs inside the frame; it cannot read or alter the host page (opaque
origin); the content fills the content region.

### TC-19  -  Deep link and refresh  (FR-URL-5)
Open `.../_apps/hub/...?page=<slug>` directly and press F5.
**Expected:** the same page renders; the address bar keeps `?page=<slug>`.

### TC-20  -  Two-way parameter bridge  (FR-URL-6, C7)
Open `...?page=<slug>&a=b`; use the page's parameter API to change `a`; then clear it.
**Expected:** the host URL reflects content-initiated changes; content receives host changes;
clearing a key removes it while keeping `page`.

### TC-21  -  Not-found state  (05)
Open `...?page=does-not-exist`.
**Expected:** a clean "Page not found" notice inside the content region; the URL is kept.

### TC-22  -  Pipeline publish (create)  (FR-PUB-4/5, C6)
Run the `sandbox` pipeline with `publishPage=true` against a new slug.
**Expected:** the `PublishPage@0` task succeeds; the hub then shows content and a non-zero size
in KiB/MiB, the comment, and the build's update time/author.

### TC-23  -  Pipeline publish (update) and etag  (FR-PUB-4, NFR-REL-2, C6)  [B2]
Re-run the pipeline for the same slug.
**Expected:** the task succeeds (no "document version does not match"); the page's
`contentVersion` increments; size/comment/updated reflect the new run; content is not corrupted.

### TC-24  -  Publish to a missing page with `createIfMissing=false`  (FR-PUB-6)
Run the task against an unknown slug with `createIfMissing=false`.
**Expected:** the task fails with an actionable error naming the slug; nothing is created.

### TC-25  -  Large content / chunking  (NFR-SCALE-1, C6)
Publish a page several MiB in size.
**Expected:** the task chunks under the per-document limit (multiple content docs); the hub
re-renders the full content; the reported size equals the decoded byte length.

### TC-26  -  Theme  (TC-10)
Toggle ADO light/dark and revisit the hub and both settings pages.
**Expected:** colours/borders follow the host theme (palette RGB triplets used correctly).

### TC-27  -  Error surfacing
Force a failure (e.g. break a write / stop the network).
**Expected:** the message includes the underlying name/message/HTTP status, never `[object Object]`.

### TC-28  -  Documented limitation: Feature Management CORS  (C5, D14)
Attempt a Feature Management read/write from the extension.
**Expected:** blocked (`MissingAllowOriginHeader`); the extension does not depend on it
(enablement is stored via Extension Data). Known and accepted.

### TC-29  -  Automated suite  (AT-1..AT-10)
`npm test`.
**Expected:** all unit tests pass; `npx tsc --noEmit` is clean.

### TC-30  -  Data-layer verification via REST  (C2, C3)
From an ADO page, reuse the extension's bearer token to read/write the Extension Data REST API.
**Expected:** the `index` and `content-*` documents match the UI; used to confirm
retention/clear/purge and `contentVersion` without needing iframe clicks.

### TC-31  -  Settings links (organization <-> project)  (07)
1. Organization settings -> Pages: click a project name.
2. On that project's Pages settings page, click **Organization settings**.
**Expected:** (1) opens that project's Pages settings; (2) returns to the organization overview.

### TC-32  -  PublishPage error probes  (06)
Run the `sandbox` pipeline with `errorProbes=true` (seven probes, each `continueOnError`).
**Expected:** each probe fails with a clear `##[error]` plus a `hint:` line: missing file,
invalid slug, reserved slug, `createIfMissing=false`, bad organization URL, rejected token
(non-JSON/sign-in response), and chunk-too-large.

### TC-33  -  Real pipeline (status-page) publishes through the task  (C6, C8)
Run the `status-page` pipeline, which now ends with `PublishPage@0` publishing `$(OUT_HTML)` as
slug `status-page`.
**Expected:** the build succeeds and the `status-page` page appears in the hub with content and a
size; the dashboard loads in the sandbox.

### TC-34  -  Content popout opens a new browser tab  (11)
On the `status-page` page, use the dashboard's fullscreen/popout control.
**Expected:** a new browser tab opens the hub URL for that page (carrying the current state),
not a blocked popup and not `about:srcdoc`.

### TC-35  -  "Save view" survives a reload and a content upgrade  (11)
On the `status-page` page, click **Save view**, then reload and (after an extension update)
revisit the page with no page-owned params.
**Expected:** the saved view is restored from the extension-hosted store (the content's own
`localStorage`/cookies are unavailable in the sandbox).

### TC-36  -  Links hub and admin  (FR-LINK)
1. Project settings -> Static: **Links** tab; add a link (Title, slug, in-project build URL, comment).
   Pasting an external or wrong-org/project URL is rejected with a reason.
2. Open the **Links** hub ("Static links"): the link is listed (Title, Slug, Comment); clicking it
   opens the target in the same tab.
3. Copy the row href and open it (`?page={slug}`): it resolves to the target.
4. Delete the link -> **Trash** tab; Restore; then Delete instantly.
**Expected:** all of the above; slugs are reserved while trashed.

### TC-37  -  Dynamic links: repositories  (FR-LINK, 11)
1. Static settings -> **Repos** tab; pick a repo and use **Newest open PR** / **Oldest open PR** /
   **Latest commit** (the Links form is pre-filled with a `{{dyn}}` URL).
2. Save. Open the link (or its `?page={slug}` bookmark).
**Expected:** the hub resolves the dynamic value at click time (`vso.code`) and navigates to the
current target (verified: a "latest commit" link navigated to the tip sha of `main`). No open PR /
no commit yields a graceful message.

### TC-38  -  Dynamic links: "latest build" updates with the pipeline  (FR-LINK)
Create a build link whose Dynamic target is Latest / Latest succeeded / Latest failed (the URL
keeps the concrete `buildId` as a fallback).
**Expected:** after a new pipeline run completes, using the link opens the **new** build. NOTE:
resolving "latest" needs the `vso.build` scope, which is not yet granted, so until then the link
falls back to the captured build id (it still works, just not dynamically).

### TC-39  -  Static settings tabs and global trash  (07)
Open Project settings -> Static.
**Expected:** tabs **Links / Pages / Pipelines / Repos / Trash / Org.Settings / About**; the Trash
tab is a single list with a **Type** column (Page / Link) and Restore / Delete instantly.

### TC-40  -  PR hub  (FR-PR)
Open the **PR** hub.
**Expected:** all project pull requests are listed (Title -> link, Repository, Author, Created
(relative), Status (incl. draft), source -> target branches), newest first, with a name filter.

### TC-41  -  Organization statistics columns  (C4)
Organization settings -> Static.
**Expected:** **Project / Links / Pages / Pipelines / PRs / Repos** all populate; the name filter
narrows the list.

### TC-42  -  Cascading link builder  (FR-LINK)
Static settings -> Links: choose an **Area** (Repository), then a repository, then a target
(newest/oldest open PR, latest commit on the default branch, or another branch). Change an early
level and confirm the later levels reset but are **remembered** when you return to the earlier
choice. Then use **Add link**: only the slug clears, so a second link can be created from the
same selections; **Clear** resets everything.
**Expected:** a valid link exists when an option is marked `[valid]`; several levels may be valid;
the built URL appears in the URL box; Add is disabled until a valid target + title + slug exist.

### TC-43  -  Repos tab (link type + hide)  (FR-REPO)
Static settings -> Repos: pick a **Link type** and press **Create** (the Links form is pre-filled);
untick **Show in hub** for a repository and confirm it disappears from the public **Repos** hub.
**Expected:** the shortcut pre-fills a dynamic link; hidden repos are excluded from the hub.

### TC-44  -  Icons  (FR-UI)
1. Open a project's **Static** group: the group shows the cube icon and each child (Links, Pages,
   Pipelines, PR, Repos) shows **its own** icon.
2. Every page heading (all hubs + both settings pages) shows the small icon.
**Expected:** all icons render (headings use an inlined data URI, so they never depend on a fetch).

### TC-45  -  Settings tabs are instant and reversible  (FR-UI-3)
On the org and project settings, switch tabs.
**Expected:** switching is instant (a same-document hash change, no reload/blank); the URL shows
`#<tab>`; the browser Back returns to the previous tab.

### TC-46  -  URL parser is lossless  (FR-LINK)
Paste each of these into Links and confirm the builder shows enough levels, the parameters are
named (or `fixed (value)`), and the stored URL is **not truncated**:
- `.../_build/results?buildId=4531&view=results`
- `.../_build/results?buildId=4531&view=codecoverage-tab`
- `.../_build/results?buildId=4531&view=artifacts&pathAsName=false&type=publishedArtifacts&path=/drop`
- `.../Some%20Team/_build/results?buildId=4531&view=logs&s=<stage>&j=<job>&t=<task>`
- `.../_git/<repo>`, `.../_git/<repo>?path=/a/b&version=GBmain&line=10`,
  `.../_git/<repo>/pullrequests?_a=active`, `.../_git/<repo>/pullrequest/42`,
  `.../_git/<repo>/commit/<sha>`, `.../_git/<repo>/branches`, `.../_git/<repo>/tags`
- a custom view id (`...&view=<extension>.build-html-reports-tab`)
**Expected:** one level per parameter; reconstructing yields the original URL; unknown parts are
labelled `fixed (value)`. (Automated coverage in `tests/logic.test.ts`.)

### TC-47  -  Create from Repos/Pipelines parses and is reversible  (FR-LINK)
In the Repos (or Pipelines) tab press **Create**.
**Expected:** the Links tab opens with the URL pre-filled **and parsed** (builder levels shown);
the browser Back returns to the Repos/Pipelines tab.

### TC-48  -  Pipelines hub and tab  (FR-REPO-like, C6)
Open the **Pipelines** hub and the Pipelines settings tab (needs `vso.build`).
**Expected:** pipelines list with **runs / last result (links to the build) / last run / fails
since last success**; the settings tab offers a Link type + Create.

### TC-49  -  Enumerate real links  (FR-LINK)
Walk the project's real pages and links; for each, confirm the parser/resolver handles it, and add
any new shape to the tests and this plan.
**Expected:** all real links parse and resolve; new shapes are added to `tests/logic.test.ts`.

### TC-50  -  Org overview columns and alignment  (FR-UI-4)
Open the organization settings overview.
**Expected:** the table has **Project, Links, Pages, Pipelines, PRs, Repos** only (no **Total size**,
no **Updated**); every header and cell is **right-aligned except the Project column** (left).

### TC-51  -  Project total size  (FR-UI-4)
Open Project settings -> **Pages** tab.
**Expected:** a summary line reads "<n> page(s), total content size <size>." (sizes are 1024-based).

### TC-52  -  Per-hub heading icons  (FR-UI-2)
Open each hub (Links, Pages, Pipelines, PR, Repos) and both settings pages.
**Expected:** each page heading shows **its own** hub icon (Pages/Links/Pipelines/PR/Repos); the
settings pages show the group cube. Icons are inlined data URIs (no network fetch).

### TC-53  -  Icon sources and packaging  (NFR-package)
Inspect `images/`.
**Expected:** the SVG sources (icon.svg, icon-links/pages/pipelines/pr/repos.svg) and the shared
`background.svg` are kept here; the packaged `.vsix` contains **only the PNGs** (no SVG, which the
Marketplace rejects).

### TC-54  -  Pipeline chain is modifyable and self-correcting  (FR-LINK)
Paste a deep build-log URL (e.g. `/_build/results?buildId=4531&view=logs&s=<stage>&j=<job>&t=<task>`).
**Expected:** the chain shows **Pipeline -> Fixed build -> Build <id> -> Logs -> Stage -> Job ->
Task** (pipeline named, build named); changing the pipeline reloads the build numbers and the view
(Logs) is kept; changing the build re-resolves stage/job/task to the closest match; an unknown
build id shows "Build <id> (invalid)" but the URL is never truncated.

### TC-55  -  URL catalog is complete  (FR-LINK)
Review [`14-ado-urls.md`](14-ado-urls.md).
**Expected:** every in-project URL shape we know of is listed; each parses in the builder or is
stored as a fixed link; the list is mirrored by automated tests.

### TC-56  -  Fixed links (any URL)  (FR-LINK)
In Project settings -> Links, choose Area = **Fixed (any URL)** and enter a URL outside this project
(e.g. `https://example.com/report.html`); also paste such a URL into the URL field.
**Expected:** the form accepts the URL (only absolute http(s) is allowed; `javascript:`/`data:` are
rejected); saving stores it (area `fixed`); reopening it preselects **Fixed**.

### TC-57  -  Publish a link from a pipeline  (FR-PUBLISH)
Run the **Publish Link** task (`PublishLink@0`) with `title`, `slug`, `url` (and optionally
`comment`).
**Expected:** the link appears/updates in the Links hub with area `fixed` and `updatedBy` = the
build; a trashed slug fails with a clear hint; a missing `createIfMissing=false` target fails with
a clear hint. (Automated: `fixedUrlError` cases; integration via a sandbox pipeline run.)

### TC-58  -  Flat, named pipeline targets are easy to change  (FR-LINK)
Paste a deep build-log URL, then change only the **build** level.
**Expected:** the level after the build is a single flat list of clearly named targets
("View: Results", "View: Logs", "Logs: <stage> / <job> / <task>"); changing the build regenerates
the list and re-selects the same-named target automatically (no need to redo later levels); a filter
box appears when the list is long. (Automated: `viewFragmentMatches`.)

### TC-59  -  Every link type has an area  (FR-LINK)
Confirm the **Area** choices cover the project: Repository, **Pull request**, Pipeline, Fixed.
**Expected:** Pull request lists a repository's open PRs by title; Repository lists named targets
(root/branches/tags/PR list/latest commit/PRs by title); Pipeline is the build chain; Fixed is any
URL. Shapes we cannot parameterise are stored as fixed.

### TC-60  -  Hubs switch without a blank "Loading..."  (NFR-UX)
Switch between the sidebar hubs (Links, Pages, Pipelines, PR, Repos).
**Expected:** each hub's heading appears at once; rows fill in progressively with a
"Loading ..." row, never a blank frame.

### TC-61  -  About describes both publish tasks  (FR-PUBLISH)
Open the About tab (project and org settings).
**Expected:** both **Publishing a page (pipeline)** and **Publishing a link (pipeline)** sections are
present, each showing the task YAML and the `createIfMissing` switch (true creates when missing;
false fails when missing and updates an existing slug).

### TC-66  -  Other areas documented and planned  (FR-LINK)
Review [`15-ado-other-areas.md`](15-ado-other-areas.md).
**Expected:** Wiki/Dashboards/Boards/Test Plans/Artifacts/Environments/Releases are explained with
URL shapes, an integration assessment, and a Sandbox test plan.

### TC-62  -  A log target survives pipeline/build/mode changes  (FR-LINK)
Paste a **specific-build** log URL that names a stage/job/task (e.g. with `s`, `j`, `t`), then
change the build or the mode (e.g. to **Latest build**).
**Expected:** the target is kept ("Logs: <stage> / <job> / <task>") and the stored URL carries the
name placeholders `{{stage}}`/`{{job}}`/`{{task}}` (never the old build's ids); opening the link
resolves the ids for the build it points at, and a missing target shows a graceful message.

### TC-63  -  Paste is lossless (no dropped parameters)  (FR-LINK)
Paste URLs whose view/params the builder does not model (a custom view id, an artifact `path`).
**Expected:** every parameter the target does not itself encode becomes a fixed level, so the stored
URL equals the pasted URL (plus the name placeholders for logs).

### TC-64  -  PublishLink reads the URL from a file  (FR-PUBLISH)
Run `PublishLink@0` with `urlFile` pointing at a text file (CRLF, LF, CR, and no trailing newline).
**Expected:** the first line is used; a BOM is ignored; an empty result fails with a clear hint.

### TC-65  -  Optional report tab  (FR-PUBLISH)
Run `PublishPage@0` with `tabName` set.
**Expected:** the build results show a **Static page** tab rendering the page HTML in a sandboxed
iframe; with no `tabName` no attachment is added and the tab shows a gentle note.

### TC-67  -  PublishPage page/tab enablers  (FR-PUBLISH)
Run `PublishPage@0` with (a) both `page` and `tabName`, (b) only `page`, (c) only `tabName`, (d)
neither.
**Expected:** (a) publishes a page and a tab; (b) a page only; (c) a tab only; (d) fails with a clear
hint. The About pages show both enablers.

### TC-68  -  Report sub-tabs are bookmarkable  (FR-PUBLISH)
Publish **two** tabs for one build, open the **Static page** tab, and click a report.
**Expected:** a tab strip lists each attachment; clicking one adds `pagetab=<name>` to the build URL,
so the specific report can be bookmarked/shared.

### TC-69  -  Global PR jump (organization-wide)  (FR-PR)
On the PR hub, type a PR number (in any state) and press Jump.
**Expected:** PR numbers are **organization-global**, so the number alone is resolved across the
whole organization (its project/repository are looked up on jump): a valid number opens that PR
(any project/repo); an unknown number briefly shows "Unknown #<n>" and keeps the number so it can be
corrected. (Automated: `pullRequestWebUrl`, `isValidPullRequestId`.)

### TC-70  -  Short Area labels and no-wrap columns  (FR-UI)
Open Project settings -> Links (and the other tabs).
**Expected:** the Area column shows short labels (**Repo**, **PR**, **Pipeline**, **Artifact**,
**Fixed**); the Title and Area columns do not wrap, on every tab. (Automated: `linkAreaLabel`.)

### TC-71  -  Unmodelled/out-of-project URL becomes Fixed  (FR-LINK)
Type (or paste) an in-project URL we do not model (e.g. the Static settings URL) into the URL field.
**Expected:** the Area auto-selects **Fixed** and the URL is kept; a concrete-build **log** link no
longer shows the red "missing placeholder" error (log tokens count), and it does not re-parse/jump
on blur. Informational builder notes are neutral, not red. (Automated: `hasAnyToken`.)

### TC-72  -  View actions open in a new tab  (FR-UI)
Project settings -> Pages (and Links): press **View** on a row.
**Expected:** the page viewer / link target opens in a **new browser tab** (pages: the hub viewer
`?page=<slug>`; links: the hub bookmark, which resolves dynamic/fixed links).

### TC-75  -  Backup downloads and restores the organization  (FR-ADM, C1)
Organization settings -> Static -> **Backup**. Choose **Download backup**; then open the other
edition (`static` <-> `static-dev`) in the same organization, choose that ZIP as the **Backup file**,
and press **Restore**.
**Expected:** choosing the file alone writes nothing and shows the project/document counts between
the file field and the button; the **Restore** button then shows an inline confirmation directly
beneath it and applies it on confirm. The ZIP holds `static-backup.json` with
one entry per project that has data (`index`, `links`, `content-meta-*` / `content-*`, `repos`);
pages restore **in full** (open one in the other edition and compare it with the original); no
`__etag` appears in the file; a non-ZIP file, a ZIP without `static-backup.json`, or JSON with a
wrong `format` is rejected with a clear message and nothing is written; projects that no longer exist
are skipped and reported. (Automated: `buildBundle` / `parseBundle` / `encodeBundle` / `decodeBundle`
/ `writeZip` / `readZip` / `crc32` / `backupFileName`.)

### TC-76  -  StaticAdmin backs up and restores an organization  (FR-PUBLISH, C1)
Run `StaticAdmin@0` with `mode: backup` and `artifactName: static-backup`; then, against the
downloaded archive (in the other edition), `mode: restore`; then once more with `dryRun: true`.
**Expected:** the backup writes a ZIP containing `static-backup.json` (`format: "static-export"`,
schemaVersion 2) with one entry per project that has data, sets `StaticBackupProjects` /
`StaticBackupDocuments`, and attaches the artifact; the restore writes the same pages and links into
the target edition (open a page to confirm the content), replaces data the archive does not contain,
and sets `StaticRestoreProjects`; a dry run logs the plan and writes nothing; a wrong `extension`
(for example `static` while only `static-dev` is installed) fails with the edition-mismatch hint.
(Automated: `tests/tasks.test.js` - ZIP round-trip, CRC, stored-entry read and bundle parsing.)

### TC-77  -  Tasks auto-detect the installed edition  (FR-PUBLISH)
Run any task (`PublishPage@0`, `PublishLink@0`, `StaticAdmin@0`) **without** setting `extension`, in
an organization with exactly one edition installed.
**Expected:** the log says `Using Static edition '<id>'`, the pipeline variable `StaticExtension` is
set for later steps, and the task works; with **both** editions installed it uses `static` and warns
that the input should be pinned; with **neither** installed it fails with the install hint.
(Automated: `autoEditionChoice` in `tests/tasks.test.js`.)

### TC-78  -  The Restore flow is one visible sequence  (FR-ADM)
Open Organization settings -> Static -> Backup and exercise the restore row (`Restore`, `Clear`,
`Confirm restore`).
**Expected:** before a file is chosen, `Restore` and `Clear` are inactive and `Confirm restore` is
**hidden** (no bare confirmation buttons); choosing a usable file shows its summary above the row and
activates `Restore` and `Clear`; `Restore` replaces the summary with the question and reveals
`Confirm restore`; `Clear` returns to the initial state (file and summary cleared); `Confirm restore`
performs the restore and the status line then reports `Restored N project(s), M document(s).` (or
`Restore failed: ...`), with the row back to its initial state. (Regression found on 0.0.8: the
confirmation was visible from the start with no question, because `[hidden]` was outranked by the
row's `display`.)

### TC-79  -  A release publishes both editions at one version  (process, D24)
Merge `develop` into `main`.
**Expected:** the run computes `0.<minor + 1>.0`, publishes the **stable** edition, tags it, then
publishes the **dev** edition at the **same** version (the Marketplace shows both editions at that
version, and the dev edition then moves to `<minor>.<revision + 1>` on the next `develop` merge); the
two publish workflows share one concurrency group, so they cannot interleave on the tag sequence; a
manual *Publish dev* run with a `version` input publishes exactly that version and skips tagging when
the tag already exists. (Automated: the bump rules are covered by `tests/version.test.mjs`.)

### TC-80  -  A run says what it published, and keeps testers confidential  (process)
Open a completed *Publish dev* / *Publish stable* run, the commit it ran on, and a `Share dev` run.
**Expected:** the run page shows a **summary** naming the edition, version, tag and listing URL; the
commit carries a status `Marketplace: static` / `Marketplace: static-dev` described as
`Published Static <version>`; `Share dev` reports only the **number** of organizations that currently
have access plus the publisher page link - the organization it acted on appears **nowhere** in the run
name, the step names, the log (tfx's `Sharing extension with ...` is masked to `***`) or the summary.
GitHub cannot rename a run after creation, so the run list shows `run-name` rather than the computed
version. (Automated: `summariseSharedWith` in `tests/shared-with.test.mjs` asserts that names never
appear.)

### TC-81  -  A pipeline run carries no annotations  (process)
Open any recent CI or publish run and look at its Annotations panel.
**Expected:** nothing but the run's own output - no Node.js deprecation (the actions use the current
Node major), no Ubuntu migration notice (the runner image is pinned to `ubuntu-24.04`), and no eslint
warnings (`npm run lint` fails on any warning, so one cannot reach a run).
(Automated: `npm run lint` with `--max-warnings 0` is part of the local gate and of every workflow.)

### TC-82  -  Only develop reaches main, and merged branches disappear  (process, D26)
Open a pull request from a feature branch into `main`, then one from `develop` into `main`.
**Expected:** the feature-branch pull request **fails the `release-source` check** ("Only the
'develop' branch may be merged into 'main'") and cannot merge, while the `develop` -> `main` one
passes; a pull request cannot merge before `build` succeeds; and once any pull request merges, GitHub
deletes its head branch - `git ls-remote --heads` lists only `main` and `develop`.

### TC-73  -  Trash retention and "Permanent delete by"  (FR-ADM)
Open Project settings -> Trash.
**Expected:** the table shows a **Permanent delete by** column (`deletedUtc` + 5 days). Retention is
enforced **lazily** (no background job): on load of the Pages hub, the Links hub, or the project
settings admin, items trashed more than 5 days ago are permanently removed (with their content
docs). (Automated: `trashExpiryUtc`, `expiredTrashEntries`.)

### TC-74  -  Publish task names a missing edition  (FR-PUBLISH)
Run `PublishPage@0` / `PublishLink@0` with the default `extension: static` while only `static-dev`
is installed.
**Expected:** the task fails with the `GET .../InstalledExtensions/f-steff/static/...` error
(`500 TF400898`) **plus a hint** that the publisher/extension inputs must name an installed edition
(`static` for stable, `static-dev` for dev). A report-tab-only publish (no `page`) still succeeds
because it writes a build attachment, not extension data. (MAN: needs an org where only one edition
is installed - verified with build 4595 in such an organization.)

## Results log

### 0.2.0 (stable; first release of the code the dev editions carried) - process cases

Released on 2026-10-14 by merging `develop` into `main` (PR #32). The extension content is the code the
dev editions carried (unchanged since the `static-dev` builds swept below), so this block records what
is specific to the release: the automated gate, the release mechanics, and the process cases.

| Case | Result | Evidence |
| --- | --- | --- |
| TC-29 | OK | `npx tsc --noEmit` clean, `npm run lint` 0 warnings (`--max-warnings 0`), **72/72** tests, `verify:clean` clean - locally and in the `Verify` step of the release run |
| TC-79 | OK | `Publish stable (release)` run 38613402269: all 12 steps green; **`static` 0.2.0** (public listing) and **`static-dev` 0.2.0** published at the same version; tag `v0.2.0` points at the merge commit that is `main`'s head; the merge triggered exactly two runs (`Publish stable` + `CI`) |
| TC-81 | OK | The release run carries **no annotations** (every step `success`, no warning/error annotation) |
| TC-80 | OK | The run names the outcome and the version (`Summarise what was published`, commit status `Marketplace: static: Published Static 0.2.0`). The organization is invisible in `share dev` - dispatched on `main` (run 38614439140, after the release brought the fixed workflow there): **0** raw occurrences in the log, 7 redacted lines, `Sharing extension with ***.` |
| TC-82 | OK | The release arrived as a `develop` -> `main` pull request and `release-source` passed; the feature branch was deleted on merge; only `main` and `develop` remain |

Sharing is not touched by a publish: the release log reports `Sharing: not shared (use --share-with to
share)` for both editions, so the organizations already shared keep access to 0.2.0.

> Follow-up (cosmetic): the release records only the **stable** commit status, so the dev edition
> published at the same version has no status of its own.

### 0.0.9 (dev edition) - restore flow, and a full backup/restore round trip

Run on 2026-10-14 against the deployed `static-dev` 0.0.9 (the build released from the restore-flow
change).

| Case | Result | Evidence |
| --- | --- | --- |
| TC-78 | OK | The whole sequence was driven in the tab: **initial** (`Restore` and `Clear` inactive, `Confirm restore` hidden) -> **file chosen** (`<file>: 1 project(s), 3 document(s) from <organization>. Choose Restore to apply it.`, both active, Confirm still hidden) -> **Restore** (question moved into the status line, `Confirm restore` shown and active, `Restore` inactive) -> **Clear** (status and file cleared, both inactive, Confirm hidden again) |
| TC-75 | OK | `Download backup` saved a 51,661-byte archive (`1 project(s), 50 KiB.` reported in the tab); choosing it showed the counts; `Confirm restore` performed the write and reported `Restored 1 project(s), 3 document(s).`, then returned the row to its initial state |
| TC-75 (data) | OK | Straight after the restore the Pages hub still lists the page (206.3 KiB, `Build: 20261014.4`) and the organization overview still reports Pages=1 / Pipelines=2 / Repos=8 for the project - the round trip preserved the stored data |

> The restore in this run used an archive taken minutes earlier, so it wrote back the same state; the
> write path, the `replace` semantics and the reset behaviour were exercised for real.

### 0.0.8 (dev edition; one organization, one project)

Run on 2026-10-14 against the deployed `static-dev` 0.0.8. "pipeline" = verified through a real
pipeline run (build ids in the evidence).

| Case | Result | Evidence |
| --- | --- | --- |
| TC-01, TC-03 | OK | Footer `Static 0.0.8`; project settings loads with tabs Links/Pages/Pipelines/Repos/Trash (0)/About |
| TC-36, TC-70 | OK | Links table headers: Title, Slug, Area, URL, Comment |
| TC-51 | OK | Pages tab: "1 page(s), total content size 206 KiB." |
| TC-73 | OK | Trash headers include "Permanent delete by" |
| TC-45 | OK | Settings tabs switch in place and set the host hash (`#about`, `#backup`) |
| TC-52 | OK | Each hub and settings page heading shows its own icon |
| TC-02, TC-17, TC-18, TC-60 | OK | All five hubs render headings/subtitles/columns with no blank "Loading" row: pages (1 row, 206.3 KiB), links (empty state), pipelines (2 rows), pr (Jump + empty state), repos (8 rows) |
| TC-14, TC-40, TC-48 | OK | Repos / PR / Pipelines hubs show their columns and live data |
| TC-41, TC-50 | OK | Organization overview: 13 project rows, columns Project/Links/Pages/Pipelines/PRs/Repos |
| TC-75 | OK | Backup tab: swap warning present; file field labelled "Backup file (ZIP)"; choosing a real backup shows `<file>: 1 project(s), 3 document(s) from <organization>`; Restore disabled until a file is chosen |
| TC-78 | FAIL -> fixed | The confirmation row was visible before pressing Restore (`[hidden]` outranked by `display: flex`); fixed with `.confirm-row[hidden] { display: none }` |
| TC-46, TC-49, TC-54, TC-63, TC-71 | OK | Parser corpus: build results (URL kept verbatim); logs with `s`/`j`/`t` (`&s={{stage}}&j={{job}}&t={{task}}`, chain `Logs: __default / Job / Publish data cache`); repository file and PR list (Repository chain, URL kept); external URL (Fixed); custom view + extra param (both kept as levels - lossless) |
| TC-16, TC-19 | OK | `?page=<slug>` renders the stored page: its headline and controls appear in the sandboxed child frame |
| TC-21 | OK | `?page=no-such-page-xyz` -> "No page with the slug 'no-such-page-xyz' exists in this project." |
| TC-29 | OK | `tsc` clean, 59/59 unit tests, lint 0 errors, `verify:clean` clean |
| TC-53 | OK | Packaged VSIX: 8 PNGs, 0 SVGs, all three task folders, `overview.md` + `LICENSE` |
| TC-74 | OK (pipeline) | Build 4599: `extension: static` (not installed) failed with the edition-mismatch hint |
| TC-77 | OK (pipeline) | Build 4601: no `extension` input -> `Using Static edition 'static-dev'.`, then published the page |
| TC-76 | OK (pipeline) | Build 4605: backup wrote 38,410 bytes (1 project, 3 documents) and attached the artifact; the dry-run restore reported "would restore 1 project(s), 3 document(s); no writes were made" |

Not covered by this sweep: the cross-origin iframe clicks that need a human mouse (add/edit/delete
page and link, dialog confirmations) and the report tab (TC-65, TC-68). The destructive restore write
path could not be exercised on 0.0.8 (the confirmation controls were broken - see TC-78); it was
verified for real on 0.0.9 above.

### Legacy: 0.1.41 (pre-migration, previous repository)

Run on 2026-10-07. "MAN" = still needs a human mouse (cross-origin iframe); those are marked
so they are not mistaken for passes. 0.1.20 added the `vso.code` scope, which required an
organization admin to re-approve permissions before the Git calls succeeded. 0.1.21 fixed a
page-link reload race; 0.1.22 renamed the child hub **Pages** -> **List**.

| Case | Result | Evidence / Notes |
| --- | --- | --- |
| TC-01 | OK | Publisher list shows 0.1.20; ADO **Installed version = 0.1.20** (after scope re-approval) |
| TC-02 | OK | Sidebar nav verified: **Pages** group with children **List** and **Repos** (0.1.22) |
| TC-03 | OK | Project settings interactions reported working (user) |
| TC-04 | MAN | Add + validation clicks (create/duplicate/reserved) not scriptable; logic covered by AT-2/AT-3 |
| TC-05 | MAN | Edit/rename/comment clicks not scriptable; user reported Edit working |
| TC-06 | OK | Clear reported working (user); metadata reset logic covered by AT-8 |
| TC-07 | FIX+M | B4 fixed: only the page name is muted; action buttons are never dimmed. Needs a quick retest |
| TC-08 | OK | Hide/unhide reported working (user); hub omission implemented |
| TC-09 | MAN | Reorder clicks not scriptable |
| TC-10 | OK | Delete -> Trash reported working (user) |
| TC-11 | OK | Restore reported working (user) |
| TC-12 | OK | Delete instantly reported working (user) |
| TC-13 | NOTE | Slug reservation (AT-3) and 5-day purge (AT-7) unit-verified; UI auto-purge is MAN |
| TC-14 | NOTE | Repos hub: every git call (repositories/refs/commits) returned **200** from the extension origin (CORS + `vso.code` OK); main-contributor and filter logic unit-tested (AT-11/AT-12). Visual columns/filter are MAN |
| TC-15 | MAN | Org stats/filter rendering not scriptable; `/projects` + stats logic covered by AT-9 |
| TC-16 | NOTE | Page links use `withQueryParam` (unit-tested, AT-11) + `setQueryParams` + reload. Viewer deep link verified: `?page=test` fetched index + content (200). Click/address-bar visual is MAN |
| TC-17 | MAN | List size/status, hidden omission, disabled notice need a visual check |
| TC-18 | MAN | Sandbox isolation needs a visual check |
| TC-19 | NOTE | Direct `?page=test` loaded the index and content (200); visual render is MAN |
| TC-20 | MAN | Two-way param bridge needs a visual check |
| TC-21 | MAN | Not-found notice needs a visual check |
| TC-22 | OK | Builds 4521/4522 succeeded via `PublishPage@0`; page `test` created/updated (506 B) |
| TC-23 | OK | Re-run: `contentVersion` 4 -> 5, `updatedBy` = Build 20261007.10, no version error |
| TC-24 | MAN | `createIfMissing=false` failure path not exercised this run (logic unchanged) |
| TC-25 | OK | Large publish: 9 chunks (256 KiB each), reassembled 2,097,152 bytes, sha256 matches meta |
| TC-26 | MAN | Theme check needs a visual pass |
| TC-27 | MAN | Forced-failure message needs a visual pass |
| TC-28 | OK | Feature Management remains unused/CORS-blocked (accepted D14); the enable/disable feature was removed in 0.1.20 |
| TC-29 | OK | `npm test` 25/25 pass; `npx tsc --noEmit` clean |
| TC-30 | OK | Read `index`/`content-*` (200); index revision advanced |
| TC-31 | MAN | Link URLs unit-tested (AT-11); the org <-> project clicks are not scriptable |
| TC-32 | OK | Build 4529: all seven probes failed with the intended `##[error]` + `hint:` (E6 non-JSON/auth hint, E7 chunk-size hint verified after the 0.1.24 fix) |
| TC-33 | OK | Build 4526 (status-page) succeeded; page `status-page` = 203,301 B, `contentVersion` 1, published by `PublishPage@0` |
| TC-34 | MAN | Sandbox now allows popups and the bridge redirects `window.open(location.href)` to the hub URL; the click itself needs a human |
| TC-35 | MAN | `localStorage` override + extension-origin store shipped (override proven in a sandbox probe); the Save view -> reload click needs a human |

### Verified in 0.1.41 - 0.1.43 (Playwright driving the extension iframe)

The shared debug Chrome plus the Playwright MCP (CDP) can now read and click **inside** the
cross-origin extension iframe, so most previously-manual cases are automated. Confirmed on the
deployed extension (footer showed `Static 0.1.41`/`0.1.43`):

| Case | Result | Evidence / Notes |
| --- | --- | --- |
| TC-45 | OK | Settings tabs switch instantly; the URL gains `#pages`/`#links` (real history entries). |
| TC-50 | OK | Org overview shows Project/Links/Pages/Pipelines/PRs/Repos only (no Total size/Updated); values right-aligned, Project left. |
| TC-51 | OK | Project Pages tab shows "3 page(s), total content size 202 KiB." |
| TC-52 | OK | Heading icon is an inlined `data:image/png;base64` (no fetch); each hub passes its own icon. |
| TC-54 | OK | Pasting the deep log URL yields one clean chain: Pipeline -> status-page -> Fixed build -> Build 4531 (succeeded) -> View: Logs -> Stage: __default -> Job: Job (nested records resolve; no duplicated levels after the 0.1.43 paste guard). |
| TC-56 | OK | Area = Fixed accepts an external `https://` URL (Add enabled) and rejects `javascript:` ("Only http(s) URLs are allowed."); the created row shows Area `fixed`. |
| TC-57 | OK | Sandbox build **4566** ran the **PublishLink** task (result succeeded); link `latest-report` appeared with Area `fixed pipeline artifact`. (Demo link removed afterwards.) |
| TC-50 | OK | (0.1.44) Org headers right-aligned except Project (left) - confirmed via computed style (`Links/Pages/Pipelines/PRs/Repos` = right, `Project` = left). |
| TC-61 | OK | (0.1.44) About shows "Publishing a page (pipeline)" **and** "Publishing a link (pipeline)", both with the task YAML and `createIfMissing`. |
| TC-58 | OK | (0.1.44/0.1.45) Deep log URL -> Area=Pipeline, pipeline `status-page`, `Specific build...`, `Build 4531 (succeeded) - <date>`, then one flat named target `Logs: __default / Job`; a filter box appears for the long build/target lists. Changing the build to 4568 re-selected the same-named target automatically (0.1.45 soft memory). |
| TC-59 | OK | (0.1.44) Area choices: Repository, **Pull request**, Pipeline, Fixed. |
| TC-60 | OK | (0.1.44) The Pages hub paints `Static pages` immediately and fills rows progressively (no blank frame). |
| TC-62 | OK | (0.1.46/0.1.47) Pasted `buildId=4564&view=logs&s=..&j=..&t=..` -> chain `Logs: __default / Job / Publish CSV report`; switching the mode to **Latest build** kept the target and the URL became `buildId={{dyn}}&...&s={{stage}}&j={{job}}&t={{task}}`; opening the saved link resolved the ids for build 4564 (host landed on `buildId=4564&view=logs&j=12f1170f-...`). |
| TC-63 | OK | (0.1.46) Paste matching is by name and every unconsumed parameter is kept as a fixed level (automated: `targetMatches`/`consumedParams`). |
| TC-64 | OK | (0.1.48) Sandbox build **4571** ran "Publish link from file (urlFile): succeeded"; the link was created from a file written with `printf '%s'` (no trailing newline). |
| TC-65 | OK | (0.1.48/0.1.49) Sandbox build **4571** ran PublishPage with `tabName=Coverage`; the build results show a **Static page** tab that renders the attached HTML (attachment type `static-page-html`, name `Coverage~job~default~1~index.html`). |
| TC-67 | OK | (0.1.51/0.1.52) Sandbox build **4582**: the page step (page+tabName) and the tab-only step (no page) both succeeded; two attachments were recorded. |
| TC-68 | OK | (0.1.51) Build **4582** report tab shows two sub-tabs ("Coverage extra", "Coverage"); clicking one adds `&pagetab=Coverage~job~default~1~index.html` to the build URL. |
| TC-69 | OK | (0.1.53) Entering **377** on the PR hub jumped to a pull request in a **different project/repo** than the hub (`.../_git/other-repo/pullrequest/377`), so the number is resolved organization-wide; an unknown number showed "Unknown #999999" briefly and kept the number. |
| TC-70 | OK | (0.1.54) The Links table Area column shows **Pipeline** / **Repo** (short); Title/Area cells are nowrap. |
| TC-71 | OK | (0.1.54/0.1.55) Typing the Static settings URL set Area to **Fixed (any URL)**; pasting the concrete-build log URL gave a stable 5-level chain with **no red error** and a neutral builder note. |
| TC-72 | OK | (0.1.56) Pages **View** opened `.../static?page=status-page` in a new tab; Links **View** opened `.../static-links-hub?page=status-page-build` in a new tab. |
| TC-73 | OK | (0.1.56) Trash table headers are `Type | Title | Slug | Deleted | Permanent delete by`. |

### Version history

| Version | Automated | Manual | Summary |
| --- | --- | --- | --- |
| 0.1.10 | - | NOTE | Feature API CORS-blocked; styling broken |
| 0.1.11 | - | NOTE | Theme fixed; enablement still feature-based |
| 0.1.12 | - | NOTE | Reverted nav hiding; SDK writes failed |
| 0.1.13 | - | NOTE | Org-wide switch; SDK writes still failed |
| 0.1.14 | - | NOTE | Switched to REST; read OK; **update needs `__etag`** (B2) |
| 0.1.15 | - | NOTE | `__etag` fix; org stats; pipeline `PublishPage@0` |
| 0.1.16 | - | NOTE | ASCII-only cleanup; pipeline green (builds 4517 create, 4518 update) |
| 0.1.17 | - | NOTE | Trash added; org-disabled wording and admin Disable button regressions found (B4, B5) |
| 0.1.18 | OK | NOTE | B4/B5 fixes; hub hidden/disabled/not-found handling; pure logic extracted; 19 unit tests; full test plan; multi-chunk + pipeline verified |
| 0.1.19 | OK | NOTE | Guard against transient settings read being treated as disabled |
| 0.1.20 | OK | NOTE | Enable/disable removed; **Repos hub** (all-time stats + main contributor); page links do a full reload; org <-> project settings links; `vso.code` scope |
| 0.1.21 | OK | NOTE | Page-link reload waits for the host query to apply (race fix) |
| 0.1.22 | OK | NOTE | Sidebar child hub renamed **List** (was **Pages**) |
| 0.1.23 | OK | NOTE | Hash-parameter bridge; running-version indicator; actionable PublishPage errors + validation |
| 0.1.24 | OK | NOTE | Sandbox allows popups/downloads; `window.open(location.href)` opens the real hub URL in a new tab; E6/E7 probes fixed |
| 0.1.25 | OK | NOTE | Page `localStorage` ("save view") bridged to the extension origin so it survives content upgrades |
| 0.1.26 | OK | NOTE | Project-settings tables full width; actions on their own left-aligned row |
| 0.1.27 | OK | NOTE | **Links** hub + admin (in-project, validated); DOM dialogs (no window.confirm); "Title" label; centered version footer; in-content crumb + real Back navigation |
| 0.1.28 | OK | NOTE | Renamed group **Static** (List -> **Pages**); new **PR** hub; org stats add Links/Repos; Links page 3 columns + "Static links" heading |
| 0.1.29 | OK | NOTE | Dynamic links (`{{dyn}}` tokens + build/PR/commit resolvers); settings **tabs** (Links/Pages/Repos/Trash); **global Trash** with Type |
| 0.1.30 | OK | NOTE | Org **PRs** column (metrics alphabetical); full-width hubs; PR **open-only** by default; **cascading link builder** (with selection memory); Repos tab Link type + Create + **hide repo**; settings version footer; tab styling |
| 0.1.31..0.1.40 | OK | NOTE | Settings tabs made instant + reversible (hash `#tab`); per-hub sidebar **and heading icons** (inline data URIs); **Pipelines hub + tab** (`vso.build`); **global Trash** with Type; DOM dialogs; URL parser rebuilt (one level per part, `fixed (value)`, no truncation); Repos/PR/Pipelines "Create" + Back; About tab with package details |
| 0.1.41 | OK | NOTE | Org overview drops **Total size**/**Updated** and right-aligns everything except **Project**; project **Pages** tab shows total content size; **pipeline builder chain** (pipeline -> build mode -> build -> view -> stage/job/task, self-correcting); SVG sources + shared `background.svg` kept in `images/` (only PNGs packaged); [`14-ado-urls.md`](14-ado-urls.md) catalog; tests 35/35 |
| 0.1.42 | OK | NOTE | Pipeline chain resolves **nested** timeline records (Stage -> Phase -> Job -> Task) so a pasted `s/j/t` id shows its real name; build views labelled **View: ...**; re-entrancy guard on paste; tests 35/35 |
| 0.1.43 | OK | NOTE | **Fixed** link area (any http(s) URL; out-of-project URLs auto-store as fixed); new **PublishLink** pipeline task (`PublishLink@0`) publishes/updates a "fixed pipeline artifact" link; tests 37/37 |
| 0.1.44 | OK | NOTE | Org headers right-aligned except Project; About describes **both** publish tasks incl. `createIfMissing`; hubs paint the heading first then fill rows (no blank "Loading..." on switch); pipeline targets are one **flat, named** list (views + "Logs: stage / job / task") with a filter, re-selected by name when the build changes; new **Pull request** area and named PRs under a repository; tests 38/38 |
| 0.1.45 | OK | NOTE | Soft per-level builder memory: changing an earlier level (e.g. the build) re-selects the closest target by name, so a deep link can be retargeted to another/succeeded build without redoing the later levels; tests 38/38 |
| 0.1.46 | OK | NOTE | Log targets stored as **name placeholders** and resolved (or reported missing) at open time, so changing pipeline/build/mode keeps the location; paste matches by name and never drops params; dynamic specs merge; **PublishLink urlFile**; optional **PublishPage report tab** (`tabName`); tests 41/41 |
| 0.1.47 | OK | NOTE | `normalizeTokens`: stored/hand-edited links with percent-encoded placeholders still resolve; tests 42/42 |
| 0.1.48 | OK | NOTE | Docs: other areas ([15](15-ado-other-areas.md)), urlFile + report tab ([06](06-pipeline-integration.md)); About updates |
| 0.1.49 | OK | NOTE | Report tab reads the `{ value: [] }` attachment list (it was empty); tests 43/43 |
| 0.1.50 | OK | NOTE | Parser accepts the **project GUID** as the project segment (wiki/dashboard URLs) |
| 0.1.51 | OK | NOTE | PublishPage `page`/`tabName` **enablers** (page and/or tab); PR **Global PR #** jump; report sub-tabs reflected in the URL (`pagetab`) |
| 0.1.52 | OK | NOTE | Bump PublishPage task to 0.1.4 so ADO re-downloads the page-optional task (task content is version-keyed) |
| 0.1.53 | OK | NOTE | **Global PR jump resolves org-wide** via the org-level `_apis/git/pullrequests/{id}` route (PR numbers are org-global); pure `pullRequestWebUrl`/`isValidPullRequestId` + tests 45/45 |
| 0.1.54 | OK | NOTE | Short **Area** labels (Repo/PR/Pipeline/Artifact/Fixed), Title/Area no-wrap on all tabs, auto-**Fixed** for unmodelled URLs, and a fix for the false "missing placeholder" error on concrete-build log links; tests 47/47 |
| 0.1.55 | OK | NOTE | Builder notes are neutral (red reserved for validation errors) |
| 0.1.56 | OK | NOTE | Pages/Links settings gain a **View** action (opens in a new tab); Trash tables show **Permanent delete by** (deletedUtc + 5 days); the Pages hub now also enforces the 5-day lazy purge; tests 48/48 |
| 0.2.0 | OK | NOTE | **First stable release of the code the dev editions carried**: organization backup/restore (settings tab + `StaticAdmin@0`), the one-row restore flow, edition auto-detection (`extension: auto`), real About details; publishing is cloud-only (D21); both editions publish at one version (D24); share runs never name the organization; runs carry no annotations; only `main` and `develop` are long-lived (D26); tests 72/72 |

## Bugs found and fixed

| # | Version | Symptom | Cause | Fix |
| --- | --- | --- | --- | --- |
| B1 | 0.1.13 | "Unable to save settings: [object Object]" on enable | SDK data-manager `setDocument` writes failed opaquely | Switched data access to Extension Data REST (0.1.14) |
| B2 | 0.1.15 (found on 0.1.16) | Org toggle off worked, re-enable failed: 400 "The document version does not match" | Extension Data updates require the current `__etag` | Read-modify-write preserving `__etag` (+ retry) in extension and task |
| B3 | pipeline | "A task is missing ... PublishPage with version 1" | Task major version is 0, so the alias is `PublishPage@0` | Pipeline uses `PublishPage@0` |
| B4 | 0.1.17 (found by user) | Disabling a page dimmed the whole row, so the now-"Enable" button looked ghosted though clickable | `.disabled-row { opacity: 0.6 }` applied to the entire row | Mute only the page name (`.disabled-name`); never dim action buttons |
| B5 | 0.1.17 (found by user) | When Pages was disabled org-wide, the hub still showed the stale per-project wording ("Enable it under Project settings -> Pages") | `renderDisabled` text and no re-check of the org switch | Org-wide wording; throttled `checkEnablement()` reloads the hub when the switch changes |
| B6 | 0.2.0 (found in a `share dev` run) | A `share dev` run on `main` was marked **failed** although the share itself succeeded | The workflow on `main` referenced `ci/shared-with.mjs` and `scripts/tfx.js show`, which existed only on `develop` (a workflow-only sync) | The report reads the list with `npx tfx-cli` directly, prints a graceful fallback and is `continue-on-error`, so a report can never fail a share (#29) |
| B7 | 0.2.0 (found while testing B6) | The organization was printed in the run log: once through a step's `env:` block, four times through a job-level variable | The runner prints a step's `env:` block **before** the step runs, so `::add-mask::` cannot redact its own step (and inherited variables appear in every earlier step) | The value is read from the event payload file and handed on with `::add-mask::` and `eval` only - it never enters an `env:` block or the script text (#30, #31) |

## Remaining manual checks (cross-origin iframe)

The debug browser cannot click inside the extension iframe, so these still need a human:
TC-04/TC-05 (project admin add/edit), TC-09 (reorder), TC-13 (UI auto-purge), TC-15 (org
stats/filter), TC-17..TC-21 (hub list, sandbox, deep link, params, not-found), TC-24
(`createIfMissing=false`), TC-26/TC-27 (theme, forced error), TC-31 (settings links), plus a
visual pass on TC-14 (Repos columns/filter) and TC-16 (page-link click + address bar), and a
retest of the B4 fix (TC-07). Everything else is verified automatically (TC-29) or through the
data/network layer (TC-14, TC-16, TC-19, TC-30).
