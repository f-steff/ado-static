# 16 - Development setup, packaging and publishing

This is the entry point for working on Static itself: get it running locally, package it, and
understand how the two editions are published.

- How the repository is organised - layout, scripts, branching, CI, versioning, conventions - is in
  [10-development.md](10-development.md).
- Publishing **from** a pipeline (what the tasks do for your users) is in
  [06-pipeline-integration.md](06-pipeline-integration.md).
- The repeatable test plan and the results per version are in [13-test-plan.md](13-test-plan.md).

## Prerequisites

- **Node.js** (LTS) and npm.
- **tfx-cli** (Visual Studio Marketplace CLI) for packaging and publishing:

  ```sh
  npm install -g tfx-cli
  ```

- A **published identity** for releasing (see "Credentials" below) - only the publisher has one.
  Building, testing and packaging need nothing.

## Build, test and run

```sh
npm ci                 # install dependencies
npm run build:dev      # development build (source maps, verbose logging) -> dist/
npm run build:prod     # production build (minified)                        -> dist/
npm test               # unit tests (Node's test runner, bundled by esbuild)
npx tsc --noEmit       # type check
npm run lint           # eslint (fails on any warning: --max-warnings 0)
npm run verify:clean   # refuse instance-identifying data anywhere in the tree
npm run serve          # serve the repo at http://127.0.0.1:8977/ for shell checks
```

> **Local gate first:** before pushing, run `npx tsc --noEmit && npm run lint && npm test &&
> npm run verify:clean && npm run build:prod` and fix everything it reports - every warning becomes an
> annotation on the pipeline run, where it hides real errors.

> If your npm blocks install scripts, esbuild's postinstall may be skipped. If a build cannot find
> the esbuild binary, run `node node_modules/esbuild/install.js`.

The full script list, the logging convention and the build notes are in
[10-development.md](10-development.md#npm-scripts).

## Package the extension

```sh
npm run package:dev     # VSIX for the development edition (manifest override: dev)
npm run package:stable  # VSIX for the stable edition (manifest override: stable)
```

The packaging helper merges `ado-manifests/azure-devops-extension-base.json` with the chosen
override (`azure-devops-extension-dev.json` or `-stable.json`) and calls `tfx extension create`. The
result is named like `<publisher>.<extension-id>-<version>.vsix`.

## Editions

There are two Marketplace editions of the same code, under one publisher:

| Edition | Extension id | Visibility | Published from |
| --- | --- | --- | --- |
| Stable | `static` | public | `main` |
| Dev | `static-dev` | private, shared with testers | `develop` |

Each edition has its **own data scope** (extension data is scoped per extension id), so the two look
like two independent installations - which is why moving between them is a backup and restore rather
than switching a setting.

## Publishing

Publishing a version to the Marketplace is a **publisher** action: the commands and workflows below
authenticate as an identity that is a member of the publisher (see "Credentials"), so a project member
- or anyone outside the publisher - cannot publish one. A contribution reaches the Marketplace the same
way it reaches `develop`: through CI and a pull request, with the publisher doing the release.

Merging is what publishes; there is no manual upload step in the normal flow.

- Merging to **`develop`** publishes the **dev** edition (private). Sharing it with a tester
  organization is a separate, explicit step: run the **Share dev** workflow and give the organization
  as an input (nothing is stored in the repository, and the run reports only how many organizations
  have access - the names live on the Marketplace publisher page). The Marketplace retains the
  sharing list across version publishes.
- Merging to **`main`** publishes the **stable** edition - and the **same build as the dev edition**
  at the same version, so a tester is running exactly the released code on release day.

Versions are derived from git tags and both editions share one sequence: a release bumps the minor
(`0.2.0`) and a dev publish bumps the revision inside the released minor (`0.2.1`, `0.2.2`, ...), so a
dev version reads as "the current release plus N merges". The rules live in
[`ci/version.mjs`](../ci/version.mjs) and are explained in
[10-development.md](10-development.md#versioning).

A publish is **skipped** when every changed path is documentation, CI/release scripts, tests or
repository housekeeping - such a push cannot change the shipped extension, so it must not mint a
version. Each publish writes a summary on its run page and records the published version on the
commit; the workflows themselves are listed in [10-development.md](10-development.md#ci).

### Credentials

Publishing authenticates with a **Microsoft Entra identity through GitHub OIDC** - no stored secret.

- A **federated credential** on the identity trusts this repository's `marketplace` environment:
  subject `repo:f-steff@7275320/ado-static@1415789222:environment:marketplace`, issuer
  `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`.
- The identity is a **Contributor member of the publisher**, which is what allows it to publish; that
  membership is added on the Marketplace publisher page by the publisher account.
- Each publishing workflow runs in the `marketplace` environment, signs in with `azure/login` (the
  client and tenant ids live in the environment's **variables**, not secrets) and asks for an **Azure
  DevOps resource token** (`499b84ac-1321-427f-aa17-267ca6975798`), which `scripts/tfx.js` passes to tfx
  as `--auth-type pat --token ...`.
- There is **no personal access token** any more: `MARKETPLACE_PAT` was deleted, so the Azure DevOps
  global PAT retirement (2026-12-01) does not touch publishing ([D30](08-open-questions.md)).

> **What the publisher's Members page shows.** It lists two entries: the publisher account (role
> *Owner*) and this **publishing identity** (role *Contributor*). A service principal has no friendly
> user name in that list, so it appears as `<Entra tenant id>\<service principal object id>` - first the
> directory that holds the `ado-static-publisher` app registration, then the identity's own object id.
> That string is an **identifier, not a credential**: it cannot be used to publish anything without the
> federated credential, which only this repository's `marketplace` environment can present. There is no
> way to give it a friendlier name on that page.

## The development program

The dev edition is a **private Marketplace listing**, so it is shared per organization. It exists for
one situation: someone reported a problem or asked for a feature, and would like to try the change
before the next release.

- **To join**, ask the developer - an [issue](https://github.com/f-steff/ado-static/issues) or the
  contact details on the Marketplace listing - to add your organization to the program. The publisher
  then shares the dev edition with it (the **Share dev** workflow), after which `static-dev` can be
  installed from the Marketplace and updates with every merge to `develop`.
- **Switching back to the released edition** is something you can do yourself: uninstall the dev
  edition, install the released one, and restore (below). The organization stays on the shared list, so
  the dev edition remains available if you want to test again later. Being taken off that list - so the
  dev edition is no longer offered to your organization at all - is a request to the developer, and is
  only worth making if you would rather not see it in the Marketplace.

Nothing is lost when switching: each edition keeps its own data scope, so the dev edition holds what
was published to it until you remove it, and the released edition shows what you restored into it.

### What a tester should expect

- The dev edition is the code of the **next release**, and it is rebuilt on every merge, so what you
  are testing changes under you while development continues.
- It is a **separate extension with separate data**: nothing the released edition shows is visible in
  the dev edition, and the other way around.
- It is installed **organization-wide**, exactly like the released edition: one installation applies to
  every project, and its data is kept per project. The two editions cannot be installed at the same
  time, so switching between them is possible but takes the steps below - back up, switch, restore.

### Entering the development edition (from the released one)

Ask the developer to add your organization first (see above), then:

1. **Back up**: released edition -> Organization settings -> Static -> **Backup** -> **Download
   backup** (or run `StaticAdmin@0` in backup mode). This writes one ZIP for the whole organization.
2. **Switch edition**: uninstall the released edition and install the dev edition (`static-dev`) for
   the organization - only one edition can be installed at a time.
3. **Restore**: dev edition -> Organization settings -> Static -> **Backup** -> choose the ZIP ->
   `Restore` -> `Confirm restore`. Each project in the archive is replaced by the archive's data.

### Going back to the released edition

Run the same sequence in reverse: back up in the dev edition, uninstall it, install the released
edition, and restore the archive. Projects that no longer exist are skipped and reported. This needs
no request, and your organization stays in the development program unless you ask to be taken off it.

### What to send with a report

The version from the footer of any hub (`Static 0.2.7`), what you did, what happened and what you
expected - or, for publishing, the build id and the task's error output. That is usually enough to
reproduce it from the test plan.

## Where to go next

- [docs/README.md](README.md) - the documentation index.
- [10-development.md](10-development.md) - layout, scripts, branching, CI, versioning, conventions.
- [13-test-plan.md](13-test-plan.md) - the test plan to run against a version, and past results.
- [../AGENTS.md](../AGENTS.md) - the rules that apply to any change (local gate, publishable content,
  ASCII-only, comments and tests).
