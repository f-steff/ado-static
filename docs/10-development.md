# 10  -  Development and Tooling

## Toolchain

- **Language**: TypeScript, bundled with **esbuild** (`iife`, `target: es2019`).
- **UI**: vanilla TypeScript + DOM (no React / webpack / azure-devops-ui), plain CSS.
- **Lint**: ESLint (flat config) over `src/**/*.ts`.
- **Packaging**: `tfx-cli` driven through `scripts/tfx.js`.
- **Manifests**: a shared base plus `dev` / `stable` overrides.

## Repository layout

```
ado-static/
  ado-manifests/     # base + dev + stable manifest overrides
  ci/                # helper scripts used by the workflows (version, identifiers)
  scripts/           # build.js, serve.js, test.js, tfx.js
  src/
    common/          # shared helpers (data-service, urls, ado-url, link-builder, ...)
    hub/             # Pages hub (landing + sandboxed viewer)
    links/           # Links hub
    pipelines/       # Pipelines hub
    pr/              # PR hub
    repos/           # Repos hub
    admin/           # Project settings (tabbed)
    orgadmin/        # Organization settings
    reporttab/       # Build-results "Static page" report tab
  tasks/
    PublishPage/     # task.json + index.js (plain Node)
    PublishLink/     # task.json + index.js (plain Node)
  images/            # packaged PNGs + SVG sources
  docs/
  tests/logic.test.ts
  .github/workflows/ # ci.yml, publish-dev.yml, publish-stable.yml, share-dev.yml
  package.json
  tsconfig.json
  eslint.config.js
  LICENSE
  README.md
```

## npm scripts

```jsonc
{
  "scripts": {
    "clean": "rimraf ./dist",
    "build:dev": "npm run clean && node scripts/build.js --mode=development",
    "build:prod": "npm run clean && node scripts/build.js --mode=production",
    "serve": "node scripts/serve.js",
    "test": "node scripts/test.js",
    "package:dev": "node scripts/tfx.js create dev",
    "publish:dev": "node scripts/tfx.js publish dev",
    "package:stable": "node scripts/tfx.js create stable",
    "publish:stable": "node scripts/tfx.js publish stable",
    "share:dev": "node scripts/tfx.js share dev",
    "unshare:dev": "node scripts/tfx.js unshare dev",
    "verify:clean": "node ci/scan-identifiers.js",
    "lint": "eslint \"src/**/*.ts\""
  }
}
```

## Logging convention

- `common/log.ts` exposes `logDebug` / `logInfo` / `logWarn` / `logError`.
- `__DEV__` is injected by esbuild (`--mode=development` -> verbose; production -> warnings/errors
  only).
- Every line is prefixed `[pages-ext]` for easy DevTools filtering.

## REST and SDK conventions

- Use explicit service-id strings (e.g. `"ms.vss-features.host-navigation-service"`) rather than
  importing `CommonServiceIds`, to avoid esbuild import warnings.
- Authenticate with `await SDK.getAccessToken()` and `Authorization: Bearer <token>`.
- Call `SDK.notifyLoadSucceeded()` / `SDK.notifyLoadFailed(message)` in every frame so the host
  shows the correct loading state. Paint the heading before loading data (NFR-PERF-1).

## Build and debug loop

1. `npm ci` (once), then `node node_modules/esbuild/install.js` if the postinstall was blocked.
2. `npm test` and `npx tsc --noEmit` (the gate), `npm run lint`.
3. `npm run build:dev` -> `dist/`.
4. `npm run package:dev` -> a `.vsix` in the repo root, or publish (below) for the real edition.

## CI

Workflows live in `.github/workflows/` (GitHub's requirement):

- `ci.yml` - on pull requests and pushes: install, lint, type check, test, `verify:clean`, build,
  and upload the VSIX as a build artifact (no publish).
- `publish-dev.yml` - on push to `develop`: publish the private dev edition (sharing is separate).
- `publish-stable.yml` - on push to `main`: publish the stable edition.
- `share-dev.yml` - manual (`workflow_dispatch`): (un)share the dev edition with an organization.

A publish is skipped when **every** changed path in the push is documentation, tests, CI
configuration or repository housekeeping (`paths-ignore`) - such a push cannot change the shipped
extension, so it must not mint a version. `overview.md` and `LICENSE` are packaged into the VSIX and
are deliberately **not** ignored, and a mixed push still publishes.

## Versioning

Versions are derived from git tags (see [README](../README.md)):

- Major stays `0`; **minor** bumps and the revision resets to 0 on each merge to `main`;
  **revision** bumps on each merge to `develop`.
- The first stable is `0.1.0`; the first dev is `0.0.1`.
- Each published version is tagged `vX.Y.Z` (annotated). The workflow computes the version, publishes,
  then tags.

## Testing strategy

- Pure logic (slug validation, URL parsing/building, chunking, size formatting, index diffing) is
  unit-tested without the host in `tests/logic.test.ts` (`npm test`).
- `scripts/serve.js` renders the shell for quick UI checks without the host.
- End-to-end verification installs the VSIX in a real organization; the test plan and results live
  in [13-test-plan.md](13-test-plan.md).

## Build notes

| Note | Detail |
| --- | --- |
| Manifest file paths are relative to the manifest directory | The base manifest lives in `ado-manifests/`, so packaged folders are referenced as `../dist` (not `dist`); otherwise `tfx` fails with `ENOENT ... ado-manifests\dist`. |
| Base + `--overrides-file` | `scripts/tfx.js` merges the base with the chosen override; the VSIX is named `<publisher>.<id>-<version>.vsix`. |
| `entryNames: "[name]/[name]"` mirrors the source tree | `src/hub/hub.ts` -> `dist/hub/hub.js`, so `index.html` references `./hub.js`. |
| npm may skip install scripts | `esbuild`'s postinstall can be blocked; run `node node_modules/esbuild/install.js` if the build can't find the binary. |
| Marketplace validation can outlast tfx's wait window | `scripts/tfx.js` treats tfx's "Validation is taking much longer than usual" as success: the upload already happened, and failing there would skip the version tag, so the next publish would be rejected with "version number must increase". |
| Hub group + hub = top-level entry | A `ms.vss-web.hub-group` targeting `ms.vss-web.project-hub-groups-collection` plus hubs targeting it (`.static-hub-group`) is the mechanism for the **Static** group. |
| Hub icons | Ship PNGs and reference them by relative path; inlining is used only for HTML heading icons. |
| Pipeline tasks are packaged separately | A `ms.vss-distributed-task.task` contribution points at a task folder packaged with `addressable: false`; it is not bundled by esbuild. |
| Report tab | A `ms.vss-build-web.build-results-tab` contribution with `supportsTasks` limited to the PublishPage task id. |
