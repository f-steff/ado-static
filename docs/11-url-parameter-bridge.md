# 11  -  URL Parameter Bridge (two-way)

Page variables live in the **host query string** after `?`, and sync both ways with the page
content rendered in the sandboxed iframe.

Example host URL:

```
https://dev.azure.com/{org}/{project}/_apps/hub/{publisher}.{extension}.static?page=my-report&g=week&m=cost
```

- `page` is the reserved key that selects the page slug.
- Every other key (`g`, `m`, ...) is owned by the page content and passed through untouched.

## Sandbox capabilities (what the content can actually do)

The content runs in an inner iframe with `sandbox="allow-scripts allow-popups
allow-popups-to-escape-sandbox allow-downloads"` (no `allow-same-origin`), so its origin is
**opaque** (`location.origin === "null"`). Verified in the debug browser:

| Capability | In the sandbox | Consequence |
| --- | --- | --- |
| `location.search` | always `""`, opening a `?` URL is not possible | the host query cannot be read directly |
| `location.hash` / `history.replaceState` | **works** (fragment only) | page state kept in the hash is readable/writable |
| `document.cookie` | throws `SecurityError` | cookie-based persistence is unavailable |
| `localStorage` | throws `SecurityError` (but can be overridden) | persistence must be bridged |
| `window.open` | blocked unless `allow-popups` | popouts need the sandbox flags + a URL fix |
| `allow-downloads` | enabled | pages can export files (e.g. CSV) |

## The bridge

The extension injects a small bridge as the **first** script in the served HTML (the content is
written into `srcdoc`, so injection is fully under our control). It:

1. **Seeds the content hash** from the initial host params, synchronously, before the page's own
   scripts run  -  so pages that read `location.hash` on load see the right state.
2. **Mirrors host params into the hash**: on a parent `params` message it rewrites
   `location.hash` (via `history.replaceState`), so hash-driven pages react.
3. **Reports content hash changes upstream**: it listens for `hashchange` and patches
   `history.replaceState`/`pushState` (which do not raise `hashchange`) to post the parsed hash
   back to the parent, which writes it into the host query.
4. **Shims `localStorage`** (see below).
5. **Redirects `window.open(location.href)`** to the real hub URL (see below).
6. Announces `ready` so the parent sends the current params.

The reserved `page` key is never forwarded to the content.

## Message protocol

Namespace: `pages-hub`. All messages use `postMessage(payload, "*")`.

Parent -> content:

```jsonc
{ "ns": "pages-hub", "type": "params", "params": { "g": "week", "m": "cost" } }
```

Content -> parent:

```jsonc
{ "ns": "pages-hub", "type": "ready" }
{ "ns": "pages-hub", "type": "params", "params": { "g": "auto", "m": "tokens" } }
{ "ns": "pages-hub", "type": "store",  "key": "view", "value": "..." }   // localStorage.setItem
{ "ns": "pages-hub", "type": "clear" }                                    // localStorage.clear
```

Validation: the parent accepts messages only from the exact `contentWindow` it created
(`event.source`), because the inner origin is opaque and cannot be compared.

## Persistence for pages ("save view")

Because the content's own `localStorage`/cookies are unavailable, the bridge replaces
`window.localStorage` with an in-memory store seeded from values the **extension frame** holds.
The extension frame runs on the gallery CDN origin (`{publisher}.gallerycdn.vsassets.io`), which
is the **same origin across extension versions**, so saved values survive content upgrades.

- Slot key: `static-store:{org}/{projectId}/{slug}` (one JSON object per page).
- Reads are synchronous (from the injected snapshot); writes are forwarded to the parent and
  persisted by `src/common/page-store.ts`.
- `document.cookie` stays unavailable; pages that also use `localStorage` work because the cookie
  read throws and is caught, then the localStorage shim supplies the value.

## Popouts / fullscreen

A sandboxed frame cannot open a window without `allow-popups`, and `location.href` inside it is
`about:srcdoc`. The bridge patches `window.open` so that calls with an empty/about URL (the
common `window.open(location.href, "_blank")` pattern) open the **real hub URL**, carrying the
current page state, in a new browser tab (`allow-popups-to-escape-sandbox` keeps that tab
unsandboxed).

## Loop prevention

- The parent skips a `postToFrame` when the serialized params are unchanged.
- The bridge skips rewriting the hash when the encoded value already matches.
- The parent clears page-owned keys the content has dropped (e.g. a reset).

## Top-URL read/write

```ts
const params = await nav.getQueryParams();        // { page: "...", g: "...", ... }
nav.setQueryParams({ page: slug, g: "week" });    // an empty value removes a key
```

`setQueryParams` updates the host query string without a route change. Page links use it plus a
reload so the URL is the single source of truth (see [05](05-navigation-and-urls.md)).

## Security summary

- Content stays sandboxed with a unique opaque origin; it never gains access to the host.
- The bridge is the only channel and is identity-checked (`event.source`).
- Page-owned values are round-tripped as strings; the reserved `page` key is protected.
- No `eval`; no forwarding of arbitrary calls into host services.
- Popups/downloads are permitted by the sandbox flags; content is still pipeline-audited.

## Verification

Covered by TC-16, TC-20 (bridge) and TC-33/TC-35 in [13](13-test-plan.md): page links, host
query <-> hash sync, `localStorage` persistence across a reload, and the popout opening a new
tab.
