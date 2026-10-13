// Shared "About" tab content, used by the project and organization settings pages.
//
// Rationale: both settings pages present the same top-level explanation, so the content lives in
// one place; each page decides where (and under which tab) to show it.
import * as SDK from "azure-devops-extension-sdk";

/** Tiny element factory (mirrors the one in the UI modules). */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (text != null) {
    element.textContent = text;
  }
  return element;
}

/** Builds the About/help content: what Static is, publishing, links, dynamics, trash, permissions. */
export function buildAbout(): HTMLElement {
  const wrap = el("div", "help");

  const heading = (text: string) => wrap.appendChild(el("h3", undefined, text));
  const para = (text: string) => wrap.appendChild(el("p", undefined, text));
  const code = (text: string) => {
    const box = el("pre", "code");
    box.textContent = text;
    wrap.appendChild(box);
  };
  const list = (items: string[]) => {
    const ul = el("ul");
    items.forEach((item) => ul.appendChild(el("li", undefined, item)));
    wrap.appendChild(ul);
  };

  para(
    "Static is a directory of stable, bookmarkable links into an Azure DevOps project. It adds a " +
      "top-level Static group whose hubs are:"
  );
  list([
    "Pages - self-contained HTML pages published by pipelines; selecting one opens it.",
    "Links - curated links into the project (build status/artifacts/logs, repositories, ...).",
    "PR - pull requests (open by default; completed/abandoned are optional).",
    "Repos - the project's repositories with brief statistics."
  ]);

  heading("Publishing a page (pipeline)");
  para(
    "PublishPage@0 has two independent outputs, each enabled by setting its input: `page` publishes " +
      "a Static page, and `tabName` publishes a report tab in the build results (a 'Static page' " +
      "tab). Set the one(s) you want; with both, both are published."
  );
  code(
    "- task: PublishPage@0\n" +
      "  inputs:\n" +
      "    sourcePath: $(Build.ArtifactStagingDirectory)/page/index.html\n" +
      "    page: my-report          # enabler: publish a Static page (lowercase slug)\n" +
      "    tabName: My report       # enabler: publish a build-results tab\n" +
      "    comment: Nightly report  # optional\n" +
      "    createIfMissing: true    # page: create it when the slug is missing\n"
  );
  para(
    "The task needs 'Allow scripts to access the OAuth token' (System.AccessToken). For the page, " +
      "createIfMissing: true creates it when the slug does not exist and updates it otherwise; " +
      "createIfMissing: false fails when the slug is missing while an existing slug is updated. " +
      "Large page content is gzipped and chunked automatically. With neither input set the task " +
      "fails (nothing to publish)."
  );

  heading("Publishing a link (pipeline)");
  para(
    "A pipeline can also publish a fixed link - a stored URL (for example a report or artifact, " +
      "possibly outside this project). Add a step:"
  );
  code(
    "- task: PublishLink@0\n" +
      "  inputs:\n" +
      "    title: Latest report     # shown in the Links hub\n" +
      "    slug: latest-report      # stable, unique slug\n" +
      "    url: https://example.com/report.html\n" +
      "    comment: Nightly report  # optional\n" +
      "    createIfMissing: true    # create the link when the slug is missing\n"
  );
  para(
    "createIfMissing behaves exactly as for pages: true creates the link when missing and updates " +
      "it otherwise; false fails when the slug is missing while an existing slug is updated. The URL " +
      "may also come from the first line of a file (set urlFile instead of url). Published links " +
      "appear with Area 'fixed pipeline artifact'."
  );

  heading("Backing up and restoring (pipeline)");
  para(
    "StaticAdmin@0 moves every project's Static data between editions - for example to seed the dev " +
      "edition from the stable data before a release. It writes and reads the same ZIP archive as " +
      "Static settings -> Backup."
  );
  code(
    "- task: StaticAdmin@0\n" +
      "  inputs:\n" +
      "    mode: backup                                 # or restore\n" +
      "    backupPath: $(Build.ArtifactStagingDirectory)/static-backup.zip\n" +
      "    artifactName: static-backup                  # backup: attach the ZIP as an artifact\n"
  );
  para(
    "A restore replaces each project's data with the archive's; set dryRun: true to see the plan " +
      "without writing. For a restore, download the artifact first (DownloadPipelineArtifact) and " +
      "pass its path as backupPath."
  );

  heading("Creating links");
  para(
    "In the Links tab, give a Title and Slug, then build the URL with the cascading builder: choose " +
      "an Area (Repository, Pipeline or Fixed) and keep choosing until an option is marked [valid]. " +
      "Several levels can be valid at once. Pasting a full URL pre-selects the closest match; a URL " +
      "outside this project is stored as a Fixed link."
  );
  para(
    "Add link keeps your selections and clears only the slug, so several links can be created " +
      "quickly; Clear resets everything."
  );

  heading("Dynamic links");
  para(
    "A link can point at a changing target. Its URL contains the token {{dyn}} and stores how to " +
      "resolve it:"
  );
  list([
    "Repository: newest / oldest open pull request, or the latest commit on a branch.",
    "Pipeline: latest / latest succeeded / latest failed build (needs the Build (read) permission)."
  ]);
  para("If a dynamic target cannot be resolved, a clear message is shown instead of a broken link.");

  heading("Trash");
  para(
    "Deleted pages and links go to a shared Trash for 5 days, where they can be restored or deleted " +
      "immediately. Slugs stay reserved while trashed."
  );

  heading("Permissions");
  list([
    "Reading Pages/Links/PR/Repos needs normal project read access.",
    "Managing them requires project administrator.",
    "The pipeline task uses System.AccessToken."
  ]);

  heading("About this package");
  // Dynamic values come from the SDK; the rest identify the published package.
  const context = SDK.getExtensionContext();
  const host = SDK.getHost();
  const rows: Array<[string, string]> = [
    ["Package", "Static"],
    ["Publisher", (context && context.publisherId) || "f-steff"],
    ["Extension id", (context && context.extensionId) || "static"],
    ["Version", (context && context.version) || "0.0.0"],
    ["Author", "f-steff"],
    ["Repository", "https://github.com/f-steff/ado-static"],
    ["Issues / support", "https://github.com/f-steff/ado-static/issues"],
    ["License", "MIT"],
    ["Installed for", (host && host.name) || "(unknown organization)"]
  ];
  const info = el("table", "about-table");
  rows.forEach(([name, value]) => {
    const row = el("tr");
    row.appendChild(el("th", undefined, name));
    row.appendChild(el("td", undefined, value));
    info.appendChild(row);
  });
  wrap.appendChild(info);

  return wrap;
}
