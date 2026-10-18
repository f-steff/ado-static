# 04  -  Data Model

Storage backend: **Azure DevOps Extension Data Service**. All data is project-scoped, so each
project has an independent set of links and pages.

> NOTE The Extension Data Service is not available to non-member users of public projects.

## Extension Data Service essentials

- Documents: `getDocument` / `setDocument` / `deleteDocument` / `getDocuments`.
- Permissions: `vso.extension.data_write` (read + write) or `vso.extension.data` (read). Requests
  for another extension's data return HTTP 401 even under the same publisher.
- REST (used by the pipeline tasks):

  ```
  https://extmgmt.dev.azure.com/{org}/_apis/ExtensionManagement/InstalledExtensions/{publisher}/{extension}
        /Data/Scopes/Default/Current/Collections/{collection}/Documents/{docId}?api-version=3.1-preview.1
  ```

## Scoping model

The SDK supports only `Default` (account/collection) and `User` scopes - there is **no
per-project scope**. Per-project isolation is therefore done with a **per-project collection name**
inside the account-wide `Default/Current` scope. Both the web extension and the pipeline tasks use:

| Level | Scope | Collection | Data |
| --- | --- | --- | --- |
| Project | `Default` / `Current` | `static-{projectId}` | index, content, links, proposals, repo visibility |
| User (private links) | `User` / `Me` | `static-{projectId}-private` | the signed-in user's private links for that project |

`{projectId}` is the project GUID (`$(System.TeamProjectId)` in pipelines,
`SDK.getWebContext().project.id` in the web extension).

> **No shared fallback.** If the project id cannot be resolved, the extension refuses to read/write
> rather than falling back to a shared collection (which would leak data across projects).

## Collections and documents

| Document id | Shape | Notes |
| --- | --- | --- |
| `index` | `PageIndex` | Page metadata plus the page trash. |
| `links` | `LinkIndex` | Link entries plus the link trash. |
| `content-meta-{pageId}` | `ContentMeta` | Encoding, chunk count, decoded byte size, SHA-256, updated info. |
| `content-{pageId}-{nnn}` | `ContentChunk` | One chunk per document. |
| `repo-visibility` | `{ hidden: string[] }` | Repo ids hidden from the Repos hub. |
| `link-proposals` | `ProposalIndex` | Private links members offered to the project, awaiting a decision. |

### Private links (the `User` scope)

A **private link** belongs to one member and must not be visible to anybody else, so it is stored in
the service's **`User/Me` scope** rather than in the project's shared collection with an `ownerId`
filter: the service then does the isolation, and a mistake in our query cannot leak somebody else's
links. One store per user **per project** (`static-{projectId}-private`, document `private-links`),
because a link is always relative to the project it points into.

```jsonc
{ "id": "private-links", "kind": "private-links", "schemaVersion": 1, "revision": 2,
  "links": [ /* the same LinkEntry shape as project links */ ] }
```

A private link carries up to two extra fields:

- `proposal: { proposalId, proposedUtc }` - set while it is offered to the project (awaiting a decision);
- `rejectedUtc` - set when a proposal was rejected, so the hub can say so and offer Share again
  (editing the link clears it).

Private links work like project links otherwise: same builder, same validation, and a `?page=<slug>`
bookmark resolves them **only when no project link owns that slug** (project links win, so a private
slug can never shadow somebody else's link).

### `link-proposals`

```jsonc
{ "id": "link-proposals", "kind": "link-proposals", "schemaVersion": 1, "revision": 4,
  "proposals": [
    { "proposalId": "...", "privateLinkId": "...", "slug": "my-report", "title": "My report",
      "url": "https://dev.azure.com/...", "comment": "", "dynamic": { }, "area": "build",
      "proposedById": "...", "proposedByName": "Sam", "proposedUtc": "...",
      "state": "open",              // open | accepted | rejected
      "decidedUtc": "", "decidedBy": "", "acceptedLinkId": "" }
  ] }
```

The proposal holds a **snapshot**: later edits to the private link cannot silently change what the
reviewers approved. `privateLinkId` is what lets the proposer's client recognise the outcome - the
reviewer never needs (or is able) to write to another user's store:

| Decision | What happens |
| --- | --- |
| Accept | A project link is created from the snapshot (the project owns it, and it behaves like any added link); the record is marked `accepted` with `acceptedLinkId`. |
| Reject | The record is marked `rejected`; the member keeps the private link and sees "Not accepted. Edit it and share again.". |

The proposer's client reconciles on its next visit (`reconcile()` in
[`src/common/private-links.ts`](../src/common/private-links.ts)): an accepted proposal removes the
private original (promotion), a rejected one marks it, and anything already applied is forgotten. A
proposal whose private link no longer exists is withdrawn, so no reviewer is asked about a link that
is gone.

> **Backup**: organization backups read the **project** collections only, so private links and
> proposals are never included. Restoring a project replaces that collection and leaves every user's
> private store untouched.

`{pageId}`/`{linkId}` are **opaque** internal GUIDs used only as storage keys; they never appear in
a URL. The URL uses `slug` exclusively.

### `PageMetadata` / `PageIndex`

```jsonc
{
  "id": "index", "kind": "index", "schemaVersion": 1, "revision": 42,
  "pages": [
    {
      "pageId": "b1a2...",       // opaque, storage-only
      "name": "Coverage Report",
      "slug": "coverage-report", // URL segment, unique within the project
      "order": 10,
      "enabled": true,           // disabled pages show a notice when opened
      "hidden": false,           // hidden pages are omitted from the list (still addressable)
      "comment": "Nightly coverage",
      "sizeBytes": 348160,       // decoded size
      "contentVersion": 7,       // increments on each publish
      "updatedUtc": "2026-10-06T11:30:00Z",
      "updatedBy": "Build: 20261006.3"
    }
  ],
  "trash": [ { "trashId": "...", "deletedUtc": "...", "deletedBy": "...", "page": { } } ]
}
```

### `LinkIndex` / `LinkEntry`

```jsonc
{
  "id": "links", "kind": "links", "schemaVersion": 1, "revision": 5,
  "links": [
    {
      "linkId": "...", "slug": "status-page-log", "title": "status-page - job log",
      "url": "https://dev.azure.com/.../_build/results?buildId={{dyn}}&view=logs&s={{stage}}&j={{job}}",
      "comment": "", "order": 0, "enabled": true, "hidden": false,
      "updatedUtc": "", "updatedBy": "",
      "dynamic": { "kind": "build", "buildMode": "latest", "definitionId": 12, "logTarget": { "stage": "Build", "job": "Build" } },
      "area": "fixed", "source": "pipeline"
    }
  ],
  "trash": [ { "trashId": "...", "deletedUtc": "...", "deletedBy": "...", "link": { } } ]
}
```

`area`/`source` are optional: `area: "fixed"` marks a stored (possibly out-of-project) URL, and
`source: "pipeline"` marks a link published by `PublishLink@0`.

### `ContentMeta` / `ContentChunk`

```jsonc
{ "id": "content-meta-b1a2", "kind": "content-meta", "schemaVersion": 1, "pageId": "b1a2",
  "encoding": "gzip+base64", "bytes": 1048576, "chunks": 2, "sha256": "...", "updatedUtc": "..." }

{ "id": "content-b1a2-0", "kind": "content", "schemaVersion": 1, "pageId": "b1a2", "index": 0, "data": "H4sIAAAA..." }
```

## Content size handling

The service rejects a document larger than **5,244,928 bytes** with HTTP 500
`MaximumDocumentSizeException`. Because the stored value is JSON, base64 (~4/3) and JSON overhead
count against the limit.

Publishing (NFR-SCALE-1, NFR-REL-1):

1. Read the content file; gzip it.
2. Split the **compressed** bytes into chunks sized below the ceiling (default `chunkSizeKb` 3072).
3. Write all `content-{id}-{n}` chunks, then `content-meta-{id}`.
4. Update `index` (revision + page entry) **last**, so a reader never sees metadata pointing at
   missing chunks.
5. On update, delete obsolete trailing chunks after the new metadata is written.

Delete = remove the index entry (into the trash), then purge the content docs when the trash entry
is purged. Clear = delete the content docs, set `sizeBytes: 0`, bump `contentVersion`, keep the
page.

## Slugs (FR-URL-4)

- Lowercase; `[a-z0-9]` plus `-`; no leading/trailing `-`; repeats collapsed:
  `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
- Unique within the project (case-insensitive), including trashed entries.
- Reserved words are blocked (e.g. `static`).
- Renaming a slug changes the public URL; the admin UI warns that existing bookmarks break.

## Size display (FR-ADM-8)

- Store the decoded byte count (`sizeBytes`).
- Display **1024-based (IEC)** units: `B`, `KiB`, `MiB`, `GiB`, with one decimal above 1 KiB
  (e.g. `512 B`, `12.3 KiB`, `4.5 MiB`). `B` is used for byte counts.

## Document identity

- A `PUT` whose JSON body **includes `"id": "{id}"`** stores the document under that id.
- If the body has no `id`, the service assigns a GUID and the path segment cannot be used to
  `GET`/`DELETE` it.
- `GET`/`DELETE .../Documents/{id}` work by the stored id.
- `LIST` returns all documents; an empty collection returns 404, so treat 404 as "no documents".

Every document body therefore includes an explicit `id` (and a `kind`).

## Trash (soft delete)

Deleting a page/link moves its entry into the owning index's `trash` array (metadata retained) so it
can be **restored**; content documents are kept until the entry is purged.

- **Restore** moves the entry back into the live list.
- **Delete instantly** purges content documents and removes the entry.
- **Auto-purge**: entries whose `deletedUtc` is older than 5 days are permanently removed on the
  next load of the Pages hub, the Links hub, or the project settings (lazy enforcement - there is
  no background job).
- **Slug reservation**: uniqueness checks include trashed entries, so a slug cannot be reused until
  the entry is purged. The Trash table shows the **Permanent delete by** time (`deletedUtc` + 5
  days).

## Export bundle

Backup/restore (organization settings -> Static -> Backup) wraps the whole organization in one ZIP
holding `static-backup.json`:

```jsonc
{ "format": "static-export", "schemaVersion": 2, "exportedUtc": "...",
  "source": { "publisher": "...", "extension": "...", "organization": "..." },
  "projects": [ { "projectId": "...", "projectName": "...",
                  "documents": [ /* every stored document, without __etag */ ] } ] }
```

Rationale: a thin wrapper over the raw documents preserves every shape (index, links, content chunks,
repos) without the importer having to understand each one, and lets the whole organization be copied
between the editions (whose data scopes are separate). A restore replaces each backed-up project's
data (documents the bundle does not contain are removed). The ZIP is written with stored (not
deflated) entries by `src/common/zip.ts`; the reader also accepts deflated entries so a re-zipped
backup still imports. Exported documents never carry the installation-specific `__etag`.

## Concurrency (NFR-REL-2)

The Extension Data Service does not support conditional writes (`If-Match`/`__etag` are not
honored), but an update whose body omits the current `__etag` is rejected with
"document version does not match". Writes therefore do a read-modify-write that carries the current
`__etag`, with a short retry on a race:

- Admin edits use a bounded read-modify-write with a `revision` field; last writer wins.
- Publishes write `content-meta` then the index; a stale publish must not resurrect deleted chunks.
- Avoid concurrent writers to the same page (one publish task at a time).
