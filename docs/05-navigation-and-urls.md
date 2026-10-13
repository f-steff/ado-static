# 05  -  Navigation and URLs

## Azure DevOps navigation model

- The project sidebar is a set of **hub groups** (Overview, Repos, Pipelines, ...). Each group
  contains **hubs** (Summary, Dashboards, Wiki, ...).
- Hubs and hub groups are **static contributions declared in the extension manifest**; they cannot
  be created at runtime.
- A new **top-level** group requires a `ms.vss-web.hub-group` contribution targeting
  `ms.vss-web.project-hub-groups-collection`; hubs reference it with a relative target
  (`.static-hub-group`). See [09](09-references.md).

Static declares one group (**Static**) with five hubs:

| Hub | Contribution id | Purpose |
| --- | --- | --- |
| Links | `static-links-hub` | Curated, bookmarkable links. |
| Pages | `static` | The page list and the sandboxed viewer. |
| Pipelines | `static-pipelines-hub` | Pipeline summaries. |
| PR | `static-pr-hub` | Pull requests + Global PR # jump. |
| Repos | `static-repos-hub` | Repository summaries. |

Plus **project settings** (`static-admin-hub`, targeting `ms.vss-web.project-admin-hub-group`) and
**organization settings** (`static-org-admin-hub`, targeting
`ms.vss-web.collection-admin-hub-group`).

## Dynamic children are not possible (NOTE)

Azure DevOps does not support runtime/dynamic hub contributions: the sidebar children are fixed at
packaging time, and the extension runs in an iframe and cannot inject into the host navigation DOM.
Admin-created pages/links therefore live **inside** the hubs: the hub renders the list, and each
item is addressed by `?page={slug}`. This is the agreed interpretation of the navigation
requirements.

## Sidebar visibility

The **Static** group is a permanent part of the extension; there is no per-project hiding:

- A `Feature` constraint on the group *can* hide it, but the feature state must be set, and the
  Feature Management REST API is CORS-blocked from extension origins, so the extension cannot read
  or set it.
- ADO exposes no UI for a project-scoped contributed feature.
- Extension contributions are declared statically; there is no runtime per-project condition.

Consequence: the items are always visible.

## URL scheme

A custom hub is served at a **platform-generated** URL:

```
https://dev.azure.com/{org}/{project}/_apps/hub/{publisher}.{extension}.{hubId}
```

The path is fixed by the platform (the manifest cannot request a clean `/pages`), so the shortest
achievable form is `_apps/hub/{publisher}.{extension}.{hubId}`. With short ids this reads e.g.
`.../_apps/hub/f-steff.static.static` (Pages) or `.../_apps/hub/f-steff.static.static-links-hub`
(Links). An undocumented `route` property has no effect.

Settings pages use the standard `_settings/` path:

```
https://dev.azure.com/{org}/{project}/_settings/{publisher}.{extension}.static-admin-hub#pages
https://dev.azure.com/{org}/_settings/{publisher}.{extension}.static-org-admin-hub#about
```

Tab switching on the settings pages uses a same-document hash navigation (`#links`, `#pages`,
`#pipelines`, `#repos`, `#trash`, `#about`), so switching is instant and the browser Back returns
to the previous tab.

### Item state lives in the query string

The host navigation service exposes first-class query-string access - this is how an item is
addressed and how the two-way parameter sync works:

```ts
const nav = await SDK.getHostNavigation();
const params = await nav.getQueryParams();        // read the host query string
nav.setQueryParams({ page: "coverage-report" });  // write (an empty value removes a key)
// also available: setHash / navigate(url)
```

Working URL shape:

```
https://dev.azure.com/{org}/{project}/_apps/hub/{publisher}.{extension}.static?page={slug}
```

Page-owned variables follow after `?` - see [11-url-parameter-bridge.md](11-url-parameter-bridge.md).

Observed behaviour:

- Opening `...?page=test&a=qwerty` -> `getQueryParams()` returns both; the hub forwards them to the
  sandboxed content.
- Calling `setQueryParams({ view: "details" })` updates the real address bar **without reloading**
  the hub (a soft update).
- Editing the address bar / refreshing is a **full navigation**: the hub reloads, re-reads the query
  string, and forwards it to the content.
- Removing a key requires an **empty value** (`setQueryParams({ a: "" })`); an empty object is a
  no-op.

### Link targets vs the hub URL NOTE

A page/link **slug** is clean and readable. A link's **target** may legitimately include build/log
ids (`buildId`, `s`, `j`, `t`) or placeholders (`{{dyn}}`/`{{stage}}`/...); these live in the stored
link, never in the hub URL. So the hub URL stays clean while a link can point at a precise build
log.

## Reserved and edge-case slugs

- Reject slugs starting with `_` (ADO uses `_`-prefixed routes) and the literal `static`.
- Reject case-insensitive duplicates (including trashed entries).
- Unknown/deleted slug: render a clean "not found" state inside the hub and keep the URL.
- Disabled page: show a "page disabled" notice when opened by a direct link. Hidden page: omit from
  the hub list but render it when opened directly.

## Deep links and refresh (FR-URL-5)

On hub load, read the slug from `getQueryParams()`. If present, load and (for pages) render it, or
(for links) resolve and navigate; otherwise render the list. Because the query string is part of the
real host URL, refresh and bookmarking work without any SPA fallback.

## Explicitly out of scope for the hub URL

- Counters, GUIDs, hashes, or timestamps in the hub URL; the only query keys are `page` (the slug)
  and page-owned variables.
