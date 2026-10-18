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
    common/          # shared helpers (data-service, urls, ado-url, link-builder, ...) and the
                     # stylesheets entry points link (link-editor.css, dialog.css)
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

## Branching and releases

> **Sync `develop` before cutting a branch.** The merges happen on the remote (a pull request), so a
> local `develop` goes stale silently: `git checkout develop && git fetch --prune origin &&
> git pull --ff-only` first, then `git checkout -b <branch>`. A branch cut from a stale `develop`
> re-applies already-merged commits, so its pull request is **conflicting** - and GitHub runs **no
> workflows at all** for a conflicting pull request, which looks like a pull request whose checks never
> arrive (three attempts were spent on this before the cause was found). When checks do not appear,
> check the pull request's `mergeable` state first.

- Only **`main`** and **`develop`** are long-lived; a branch exists for its pull request. GitHub
  deletes the head branch when the pull request merges (`delete_branch_on_merge` is on), so no merged
  branch accumulates.
- Both are protected by the ruleset *Protect main and develop*: a pull request is required (no direct
  pushes, no force-push, no deletion) **and the `build` check must pass on an up-to-date branch**.
- **`main` may only be reached from `develop`.** The `release-guard` workflow runs on every pull
  request and fails a `main`-targeted one whose source is not `develop`, so the flow is always
  `feature/*` -> `develop` -> `main`.
- `develop` is the integration branch. PRs land there with a **rebase** merge (flat history), and every
  push that can change the shipped extension publishes the dev edition.
- `main` is the **released line**. A release **merges** `develop` into `main` (a merge commit), so
  `main` contains every commit `develop` has, and the release tag sits on that merge commit.
- The release merge commit carries the **default one-line subject** (`Merge pull request #N from
  f-steff/develop`) with **no body**, so the commit overview on `main` shows only the merge line. Use
  `gh pr merge --merge --subject "Merge pull request #N from f-steff/develop" --body ""`; without it,
  GitHub appends the pull request's title (and body) to the commit message.
- The ruleset *Protect main and develop* requires a pull request, the status checks, no deletion and no
  force-push - but **not** linear history. That last rule was removed deliberately: it forced GitHub's
  rebase-merge, which rewrites the committer, so **every SHA changes** and `main` became a *parallel
  copy* of `develop`'s history that shares only the first commit. Every later release then minted
  another set of copies, and a release tag could never appear on `develop`.
- Kept for context, the tags published before that fix live on different lines: `v0.1.0` on `main`, the
  dev tags (`v0.0.x`, `v0.1.1` and later) on `develop`. A tag is only visible in a Git UI when the
  branch containing its commit is selected - so `v0.1.0` shows under `main`, not under `develop`.
  Releases from the fix onwards tag `main`'s merge commit, and `main` genuinely contains `develop`.
- A workflow runs the file **at the ref it was dispatched on**, and the `workflow_dispatch` UI defaults
  to the default branch. `main` carries the workflow files **of the last release**, so a manual dispatch
  from `main` runs those definitions, without any fix that landed on `develop` since. Pick `develop`
  (or `--ref develop`) when you need current behaviour, or release - the guard (D26) deliberately allows
  **no** other route to `main`, so a workflow there cannot be patched without one. Two consequences:
  a workflow may depend only on files the released branch really contains (`share-dev.yml` reads its
  input through `ci/dispatch-input.mjs` and its report through `ci/shared-with.mjs`, and both travel in
  the same pull request as the workflow - the missing pair is B6 in
  [`13-test-plan.md`](13-test-plan.md)), and a report step must never be able to fail the run that
  performed the action.

## CI

Workflows live in `.github/workflows/` (GitHub's requirement):

- `ci.yml` - on pull requests and pushes: install, lint, type check, test, `verify:clean`, build,
  and upload the VSIX as a build artifact (no publish).
- `publish-dev.yml` - on push to `develop`, or manually with an optional `version`: publish the
  private dev edition at the next revision of the released minor. The tag is pushed as soon as the
  **upload** is accepted (`--no-wait-validation`), and the asynchronous Marketplace validation is
  reported into the run summary rather than gating the tag (D29).
- `publish-stable.yml` - on push to `main`: publish the stable edition **and** the dev edition at the
  same version.
- `share-dev.yml` - manual (`workflow_dispatch`): (un)share the dev edition with an organization and
  report the resulting access list.

### Local gate first, then the pipeline

Run the whole gate locally and fix every warning **before** pushing - `npx tsc --noEmit`,
`npm run lint` (which fails on any warning: `--max-warnings 0`), `npm test`, `npm run verify:clean`,
`npm run build:prod` - then watch the run and fix anything it reports. GitHub annotates every warning
on the run, so a single unused binding hides the real errors.

The workflows pin what GitHub deprecates or migrates: the runner image is `ubuntu-24.04` (rather than
`ubuntu-latest`, which migrates to Ubuntu 26 in October 2026) and the actions are on majors that run on
the current Node (the Node-20 majors raise a deprecation annotation on every run).

### Seeing what a run did

GitHub evaluates `run-name` when a run is created and offers **no API to rename a run**, so a version
computed inside the job cannot appear in the Actions list. The workflows compensate:

- `run-name` gives the list a meaningful title (`Publish dev 0.1.2` for a manual run,
  `Publish stable (release)` otherwise).
- Each publish writes a **job summary** (shown on the run page) naming the edition, version, tag and
  listing URL.
- Each publish records a **commit status** (`Marketplace: static` / `Marketplace: static-dev`) whose
  description is `Published Static 0.1.0`, so the commit itself records what was released.
- `share-dev.yml` reads the access list **back from the Marketplace** (`tfx extension show`) but
  reports only **how many** organizations have access. The list itself is confidential: this repository
  (and therefore every run name, step name, log line and run summary) is public, so the organization
  comes from a dispatch input and never enters an `env:` block or the script text - the runner prints
  those *before* a step runs. `ci/dispatch-input.mjs` reads it from the event payload file (only a path
  is visible) and hands it to the two places that need it: `::add-mask::` before anything else runs, and
  `eval` inside the share step - so tfx's own `Sharing extension with ...` output and the `Shared with`
  list print `***`. The names are visible to the publisher on the Marketplace publisher page, which is
  the only record of them. The reporting step is **non-fatal** (`continue-on-error`) and needs only
  `.github/**` and `ci/shared-with.mjs`, so a branch that is missing either still completes its share or
  unshare and simply reports less.

A publish is skipped when **every** changed path in the push is documentation, the CI/release
scripts (`ci/**`), tests, or repository housekeeping (`paths-ignore`) - such a push cannot change the
shipped extension, so it must not mint a version. `marketplace-advertisement.md` and `LICENSE` are packaged into the
VSIX and are deliberately **not** ignored; neither is `scripts/**`, because that tooling decides what
ends up in the package. A mixed push still publishes. The local `t/` scratch folder (archived
migration material, downloaded backups) is gitignored outright - it must never be committed.

## Versioning

Versions are derived from git tags; the rules live in
[`ci/version.mjs`](../ci/version.mjs) and are unit-tested in
[`tests/version.test.mjs`](../tests/version.test.mjs):

- Major stays `0`; both editions share **one** tag sequence.
- **Stable** (`main`): the minor bumps, revision resets to 0 (`0.2.0`), and the release publishes
  **both** editions at that version.
- **Dev** (`develop`): the revision bumps inside the released minor (`0.2.1`, `0.2.2`, ...), so a dev
  version reads as "the current release plus N merges".
- The first stable is `0.1.0`; the first dev is `0.0.1`.
- Each published version is tagged `vX.Y.Z` (annotated) **once**: a release tags before publishing the
  dev edition, and the dev workflow skips a tag a release already created. The two publish workflows
  share one concurrency group, so a queued run recomputes its version from the tags when it starts.
- A **manual** run of *Publish dev* can pass a `version` input - for a re-publish, or to align the dev
  edition with a release that predates the dual publish.

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
