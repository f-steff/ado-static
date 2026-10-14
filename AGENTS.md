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
- **Branches**: `main` (stable) and `develop` (dev). Both are protected (PR + status checks + no
  force-push + no deletion). PRs into `develop` are rebase-merged (flat history); a release **merges**
  `develop` into `main` with a merge commit, so `main` contains every commit `develop` has and the
  release tag lands on that merge commit. Do **not** rebase-merge a release: it rewrites every SHA and
  forks the history (see [`docs/10-development.md`](docs/10-development.md#branching-and-releases)).
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
