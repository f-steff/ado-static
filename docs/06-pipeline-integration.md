# 06  -  Pipeline Integration

Content and links are **pipeline-only**. The supported ways to change content are the
`PublishPage` and `PublishLink` tasks. The admin UI never accepts HTML.

## Reference behaviour

The *Html Reports* extension (`blakyaks.azure-pipeline-html-reports`) is the inspiration for the
publishing DX:

- A task takes a report file/directory and an optional tab name.
- Reports are stored as **build attachments** and shown in a build-results tab.
- Reports must be **self-contained**; external CSS/links don't work due to CORS.

Static differs in one important way: a page is **project-scoped and persistent**, not tied to a
build. The self-contained guidance is reused, and the optional report tab mirrors the attachment
idea.

## `PublishPage` task

### Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `page` | No* |  -  | Enabler: the page slug to create/update. |
| `sourcePath` | Yes |  -  | HTML file to publish (used for the page **and** the tab). |
| `tabName` | No* |  -  | Enabler: attach the HTML as a build-results report tab with this name. |
| `comment` | No | (none) | Comment stored on the page when provided. |
| `createIfMissing` | No | `true` | Create the page when the slug does not exist. |
| `chunkSizeKb` | No | `3072` | Maximum compressed bytes per stored document. |
| `organizationUrl` | Yes | `$(System.CollectionUri)` | Organization URL. |
| `accessToken` | Yes | `$(System.AccessToken)` | Requires "Allow scripts to access the OAuth token". |
| `publisher` / `extension` | Yes | `f-steff` / `static` | Extension ids (`static-dev` for the dev edition). |

> `page` and `tabName` are **enablers**: set `page` to publish a Static page, set `tabName` to
> publish a build-results report tab, or set both to publish both. With neither, the task fails with
> a hint (nothing to publish). `sourcePath` is required either way.

### Task identity

- Type: `ms.vss-distributed-task.task`.
- Id: `PublishPage`; pipeline alias `PublishPage@0` (the task's major version is 0).
- Implementation: a dependency-free Node 20 task.

## `PublishLink` task

A pipeline can publish a **fixed link** - a stored URL that need not point inside this project
(e.g. a report or artifact hosted elsewhere). This is the "fixed pipeline artifact" area. The task
writes the same `links` document the web extension reads, so the link appears in the Links hub
immediately.

### Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `title` | Yes |  -  | Link title shown in the hub. |
| `slug` | Yes |  -  | Stable, unique slug. |
| `url` | One of |  -  | The URL to store (absolute http(s)). |
| `urlFile` | One of |  -  | A text file whose **first line** is the URL (any/all line endings, or none). Used when `url` is empty. |
| `comment` | No |  -  | Comment stored on the link. |
| `createIfMissing` | No | `true` | Create the link when the slug does not exist. |
| `organizationUrl` | Yes | `$(System.CollectionUri)` | Organization URL. |
| `accessToken` | Yes | `$(System.AccessToken)` | Requires the OAuth token on the pipeline. |
| `publisher` / `extension` | Yes | `f-steff` / `static` | Extension ids. |

Published links are stored with `area: "fixed"` and `source: "pipeline"`, and `updatedBy` records
the build number. A trashed slug is reserved (the task fails with a hint), mirroring pages.

## Report tab (optional)

`PublishPage` can also attach the page's HTML to the build so it appears under a **Static page** tab
in the build results. It is opt-in: set `tabName`, or leave it empty for no tab.

- The task emits `##vso[task.addattachment type=static-page-html;name=<tab>~<job>~<stage>~<attempt>~<file>;]<path>`.
- The extension contributes a `ms.vss-build-web.build-results-tab` that lists those attachments and
  renders the selected one in a sandboxed iframe; the selected attachment is reflected in the URL
  (`?pagetab=<name>`) so it is bookmarkable.
- The attachment type is `static-page-html`, deliberately different from Html Reports'
  `report-html`, so the two extensions never show each other's reports.
- The tab only appears for builds that ran `PublishPage` (`supportsTasks`).

## Example YAML

```yaml
steps:
  - task: PublishPage@0
    displayName: 'Publish coverage page + tab'
    condition: succeededOrFailed()
    inputs:
      page: 'coverage-report'
      sourcePath: '$(Build.ArtifactStagingDirectory)/coverage/index.html'
      tabName: 'Coverage'
      comment: 'Nightly coverage'
      createIfMissing: true

  - task: PublishLink@0
    displayName: 'Publish the latest report link'
    inputs:
      title: 'Latest report'
      slug: 'latest-report'
      url: 'https://example.com/report.html'
```

Publish only a tab (no page), or only a page (no tab), by omitting the other enabler. A link's URL
may also come from a file:

```yaml
  - task: PublishLink@0
    inputs:
      title: 'From a file'
      slug: 'from-file'
      urlFile: '$(Build.ArtifactStagingDirectory)/link.txt'
```

## Authentication

The tasks write through the extension's data REST endpoint using `$(System.AccessToken)`:

```
PUT https://extmgmt.dev.azure.com/{org}/_apis/ExtensionManagement/InstalledExtensions/{publisher}/{extension}
      /Data/Scopes/Default/Current/Collections/static-{projectId}/Documents/{docId}?api-version=3.1-preview.1
```

The task needs the extension's `{publisher}.{extension}` ids (its inputs default to the stable
edition; dev pipelines pass `extension: static-dev`). Requires "Allow scripts to access the OAuth
token" on the pipeline.

> The data scope is per **extension id**, so the two editions keep **separate** data. Naming an
> edition that is not installed fails with `GET ... -> 500 {"message":"TF400898: An Internal Error
> Occurred."}` (the service answers 500, not 404, for a missing data scope); the task adds a hint
> that names the mismatch. A report-tab-only publish (no `page`) writes a build attachment rather
> than extension data, so it can succeed even while the page publish fails.

## Content lifecycle

| Event | Effect |
| --- | --- |
| Page created (admin) | Index entry with `sizeBytes: 0`, no content docs (FR-PUB-1). |
| First publish | Writes chunks -> `content-meta` -> updates the index entry; sets size/comment/updated. |
| Subsequent publish | Replaces content atomically; bumps `contentVersion`; deletes obsolete chunks. |
| Clear (admin) | Deletes content docs; `sizeBytes: 0`; keeps the page. |
| Delete (admin) | Moves the page to the trash; content docs are purged when the trash entry is purged. |

Atomicity rule (NFR-REL-1): **content chunks first, metadata last, index last**. A reader never
observes metadata that references missing chunks.

## HTML authoring guidance

- One self-contained file per page (inline CSS/JS; avoid external references). See
  [03](03-architecture.md#multi-file-pages) for why.
- Link between pages with their hub URL (`?page={slug}`), not filesystem-relative links.
- Keep individual pages reasonably sized; chunking is supported, but split very large reports.

## Failure modes

Every failure reports an error line plus an actionable `hint:` line. The sandbox pipeline's error
probes exercise each one.

| Condition | Behaviour |
| --- | --- |
| Required input missing/empty | Fail: "Required input 'x' is missing or empty" + hint. |
| Invalid slug | Fail: "Invalid ... slug 'x'" + hint with the allowed shape. |
| Reserved slug (`static`) | Fail: "The ... slug 'static' is reserved". |
| Slug exists in the **Trash** | Fail: "... is in the trash and its slug is reserved" + hint to restore/delete it. |
| `createIfMissing=false` and missing | Fail + hint to create it or enable creation. |
| Source/URL file missing | Fail with the resolved path + hint about the input. |
| Invalid `url` | Fail + hint that an absolute http(s) URL is required. |
| Invalid `organizationUrl` | Fail: "Invalid organizationUrl: 'x'" + hint with the expected shape. |
| Rejected/expired token (non-JSON sign-in response) | Fail: "returned a non-JSON response" + hint to enable the OAuth token and check the extension. |
| Chunk exceeds the per-document limit | Fail before writing: "Chunk N would exceed the per-document limit" + hint to lower `chunkSizeKb`. |
| Auth rejected (401/403) | Fail with the REST status + the same token hint. |
| Network failure | Fail with the underlying message + a connectivity hint. |
| `__etag` conflict | Retry read-modify-write once; on a permanent conflict, fail with a re-run hint. |
