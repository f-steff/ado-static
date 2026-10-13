# 12  -  Spike Results (retained)

The exploratory spikes are **complete** and their outcomes are folded into the design docs
([04](04-data-model.md), [05](05-navigation-and-urls.md), [06](06-pipeline-integration.md),
[11](11-url-parameter-bridge.md), [08](08-open-questions.md)). The executable probes and the
probe PowerShell script have been **removed**; the durable take-aways are recorded here.

No customer-specific values are stored here; examples use placeholders.

## Spike 1  -  Routing and URL shape (resolved)

| Observation | Result |
| --- | --- |
| Base hub URL | `https://dev.azure.com/{org}/{project}/_apps/hub/{publisher}.{extension}.{hubId}` (platform-generated) |
| Route id | `ms.vss-web.fallback-route-new-platform` |
| `routeValues` | Platform internals: `{ project, parameters, controller: "ContributedPage", action: "Execute", serviceHost }` |
| Child URL | **Query** - `...?page=test&a=qwerty`; `setQueryParams` appends/updates keys |
| Arbitrary key round-trip | Deep link -> `getQueryParams()` OK; content -> host via `setQueryParams` OK |
| Undocumented `route` property | **Ignored** - the URL stayed `_apps/hub/...` |
| Reload behaviour | `setQueryParams` = soft update; manual edit/refresh = full reload |

Consequence: page identity lives in the query string (`?page={slug}`); the path is fixed
([05](05-navigation-and-urls.md)).

## Spike 2  -  Extension Data Service limits and semantics (resolved)

| Observation | Result |
| --- | --- |
| Per-document size ceiling | **5,244,928 bytes** (HTTP 500 `MaximumDocumentSizeException` above) |
| Conditional writes (`If-Match`) | **Ignored**; updates require the current `__etag` in the body (HTTP 400 "document version does not match" otherwise) |
| Document id | The body `id` is authoritative; a repeat PUT updates in place |
| Delete / list | `DELETE` by id -> 204; empty collection `LIST` -> 404 |

Consequence: content is gzipped, base64-encoded and chunked below the ceiling; every write is a
read-modify-write preserving `__etag` ([04](04-data-model.md), [06](06-pipeline-integration.md)).

## Spike 3  -  Publisher authentication (resolved)

| Auth method | Result |
| --- | --- |
| `System.AccessToken` (Bearer) | **Works** (HTTP 200) |
| PAT (Basic) | Fallback only |

Consequence: the `PublishPage` and `PublishLink` tasks use `System.AccessToken`; the pipeline must
enable "Allow scripts to access the OAuth token" ([06](06-pipeline-integration.md)).

## Ongoing tests (not spikes)

The repeatable, still-useful checks live in the pipeline under `sandbox` and the test plan
([13](13-test-plan.md)): the normal publish, the **large-page chunking** probe and the
**error-message** probes. Those are kept; only the one-off exploratory spikes were removed.
