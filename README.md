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

## Install

Static is free on the Visual Studio Marketplace:

<https://marketplace.visualstudio.com/items?itemName=f-steff.static>

Press **Get it free**, choose your organization and install. The **Static** group then appears in
every project, and each project starts with an empty list.

Members can keep **private links** of their own in the Links hub - visible only to them - and offer one
to the project with **Share**, which adds it to the project settings as a proposed link for whoever
manages those settings to accept or reject.

## Add a private link from the page you are on

The **About** tab of the settings pages carries a ready-made bookmarklet: right-click it and choose
*Bookmark link* (or drag it to the bookmarks bar). Click that bookmark on any project page and the
**Links** hub opens with your **private** link form already filled in and the builder matched - for a
build log URL down to the stage/job/task target. The link stays visible only to you until you share it.

The link from a project's own settings also **pins that project**: a page outside Azure DevOps (a fixed
link) is still added there, while a page in another project lands in that project.

Anything that can build a URL can do the same, so a wiki page or a pipeline comment can offer *add this
URL to Static* as an ordinary link:

```
https://dev.azure.com/{org}/{project}/_apps/hub/{publisher}.{extension}.static-links-hub?url={encoded page url}
```

Project administrators can use the settings page for a link everybody should see:
`.../_settings/{publisher}.{extension}.static-admin-hub?url=...` opens the Links tab, which creates a
**project** link instead.

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

## Documentation

Start at [docs/README.md](docs/README.md). The most useful entry points:

| Document | Purpose |
| --- | --- |
| [01-overview.md](docs/01-overview.md) | What Static is for, and the concepts behind it. |
| [06-pipeline-integration.md](docs/06-pipeline-integration.md) | Publishing pages and links from a pipeline, with YAML examples. |
| [07-admin-experience.md](docs/07-admin-experience.md) | The hubs, the project settings and the organization settings. |
| [13-test-plan.md](docs/13-test-plan.md) | The test plan and the results per version. |
| [16-development-setup.md](docs/16-development-setup.md) | Building, packaging, publishing, and the development program. |

## Contributing

- **Found a bug?** Open an [issue](https://github.com/f-steff/ado-static/issues) with the version
  (shown at the bottom of every hub), what you did, what happened and what you expected.
- **Have an idea, a suggestion or a question?** An issue is the right place - improvements to the hubs,
  the publishing tasks and the documentation are all welcome.
- **Want to change the code or the docs?** See the
  [development setup guide](docs/16-development-setup.md); work lands through a pull request against
  `develop`, and the local gate (`tsc`, `lint`, `test`, `verify:clean`, `build:prod`) must pass.
  Everything in this repository is intended to be publishable: never commit instance-identifying data
  (organization, project, repository or user names, machine paths, tokens, private URLs) and keep the
  code and documentation ASCII-only - see [`AGENTS.md`](AGENTS.md).

### Trying a fix before it is released

If you reported a problem or asked for a feature and would like to try it before the next release,
ask the developer to add your organization to the development program. The change is published to a
private development edition (`static-dev`) after every merge.

It is installed **instead of** the released edition: the two cannot be installed at the same time, and
an installation applies to every project. Switching between them is possible, but takes a little work -
back up, uninstall one edition and install the other, then restore. It is a work in progress, so expect
things to move. The details are in
[16-development-setup.md](docs/16-development-setup.md#the-development-program).

## License

MIT - see [`LICENSE`](LICENSE).
