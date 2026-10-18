# AGENTS.md

Guidance for agents working in this repository.

This repository is **intended to be published**. The overriding rule is: never include
anything that identifies a real environment.

---

## 1. Publishable content

Never commit:

- organization, project, repository, team, or user names from a private instance;
- machine paths, hostnames, usernames, or login identifiers;
- tokens, PATs, secrets, connection strings, or URLs pointing at a private instance;
- screenshots or logs containing any of the above.

Use neutral placeholders in docs, examples, tests, and scripts:

| Use | Instead of |
| --- | --- |
| `contoso` | a real organization |
| `SampleProject` | a real project |
| `static-dev` | a real extension id |
| `<PAT>` | a real token |

> The Marketplace **publisher id** and other public extension metadata are intentionally
> tracked, because they are public once published.

Before finishing any change, scan for accidental instance identifiers.

---

## 2. Repository conventions

- Documentation lives in [`docs/`](docs/README.md). Start there.
- Keep documentation consistent: use the existing headings, the FR/NFR ID scheme, and the
  status legend in `docs/README.md`.
- Do not re-introduce the deleted brainstorming file `azure-devops-custom-html-hosting.md`.
- The Marketplace listing text is [`marketplace-advertisement.md`](marketplace-advertisement.md), referenced
  by the manifest's `content.details` and packaged into the VSIX. It is advertising copy for the
  Marketplace, not repository documentation: never delete or rename it without updating
  `ado-manifests/azure-devops-extension-base.json` (and the comment in the publish workflows).
- Prefer editing existing documents over creating new top-level files.
- Keep the docs factual: mark unverified claims as SPIKE and record outcomes in
  [`docs/08-open-questions.md`](docs/08-open-questions.md).

---

## 3. Build, packaging, releases and CI

- **Local gate first (mandatory).** Run the whole gate locally and fix **every** warning *before*
  pushing: `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run verify:clean`,
  `npm run build:prod`. `npm run lint` runs with `--max-warnings 0`, so a warning is a failure.
  Then watch the pipeline run and fix anything it reports. No warning may reach `main` or `develop`:
  GitHub annotates every one of them on the run, and they drown the real errors.
- Follow [`README.md`](README.md) for install/build/test/package steps.
- Do not commit build output (`dist/`), `node_modules/`, or generated `.vsix` files.
- **Editions**: one code base, two Marketplace editions under the publisher `f-steff`: `static`
  (stable, from `main`) and `static-dev` (private, from `develop`). Manifests are the shared base plus
  `azure-devops-extension-dev.json` / `azure-devops-extension-stable.json`.
- **Branches**: only `main` and `develop` are long-lived; a branch is deleted when its pull request
  merges (`delete_branch_on_merge`). Both are protected - pull request required, the **`build`** check
  required, no force-push, no deletion - and **`main` may only be reached from `develop`** (the
  `release-guard` check fails any other pull request into `main`), so the flow is always
  `feature/*` -> `develop` -> `main`. PRs into `develop` are rebase-merged; a release **merges**
  `develop` into `main` with a merge commit, so `main` contains every commit `develop` has and the
  release tag lands on that merge commit. Do **not** rebase-merge a release: it rewrites every SHA and
  forks the history (see [`docs/10-development.md`](docs/10-development.md#branching-and-releases)).
  `main` therefore contains every `develop` commit by design; the **release overview** is the
  first-parent chain, `git log --first-parent --merges --oneline main` (one line per pull request), and
  that is the view to use - do not squash releases to flatten the list. This applies to `main` **only**:
  `develop` is rebase-merged and keeps every commit, which is the flat history wanted there.
- **Pipelines**: only `.github/workflows/`. Reusable helper scripts live in `ci/`.
- **Versions**: both editions share one tag sequence - a release publishes *both* at the same version,
  and a `develop` merge publishes the next revision of the released minor. See
  [`docs/10-development.md`](docs/10-development.md#versioning); the bump rules live in
  `ci/version.mjs` and are unit-tested.
- **Runners and actions**: pin the runner image (`ubuntu-24.04`) and use action majors that run on the
  current Node (see the workflows) - `ubuntu-latest` and Node-20 action majors both raise deprecation
  annotations on every run.
- **Identifier scan**: run `npm run verify:clean` before pushing; CI runs it too.

---

## 4. Code comments (mandatory)

Every function and every major code block must carry **at least one line of comment
explaining its rationale** - especially anything subtle, platform-specific, or potentially
confusing. This applies to **all code files in this repository and in any git-ignored local
`sandbox/` folder**: TypeScript, JavaScript, pipeline YAML steps, and PowerShell.

- Prefer "why" over "what": the code shows *what*; the comment explains *why*.
- Add a short JSDoc/comment above each function and inline comments for tricky blocks
  (security decisions, platform quirks, workarounds, non-obvious ordering).
- Keep comments accurate; update them whenever behaviour changes.

### Readable by a human first (mandatory)

Correct is not enough: the code must be **easy to read**. A reviewer should understand a file from
top to bottom without running it and without decoding one-liners.

- Write the plain, boring version. Name intermediate values instead of nesting expressions, split a
  long condition into named booleans, and prefer a small function over a clever chain.
- One statement per line. No dense one-liners that pack a whole operation - or a whole element
  factory call - into a single expression.
- Names carry meaning: no single-letter variables outside a two-line loop or a callback argument,
  and booleans read as assertions (`isVisible`, `canEdit`).
- A function does one thing. If its purpose needs a paragraph in the comment, split it.
- Keep the existing formatting: indentation, a blank line between logical blocks, and the file's
  current line width.
- The same bar applies to tests, build and CI scripts, pipeline YAML and PowerShell. Generated or
  vendored output (`dist/`, `node_modules/`) is exempt.
- A change that is correct but unreadable is **not done**: readability is a review criterion, not a
  preference. When touching a file, leave it clearer than you found it.

---

## 5. ASCII-only text (mandatory)

Use **ASCII only** in comments and documentation (and in file contents generally):
no em-dashes, en-dashes, curly quotes, ellipsis characters, box-drawing characters, or
emoji. Use `-`, `...`, `->`, `<=`, `+--+`, etc. instead.

- The only accepted exception is the **up/down arrow** characters used by the ADO admin
  reorder buttons (`↑` / `↓`) in `src/admin/admin.ts`.
- Status tags in docs: use words (`OK`, `FAIL`, `NOTE`, `SPIKE`, `DRAFT`), not emoji.

---

## 6. Testing (mandatory, enforced)

Every change must be covered by tests, and **every version must be tested against the plan**.

- **Automated tests:** add cases to [`tests/logic.test.ts`](tests/logic.test.ts) (plus the plain-JS
  suites for the pipeline tasks and the CI helpers) and keep `npm test` green. New pure logic
  (parsers, formatters, URL handling, validators) must have tests. The gate is
  `npx tsc --noEmit` + `npm run lint` + `npm test` + `npm run verify:clean` + `npm run build:prod`:
  no push, and no build/upload, without all of them passing.
- **Test plan:** maintain [`docs/13-test-plan.md`](docs/13-test-plan.md). When a feature is added
  or changed, add or update its case(s) there **in the same change**.
- **Run the plan every version:** perform the automated and integration cases, record results per
  version, and fix every failure. Cases that need a human mouse (cross-origin iframe) are marked
  `MAN` with exact steps.
- **Iterate until green:** a failing or missing case must be fixed, then rebuilt, re-uploaded and
  re-tested. Do not stop after a single pass.
- **URL coverage:** the parser/editor must handle every in-project URL shape we know of
  (repositories; files; pull requests; commits; branches; tags; builds; views; artifacts with a
  path; logs with stage/job/task; extension-contributed view ids). Keep the enumerated examples in
  `tests/logic.test.ts` and `docs/13`.
- **Enumerate real links:** when possible, list the project's actual pages/links and confirm each
  parses and resolves; extend the lists when new shapes appear.
