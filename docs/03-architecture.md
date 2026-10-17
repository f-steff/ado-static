# 03  -  Architecture

## Components

| Component | Runs in | Responsibility |
| --- | --- | --- |
| **Links / Pages / Pipelines / PR / Repos hubs** | Azure DevOps host iframes (web extension) | Render the project directory: curated links, the page list + sandboxed viewer, and project summaries. |
| **Project settings (admin)** | Project settings iframe | Manage links, pages, pipelines visibility and repos; Trash; About. |
| **Organization settings (orgadmin)** | Collection settings iframe | Overview of Static usage across the organization's projects. |
| **Report tab (`reporttab`)** | Build results iframe | Render the HTML a `PublishPage@0` run attached (opt-in via `tabName`). |
| **`PublishPage` task** | Build/release agent | Publish/update a page's content and, optionally, a build report tab. |
| **`PublishLink` task** | Build/release agent | Create or update a fixed link. |
| **Extension Data Service** | Azure DevOps | Persist project data (index, content, links, proposals) in the `Default/Current` scope, per-project collection `static-{projectId}`; private links live in the `User/Me` scope of `static-{projectId}-private` ([04](04-data-model.md)). |
| **Azure DevOps REST APIs** | Azure DevOps | Git (repos/commits/PRs) and Pipelines (definitions/builds/timelines) data for the hubs. |

```
+---------------------------- Azure DevOps web host ----------------------------+
|  project sidebar                  main region (#skip-to-main-content)         |
|  +----------------+               +--------------------------------------+   |
|  | Static group   |  select hub   | hub iframe (extension origin)        |   |
|  |  Links         | ------------> |  list / viewer / summaries           |   |
|  |  Pages         |               |  pages viewer = sandboxed <iframe>   |   |
|  |  Pipelines     |               +------------------+-------------------+   |
|  |  PR | Repos    |                                  |                       |
|  +----------------+          Project/Org settings iframes                      |
+------------------------------------------------------+------------------------+
                                                       | Extension Data Service
                        pipeline agent ----------------+
                        [PublishPage / PublishLink tasks]
```

## Extension manifest

The manifest is a shared base plus per-edition overrides (one code base, two Marketplace
editions):

```
ado-manifests/
  azure-devops-extension-base.json     # shared contributions, files, scopes, listing content
  azure-devops-extension-dev.json      # id=static-dev, name="Static (Dev)", public=false
  azure-devops-extension-stable.json   # id=static,     name="Static",        public=true
```

Key points:

- The group targets `ms.vss-web.project-hub-groups-collection` (top-level project navigation).
  The hubs `static`, `static-links-hub`, `static-pipelines-hub`, `static-pr-hub` and
  `static-repos-hub` target `.static-hub-group`.
- Project settings target `ms.vss-web.project-admin-hub-group`; organization settings target
  `ms.vss-web.collection-admin-hub-group`.
- `PublishPage` and `PublishLink` are `ms.vss-distributed-task.task` contributions; the report
  tab is a `ms.vss-build-web.build-results-tab` contribution whose `supportsTasks` lists the
  `PublishPage` task id, so it only appears for builds that ran it.
- `files` ships `dist` (addressable) plus the individual PNG icons and the two task folders.
- Scopes: `vso.extension.data_write` (our own data), `vso.code` (repos/commits/PRs),
  `vso.build` (pipelines/builds/timelines).
- The Marketplace listing content (`marketplace-advertisement.md`, `LICENSE`), `repository`, `links`, `tags` and
  `categories` live in the base manifest.

## Runtime patterns

- **SDK lifecycle**: `SDK.init()` -> `SDK.ready()` -> paint the heading -> `notifyLoadSucceeded()`
  -> load data -> fill rows. Failures call `SDK.notifyLoadFailed(message)`.
- **Auth**: `const token = await SDK.getAccessToken()` then
  `fetch(url, { headers: { Authorization: `Bearer ${token}` } })`.
- **Navigation**: `ms.vss-features.host-navigation-service`
  (`IHostNavigationService.getQueryParams()` / `.navigate(...)` / `.setQueryParams(...)`); child
  slugs are addressed with `?page={slug}` (see [05](05-navigation-and-urls.md)).
- **Storage**: the Extension Data Service (see [04](04-data-model.md)).
- **Report tab**: `SDK.getConfiguration().onBuildChanged(...)` gives the build; the tab lists the
  build's `static-page-html` attachments and renders the chosen one in a sandboxed iframe.
- **Logging**: shared `common/log.ts` with the `__DEV__` define and a `[pages-ext]` prefix.

## Hosting and iframe security

Page HTML is arbitrary and untrusted. Rendering strategy:

1. The hub iframe (extension origin) fetches the selected page's content.
2. It renders a **separate inner iframe** whose `srcdoc` contains the page HTML, created with:

   ```html
   <iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads" ...></iframe>
   ```

   - `allow-scripts` satisfies FR-RND-3 (self-contained reports need JS).
   - `allow-popups`(+`-to-escape-sandbox`) lets a page open a popout/fullscreen view in a real
     new browser tab; `allow-downloads` lets it export files (e.g. CSV).
   - The host origin is **not** `allow-same-origin`, so scripts get an opaque origin and cannot
     read the host's cookies/DOM or the extension frame.
   - No `allow-top-navigation`, no `allow-modals`.
3. The content never executes in the extension's own origin.

> Do **not** add `allow-same-origin` together with `allow-scripts` for untrusted content - that
> combination defeats the sandbox.

## Multi-file pages

v1 publishes **one self-contained HTML file** per page. A page made of several files
(`index.html`, `app.js`, `style.css`, referenced by relative paths - some computed at runtime)
is a possible later enhancement.

### Why v1 requires a single file (rationale)

The constraint follows from the security decision (sandboxed content with an opaque origin, no
`allow-same-origin`):

1. **No base URL to resolve against.** Content is written with `srcdoc`, so its document URL is
   `about:srcdoc` with an opaque origin; `./app.js` has no meaningful base.
2. **Stored content is not a web host.** Pages live as JSON documents in the Extension Data
   Service, which needs an authorization token and serves no path hierarchy or per-file MIME
   types, so `<script src>` / `<link href>` cannot point at it.
3. **Static rewriting is insufficient.** Inlining static `<link>`/`<script src>` works only for
   fixed paths; JS-computed paths and relative `fetch()` have nothing to resolve against.
4. **A real origin requires dropping the sandbox.** Serving `/pages/{id}/...` from a Service
   Worker on the extension origin needs `allow-same-origin`, which lets content reach the
   extension frame and its tokens - unacceptable privilege escalation.
5. **Related mechanisms make the same assumption.** Web Workers, ES modules and dynamic
   `import()` expect a real same-origin document.

Because (4) is the only full-fidelity path and it breaks the security model, **v1 requires one
self-contained HTML file per page**.

### Options

| Option | How | Effort | Notes |
| --- | --- | --- | --- |
| **1. Single file (v1)** | Authors inline everything. | done | Simplest. |
| **2. Bundle/inline at publish** | The task inlines static `<link>`/`<script src>` references from the same publish set. | low | Does not help JS-computed paths or runtime `fetch`. |
| **3. Virtual file host at render** | Store the file set; inject a runtime that patches `fetch`/`XMLHttpRequest` to resolve relative URLs against it via the postMessage bridge. | medium | Keeps the sandbox; Workers/dynamic `import()` remain limits. |
| **4. Same-origin hosting (Service Worker)** | Serve `/pages/{id}/...`; drop the sandbox. | high | Best fidelity, but content gets the extension origin. Not recommended. |

## Authentication and scopes

| Caller | Credential | Used for |
| --- | --- | --- |
| Hubs / settings iframes | `SDK.getAccessToken()` (delegated) | Extension Data Service, Git/Pipelines REST. |
| `PublishPage` / `PublishLink` tasks | `$(System.AccessToken)` | Writing content/metadata/links via the Extension Data REST endpoint. |

The tasks write through `https://extmgmt.dev.azure.com/.../Collections/static-{projectId}/Documents`
under the extension identity, so the token must be authorized for that extension's data. The
token needs "Allow scripts to access the OAuth token" enabled on the pipeline.

### Permission-aware UI (D27)

The hubs are readable by every project member, so a control that only works for some of them must ask
first. `src/common/permissions.ts` probes the **caller** with the documented Security REST API
(`GET /_apis/permissions/{namespaceId}/{bit}?alwaysAllowAdministrators=true`), resolving the numeric
bit from the namespace definition by action name; the response parsing is pure logic in
`src/common/permission-parse.ts` (unit tested). Two probes exist:

| Probe | Namespace | Action | Used for |
| --- | --- | --- | --- |
| `canAccessProjectSettings()` | Project | `MANAGE_PROPERTIES` (project token) | Wording the Links hub empty state for members who cannot open Project settings. |
| `canAccessOrgSettings()` | Collection | `GENERIC_WRITE` | Showing or hiding the Org.Settings button on the project settings page. |

A probe that cannot be evaluated returns `null` (**unknown**) and the caller keeps showing the
control: hiding it from a user who does have access is the worse failure, and the host denies the
action anyway. These probes decide **what the UI offers**, not what the service allows - the
extension data service authorizes every write itself.

## Sequences

```
Browse links:  Nav -> Links hub
  SDK.ready(); getQueryParams()
  no ?page=     -> list this project's links
  ?page={slug}  -> resolve dynamic/fixed target and navigate the host

View a page:   Nav -> Pages hub
  no ?page=     -> list this project's pages
  ?page={slug}  -> read the content docs and render in a sandboxed iframe

Publish a page / report tab:  Pipeline -> PublishPage task
  read source; gzip + chunk; write content chunks, then meta, then index
  if tabName: emit a build attachment (type static-page-html)
  hub / report tab: next load sees the new size/comment/updated and renders it

Publish a link:  Pipeline -> PublishLink task
  read url or urlFile; upsert the link in the links document (area=fixed, source=pipeline)

Private links and proposals:  Links hub -> private store -> project settings
  hub: read the user's store (User/Me scope) + the project's proposal list; render both tables
  Share: write a snapshot to `link-proposals` (state=open) and mark the private link `proposal`
  settings: review the snapshot; Add to project creates a normal link, Reject marks the record
  hub (next visit): reconcile() promotes (removes the private original) or marks the rejection
```
