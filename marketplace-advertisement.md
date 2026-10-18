# Static - the bookmarkable directory for your Azure DevOps project

Static puts a single, always-on directory in your project's sidebar. Collect the links, pages,
pipelines and pull requests your team uses every day, give them stable, human-readable addresses, and
find anything in a couple of clicks - instead of digging through menus or chasing short-lived run
links.

## What makes it different

- **Quick access to what matters.** A curated directory in the project navigation - the project's
  yellow pages: **Links**, **Pages**, **Pipelines**, **PR** and **Repos** in one consistent place.
- **Reach the places Azure DevOps cannot deep-link.** Bookmark a specific build's stage/job/task
  log, the latest succeeded build, the newest open pull request, or the tip of a branch. Targets
  that depend on a build are stored by name, so the link keeps working as ids change; if a target
  genuinely no longer exists you get a clear message, not a broken page.
- **Publish a page straight from your pipeline.** Turn self-contained HTML (a status dashboard,
  coverage report, changelog) into a permanent page in the project navigation.
- **Publish a report tab.** Optionally attach that HTML to the build results as a **Static page**
  tab, next to the run that produced it.
- **Publish or update a link from your pipeline.** A pipeline can create and keep a named link
  (an artifact, an external report) current.
- **Find any pull request.** The **PR** hub's "Global PR #" jump resolves any pull-request number in
  the organization, in any project and any state.
- **Manage it centrally.** Project settings for links and pages; an organization overview across
  projects.

## Getting started

Publish a page and/or a report tab from a pipeline:

```yaml
steps:
  - task: PublishPage@0
    inputs:
      page: 'coverage-report'
      sourcePath: '$(Build.ArtifactStagingDirectory)/coverage/index.html'
      tabName: 'Coverage'
```

Publish or update a link:

```yaml
steps:
  - task: PublishLink@0
    inputs:
      title: 'Latest report'
      slug: 'latest-report'
      url: 'https://example.com/report.html'
```

Then open the **Static** group in your project's sidebar.

## Notes

- Pages and links are written only by pipelines; the admin UI never accepts HTML.
- Content is self-contained (one HTML file per page) and rendered in a sandboxed frame.
- Works with **Azure DevOps Services**.

## Links

- Source, issues and documentation: <https://github.com/f-steff/ado-static>
