# Static - Azure DevOps extension

Static adds an always-on **Static** group to the Azure DevOps project navigation: a curated,
bookmarkable directory of the links, pages, pipelines and pull requests your team uses. Publish
content and links straight from your pipeline, and give otherwise hard-to-reach places a stable,
human-readable address.

- **Links** - a curated list of bookmarkable links into the project, including *dynamic* links that
  re-resolve to the latest build, the newest open pull request, or the tip of a branch.
- **Pages** - self-contained HTML pages published by pipelines, opened in a sandboxed viewer.
- **Pipelines** - the project's pipelines with run counts and the last result.
- **PR** - pull requests, with a "Global PR #" jump that resolves any pull-request number in the
  organization.
- **Repos** - the project's repositories with brief all-time statistics.

It also adds project settings (Links, Pages, Pipelines, Repos, Trash, About) and organization
settings (Overview, Backup, About) for managing the extension across projects.

## What you can publish from a pipeline

- **A page** - `PublishPage@0` turns a self-contained HTML file into a permanent page with a stable
  slug. Large files are gzipped and chunked automatically.
- **A report tab** - set `tabName` on `PublishPage@0` and the same HTML is attached to the build
  results as a **Static page** tab.
- **A link** - `PublishLink@0` creates or updates a named ("fixed") link. The URL can be given
  inline (`url`) or read from the first line of a file (`urlFile`).
- **A backup / restore** - `StaticAdmin@0` reads every project's Static data into one ZIP (optionally
  attached as a pipeline artifact) and writes it back, which is how a project's data is moved between
  the stable and dev editions.

`page` and `tabName` are independent enablers: set either or both. With neither, the task fails with
a clear hint.

## Why dynamic links matter

Pipelines produce great information that usually ends up in short-lived artifacts or un-bookmarkable
run ids. Static lets you bookmark a specific build's stage/job/task log, the latest succeeded build,
the newest open PR, or the tip of a branch. Targets that depend on a build are stored **by name**, so
they keep working when ids change, and a missing target shows a clear message rather than a broken
page.

## Repository layout

```
ado-manifests/     Extension manifests (base + stable/dev overrides)
ci/                Pipeline helper scripts used by the workflows
scripts/           Build, serve, test, version, and tfx packaging helpers
src/
  common/          Shared helpers (data service, urls, parser, ...)
  hub/             Static hub: Pages list + viewer
  links/           Static hub: Links list
  pipelines/       Static hub: Pipelines list
  pr/              Static hub: Pull requests list
  repos/           Static hub: Repos list
  admin/           Project settings (tabbed)
  orgadmin/        Organization settings
  reporttab/       Build-results "Static page" report tab
docs/              Design documentation (start at docs/README.md)
images/            Packaged PNGs + their SVG sources (SVGs are not shipped)
tasks/             The PublishPage and PublishLink pipeline tasks
.github/workflows/ CI and publish workflows
```

## Prerequisites

- **Node.js** (LTS) and npm.
- **tfx-cli** (Visual Studio Marketplace CLI) for packaging/publishing:

  ```sh
  npm install -g tfx-cli
  ```

## Build, test, run

```sh
npm ci                 # install dependencies
npm run build:dev      # development build (source maps, verbose logging) -> dist/
npm run build:prod     # production build (minified)                        -> dist/
npm test               # unit tests (Node's test runner, bundled by esbuild)
npx tsc --noEmit       # type check
npm run lint           # eslint (fails on any warning: --max-warnings 0)
npm run serve          # serve the repo at http://127.0.0.1:8977/ for shell checks
```

> **Local gate first:** before pushing, run `npx tsc --noEmit && npm run lint && npm test &&
> npm run verify:clean && npm run build:prod` and fix everything it reports - every warning becomes an
> annotation on the pipeline run, where it hides real errors.

> If your npm blocks install scripts, esbuild's postinstall may be skipped. If a build cannot find
> the esbuild binary, run `node node_modules/esbuild/install.js`.

## Package the extension

```sh
npm run package:dev     # VSIX for the development edition (manifest override: dev)
npm run package:stable  # VSIX for the stable edition (manifest override: stable)
```

The packaging helper merges `ado-manifests/azure-devops-extension-base.json` with the chosen
override (`azure-devops-extension-dev.json` or `-stable.json`) and calls `tfx extension create`. The
result is named like `<publisher>.<extension-id>-<version>.vsix`.

## Editions and publishing

There are two Marketplace editions of the same code, under one publisher:

| Edition | Extension id | Visibility | Published from |
| --- | --- | --- | --- |
| Stable | `static` | public | `main` |
| Dev | `static-dev` | private, shared with testers | `develop` |

- Merging to **`develop`** publishes the **dev** edition (private). Sharing it with a tester
  organization is a separate, explicit step: run the **Share dev** workflow and give the
  organization as an input (nothing is stored in the repository). The Marketplace retains the
  sharing list across version publishes.
- Merging to **`main`** publishes the **stable** edition - and the **same build as the dev edition**
  at the same version, so a tester is running exactly the released code on release day.

Versions are derived from git tags, and both editions share one sequence; every published version is
tagged (annotated `vX.Y.Z`):

- Major stays `0`.
- **Stable** (`main`): the **minor** bumps and the revision resets to 0 - `0.2.0`.
- **Dev** (`develop`): the **revision** bumps inside the release line - `0.2.1`, `0.2.2`, ... so a dev
  version reads as "the current release plus N merges".
- The first stable is `0.1.0`, the first dev is `0.0.1`.

Publishing authenticates with a Marketplace token (`MARKETPLACE_PAT`). Azure DevOps global PATs are
retired on 2026-12-01, so publishing is slated to move to Microsoft Entra ID (GitHub OIDC) before
then.

## CI

- `.github/workflows/ci.yml` - on pull requests and pushes: install, lint, type check, test, and
  package the VSIX as a build artifact (no publish).
- `.github/workflows/publish-dev.yml` - on push to `develop`: publish the dev edition.
- `.github/workflows/publish-stable.yml` - on push to `main`: publish the stable edition, and the dev
  edition at the same version.
- `.github/workflows/share-dev.yml` - manual (`workflow_dispatch`): (un)share the dev edition with
  an organization given as an input, and report who currently has access.

Publishing is skipped when a push touches only documentation, the release scripts, tests, CI
configuration or repository housekeeping, so such changes never mint a version. Each publish writes a
summary on its run page and records the published version on the commit (GitHub cannot rename a run
after it starts, so the run list shows the `run-name`).

## Contributing

- Everything here is intended to be publishable. Do not commit instance-identifying data
  (organization/project/repository/user names, machine paths, tokens, private URLs), and keep the
  code and docs ASCII-only. See [`AGENTS.md`](AGENTS.md).
- Keep design changes reflected in [`docs/`](docs/README.md).

## License

MIT - see [`LICENSE`](LICENSE).
