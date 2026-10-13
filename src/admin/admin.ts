import * as SDK from "azure-devops-extension-sdk";

import {
  LinkEntry,
  LinkIndex,
  LinkTrashEntry,
  PageIndex,
  PageMetadata,
  TrashEntry,
  addLink,
  addPage,
  clearPage,
  currentProjectId,
  emptyIndex,
  emptyLinks,
  getHiddenRepos,
  listDocuments,
  purgeExpiredLinks,
  purgeExpiredTrash,
  purgeLink,
  purgeTrashEntry,
  removeLink,
  removePage,
  restoreLink,
  restorePage,
  setRepoHidden,
  updateLink,
  updatePage,
  writeProjectDocuments
} from "../common/data-service";
import { buildAbout } from "../common/about";
import { buildBundle, bundleFileName, parseBundle } from "../common/backup";
import { getHeading } from "../common/branding";
import { PipelineSummary, getBuildInfo, getBuildTimeline, getPipelineSummaries } from "../common/build-service";
import { checkProjectUrl, describeProjectUrl } from "../common/ado-url";
import { consumedParams, isFixedArea, targetMatches } from "../common/builder-core";
import { DYNAMIC_TOKEN, DynamicSpec, LOG_JOB_TOKEN, LOG_STAGE_TOKEN, LOG_TASK_TOKEN, hasAnyToken, hasToken, normalizeTokens } from "../common/dynamic-links";
import { BuilderOption, buildTargets, composePath, rootOptions } from "../common/link-builder";
import { fixedUrlError, isHttpUrl, linkAreaLabel } from "../common/link-url";
import { confirmDialog } from "../common/dialog";
import { HUB_LINKS, HUB_PAGES, pagesOrgSettingsUrl, pagesProjectSettingsUrl, pagesHubUrl, extensionVersion } from "../common/extension-urls";
import { withQueryParam } from "../common/urls";
import { formatBytes, formatBytesWhole } from "../common/format";
import { trashExpiryUtc } from "../common/index-logic";
import { RepositoryInfo, listRepositories } from "../common/git-service";
import { getHostNavigation, hostNavigate, HostNavigationService } from "../common/host-nav";
import { describeError, logError, logInfo } from "../common/log";
import { slugError as validateSlug, slugify } from "../common/validation";

/**
 * Project-settings admin for Pages.
 *
 * Responsibilities: enable/disable Pages for the project and manage the page list (add,
 * edit, clear, enable/disable, hide, reorder, delete). Content itself is never shown or
 * edited here  -  it is pipeline-owned (see docs/07).
 *
 * UX rationale: the same form is used for creating and editing (fewer modes to learn), the
 * slug is immutable once created (URL stability), and the primary action stays disabled
 * until the input is valid so mistakes cannot be submitted.
 */

// Slug validation lives in common/validation.ts (shared with unit tests).

// Cached state; the form fields are module state so typing does not force a re-render.
let index: PageIndex = emptyIndex();
let links: LinkIndex = emptyLinks();
let errorText = "";
// Active settings tab: links | pages | repos | trash.
let activeTab = "links";
let editingPageId: string | null = null;
let formName = "";
let formSlug = "";
let formComment = "";
// Links form state.
let editingLinkId: string | null = null;
let formLinkTitle = "";
let formLinkSlug = "";
let formLinkUrl = "";
let formLinkComment = "";
// Dynamic-target state for a link (set by the cascading builder or a Repos-tab shortcut).
let formLinkDynamicSpec: DynamicSpec | undefined = undefined;
// Cascading builder state. Kept in module scope so the whole tree of selections (and every
// branch you have visited) survives re-renders while the page stays open.
let builderChosen: BuilderOption[] = [];
let builderLevels: BuilderOption[][] = [rootOptions()];
let builderSelected: string[] = [];
let builderContainer: HTMLElement | null = null;
// The URL input in the link form (updated by the builder).
let linkUrlInput: HTMLInputElement | null = null;
// Re-runs link-form validation (so builder/paste changes update the Add button).
let linkFormRefresh: (() => void) | null = null;
// Last builder error/message shown inside the builder box.
let builderError = "";
// Guards against overlapping paste runs (a paste fires both a paste and a change event): only the
// newest run may mutate the builder state, so the levels cannot interleave into duplicates.
let pasteGeneration = 0;
// The last URL value that was parsed. Rationale: a paste triggers both paste and change; skipping
// an identical value avoids a second, visually jumpy re-parse (levels expanding on blur).
let lastParsedUrl = "";
// Loaded options per parent path (avoids re-fetching when you go back).
const builderCache = new Map<string, BuilderOption[]>();
// Remembered child selection per parent path (restores a branch when you return to it).
const builderMemory = new Map<string, string>();
// Soft memory: the last chosen option key per level, independent of the parent path. Rationale:
// when an earlier level changes (e.g. another build), the option keys of the later levels change
// with it; matching by key re-selects the closest target by name (e.g. the same log target).
const builderLevelMemory: string[] = [];
// The last log target the admin chose. Log targets are stored by NAME (token placeholders), so
// this exact option can be carried forward unchanged when the pipeline/build/mode changes; it is
// resolved (or reported missing) against the build the link points at when the link is opened.
let builderLastLogTarget: BuilderOption | null = null;

// `applyTheme: true` applies the user's theme (light/dark) variables to this document.
SDK.init({ applyTheme: true });
logInfo("Pages admin initializing.");

// Safety net: if initialization stalls (e.g. a hung SDK call), fail explicitly so the host
// shows a real error instead of the generic "taking longer than expected" message.
let settled = false;
let nav: HostNavigationService | undefined;
// Known tabs; the active tab is mirrored into the host hash so Back/Forward work.
const ADMIN_TABS = ["links", "pages", "pipelines", "repos", "backup", "trash", "about"];

/** Normalizes a hash value (strips a leading '#'). */
function normalizeTab(hash: string): string {
  return (hash || "").replace(/^#/, "");
}

/** True when a hash value names one of this page's tabs. */
function isAdminTab(id: string): boolean {
  return ADMIN_TABS.indexOf(id) >= 0;
}
const loadGuard = window.setTimeout(() => {
  if (!settled) {
    settled = true;
    SDK.notifyLoadFailed("Pages settings initialization timed out.");
  }
}, 20000);

// SDK lifecycle: init -> ready -> load -> render -> notify.
SDK.ready()
  .then(async () => {
    try {
      await load();
      // The active tab lives in the host hash so each tab is a distinct history entry: switching
      // is instant (a same-document hash change) and the browser Back button returns to the
      // previous tab.
      nav = await getHostNavigation();
      const initialTab = (await nav.getHash() || "").replace(/^#/, "");
      if (isAdminTab(initialTab)) {
        activeTab = initialTab;
      }
      nav.onHashChanged((value) => {
        const id = (value || "").replace(/^#/, "");
        if (isAdminTab(id) && id !== activeTab) {
          activeTab = id;
          errorText = "";
          render();
        }
      });
      render();
      settled = true;
      window.clearTimeout(loadGuard);
      SDK.notifyLoadSucceeded();
      logInfo("Pages admin ready.");
    } catch (error) {
      settled = true;
      window.clearTimeout(loadGuard);
      logError("Admin initialization failed.", error);
      errorText = error instanceof Error ? error.message : String(error);
      render();
      SDK.notifyLoadFailed(errorText);
    }
  })
  .catch((error) => {
    // SDK.ready() itself failed; still report failure so the host does not spin forever.
    settled = true;
    window.clearTimeout(loadGuard);
    logError("SDK ready failed.", error);
    SDK.notifyLoadFailed(error instanceof Error ? error.message : String(error));
  });

/** Loads the page and link indexes; auto-purges expired trash first. */
async function load(): Promise<void> {
  // Deleted pages/links are permanently removed once the retention window has passed.
  index = await purgeExpiredTrash(5);
  links = await purgeExpiredLinks(5);
}

/** Tiny element factory to keep the DOM code readable. */
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

/** Builds the whole admin UI. Called on load and after each mutation. */
function render(): void {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }
  root.innerHTML = "";

  const page = el("div", "page");
  page.appendChild(getHeading("h1", "Static"));
  // Include the project name so the isolated scope of these settings is explicit.
  const webContext = SDK.getWebContext();
  const projectLabel =
    webContext && webContext.project ? webContext.project.name : "(unknown project)";
  page.appendChild(
    el("p", "subtitle", `Project: ${projectLabel}  -  manage this project's static links.`)
  );

  // Tabbed interface: Links/Pages/Repos on the left; then (right) Trash with a count, the
  // off-page Org.Settings button, and About.
  const tabs = el("div", "tabs");
  const trashCount = (index.trash || []).length + (links.trash || []).length;
  const tabDefs: Array<[string, string, boolean]> = [
    ["links", "Links", false],
    ["pages", "Pages", false],
    ["pipelines", "Pipelines", false],
    ["repos", "Repos", false],
    ["backup", "Backup", false],
    ["trash", `Trash (${trashCount})`, true],
    ["about", "About", false]
  ];
  tabDefs.forEach(([id, label, right]) => {
    // The Org.Settings button is not a tab: it leaves this page for the organization settings.
    if (id === "about") {
      const orgButton = el("button", "tab-action", "Org.Settings");
      orgButton.title = "Open the organization settings";
      orgButton.addEventListener("click", () => void hostNavigate(pagesOrgSettingsUrl()));
      tabs.appendChild(orgButton);
    }
    const button = el(
      "button",
      "tab" + (activeTab === id ? " active" : "") + (right ? " tab-right" : ""),
      label
    );
    button.addEventListener("click", () => {
      activeTab = id;
      errorText = "";
      // A same-document hash navigation: instant switch, real history entry (Back works).
      if (nav) {
        try {
          nav.navigate(pagesProjectSettingsUrl(projectName()) + "#" + id);
        } catch (error) {
          // Fall through to an in-place switch.
        }
      }
      render();
    });
    tabs.appendChild(button);
  });
  page.appendChild(tabs);

  if (errorText) {
    page.appendChild(el("p", "error", errorText));
  }

  const content = el("div", "tab-content");
  if (activeTab === "links") {
    content.appendChild(el("h2", undefined, editingLinkId ? "Edit link" : "Add link"));
    const linkFormSection = el("div", "section");
    linkFormSection.appendChild(buildLinkForm());
    content.appendChild(linkFormSection);

    content.appendChild(el("h2", undefined, "Links"));
    const linkTableSection = el("div", "section");
    linkTableSection.appendChild(buildLinkTable());
    content.appendChild(linkTableSection);
  } else if (activeTab === "pages") {
    content.appendChild(el("h2", undefined, editingPageId ? "Edit page" : "Add page"));
    const formSection = el("div", "section");
    formSection.appendChild(buildForm());
    content.appendChild(formSection);

    content.appendChild(el("h2", undefined, "Pages"));
    // Summary: page count and total content size (the org page no longer shows size).
    const pageCount = (index.pages || []).length;
    const totalBytes = (index.pages || []).reduce((sum, page) => sum + (page.sizeBytes || 0), 0);
    content.appendChild(
      el("p", "subtitle", `${pageCount} page(s), total content size ${formatBytesWhole(totalBytes)}.`)
    );
    const tableSection = el("div", "section");
    tableSection.appendChild(buildTable());
    content.appendChild(tableSection);
  } else if (activeTab === "pipelines") {
    content.appendChild(buildPipelinesSection());
  } else if (activeTab === "repos") {
    content.appendChild(buildReposSection());
  } else if (activeTab === "backup") {
    content.appendChild(buildBackupSection());
  } else if (activeTab === "about") {
    content.appendChild(buildAbout());
  } else {
    content.appendChild(el("h2", undefined, "Trash"));
    const trashSection = el("div", "section");
    trashSection.appendChild(buildGlobalTrashTable());
    content.appendChild(trashSection);
  }
  page.appendChild(content);

  // Running version, centered at the bottom (matches the hub frames).
  page.appendChild(el("p", "version", `Static ${extensionVersion()}`));

  root.appendChild(page);
}

/**
 * Backup tab: export this project's data as JSON, or import a bundle into it.
 * Rationale: the two Marketplace editions keep separate data (it is scoped per extension id), so a
 * portable bundle is the way to copy a project between them (for example to seed dev before a
 * release), and it doubles as a backup. The text box is both the export output and the import input,
 * so the feature still works when a sandboxed frame blocks downloads or the file picker.
 */
function buildBackupSection(): HTMLElement {
  const section = el("div", "section");
  section.appendChild(el("h2", undefined, "Backup and restore"));
  section.appendChild(
    el(
      "p",
      "subtitle",
      "Export everything in this project (pages, links and settings) as JSON, or import it into " +
        "another edition, project or organization."
    )
  );

  const textarea = el("textarea", "backup-text");
  textarea.rows = 6;
  textarea.spellcheck = false;
  textarea.placeholder = "Exported JSON appears here; paste JSON here to import.";

  const status = el("p", "subtitle");

  const context = SDK.getExtensionContext();
  const webContext = SDK.getWebContext();
  const source = {
    publisher: (context && context.publisherId) || "",
    extension: (context && context.extensionId) || "",
    projectId: currentProjectId(),
    projectName: webContext && webContext.project ? webContext.project.name : ""
  };

  const exportButton = el("button", "primary", "Export to JSON");
  exportButton.addEventListener("click", () => {
    void (async () => {
      status.textContent = "Reading data...";
      try {
        const documents = await listDocuments();
        const bundle = buildBundle(documents, source);
        const json = JSON.stringify(bundle, null, 2);
        textarea.value = json;
        downloadText(bundleFileName(source.projectName), json);
        status.textContent = `Exported ${documents.length} document(s).`;
      } catch (error) {
        status.textContent = `Export failed: ${describeError(error)}`;
      }
    })();
  });

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "application/json,.json";
  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) {
      void file.text().then((content) => {
        textarea.value = content;
        status.textContent = `Loaded ${file.name}. Review it, then choose Import.`;
      });
    }
  });

  const replace = document.createElement("input");
  replace.type = "checkbox";
  replace.checked = true;
  const replaceRow = el("div", "form-row");
  replaceRow.appendChild(replace);
  replaceRow.appendChild(
    el("span", undefined, "Replace this project's data (remove documents not in the file)")
  );

  const importButton = el("button", "primary", "Import");
  importButton.addEventListener("click", () => {
    void (async () => {
      const parsed = parseBundle(textarea.value);
      if (!parsed.ok) {
        status.textContent = parsed.error;
        return;
      }
      const count = parsed.bundle.documents.length;
      const from = parsed.bundle.source.projectName || "another project";
      const mode = replace.checked
        ? "replace this project's data with"
        : "merge into this project's data";
      const ok = await confirmDialog(`Import ${count} document(s) from ${from} and ${mode} it?`);
      if (!ok) {
        return;
      }
      status.textContent = "Importing...";
      try {
        await writeProjectDocuments(parsed.bundle.documents, replace.checked);
        await load();
        status.textContent = `Imported ${count} document(s).`;
      } catch (error) {
        status.textContent = `Import failed: ${describeError(error)}`;
      }
    })();
  });

  const buttons = el("div", "form-buttons");
  buttons.appendChild(exportButton);
  buttons.appendChild(importButton);

  section.appendChild(textarea);
  section.appendChild(fileInput);
  section.appendChild(replaceRow);
  section.appendChild(buttons);
  section.appendChild(status);
  section.appendChild(
    el(
      "p",
      "hint",
      "Exported files contain only this project's Static data (no tokens or secrets). Importing " +
        "overwrites documents that share an id."
    )
  );
  return section;
}

/** Downloads a text file client-side; failures are tolerated (the JSON stays in the text box). */
function downloadText(fileName: string, content: string): void {
  try {
    const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    logInfo("download blocked; use the text box to copy the export.", error);
  }
}

/** Global trash: pages and links merged, with a Type column. */
function buildGlobalTrashTable(): HTMLElement {
  const table = el("table", "data-table");
  const head = el("thead");
  const headRow = el("tr");
  ["Type", "Title", "Slug", "Deleted", "Permanent delete by"].forEach((label) =>
    headRow.appendChild(el("th", undefined, label))
  );
  head.appendChild(headRow);
  table.appendChild(head);

  const body = el("tbody");
  table.appendChild(body);

  interface TrashRow {
    type: string;
    title: string;
    slug: string;
    deletedUtc: string;
    deletedBy: string;
    restore: () => void;
    purge: () => void;
  }
  const rows: TrashRow[] = [];
  (index.trash || []).forEach((entry) => {
    rows.push({
      type: "Page",
      title: entry.page.name,
      slug: entry.page.slug,
      deletedUtc: entry.deletedUtc,
      deletedBy: entry.deletedBy,
      restore: () => void onRestore(entry.trashId),
      purge: () => void onPurge(entry)
    });
  });
  (links.trash || []).forEach((entry) => {
    rows.push({
      type: "Link",
      title: entry.link.title,
      slug: entry.link.slug,
      deletedUtc: entry.deletedUtc,
      deletedBy: entry.deletedBy,
      restore: () => void onRestoreLink(entry.trashId),
      purge: () => void onPurgeLink(entry)
    });
  });
  rows.sort((a, b) => b.deletedUtc.localeCompare(a.deletedUtc));

  if (rows.length === 0) {
    const row = el("tr");
    const cell = el("td", "empty", "Trash is empty.");
    cell.colSpan = 5;
    row.appendChild(cell);
    body.appendChild(row);
    return table;
  }

  rows.forEach((entry) => {
    const row = el("tr", "data-row");
    row.appendChild(el("td", "type", entry.type));
    row.appendChild(el("td", undefined, entry.title));
    row.appendChild(el("td", "mono", entry.slug));
    row.appendChild(
      el("td", undefined, entry.deletedUtc + (entry.deletedBy ? ` (${entry.deletedBy})` : ""))
    );
    row.appendChild(el("td", "col-nowrap", trashExpiryUtc(entry.deletedUtc) || "-"));
    body.appendChild(row);

    const actionsRow = el("tr", "actions-row");
    const actionsCell = el("td");
    actionsCell.colSpan = 5;
    const box = el("div", "row-actions");
    box.appendChild(rowButton("Restore", entry.restore));
    box.appendChild(rowButton("Delete instantly", entry.purge));
    actionsCell.appendChild(box);
    actionsRow.appendChild(actionsCell);
    body.appendChild(actionsRow);
  });

  return table;
}

/** Help tab: a short guide to the extension, publishing and link options. */
function buildHelp(): HTMLElement {
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
    "Static is a directory of stable, bookmarkable links into this Azure DevOps project. It adds " +
      "a top-level Static group whose hubs are:"
  );
  list([
    "Pages - self-contained HTML pages published by pipelines; selecting one opens it.",
    "Links - curated links into the project (build status/artifacts/logs, repositories, ...).",
    "PR - pull requests (open by default; completed/abandoned are optional).",
    "Repos - the project's repositories with brief statistics."
  ]);

  heading("Publishing a page (pipeline)");
  para("Pages are written only by the PublishPage task. Add a step to your pipeline:");
  code(
    "- task: PublishPage@0\n" +
      "  inputs:\n" +
      "    page: my-report          # the page slug (lowercase, hyphens)\n" +
      "    sourcePath: $(Build.ArtifactStagingDirectory)/page/index.html\n" +
      "    comment: Nightly report  # optional\n"
  );
  para(
    "The task needs 'Allow scripts to access the OAuth token' (System.AccessToken). It creates the " +
      "page if missing and updates it otherwise; large content is gzipped and chunked automatically."
  );

  heading("Creating links");
  para(
    "In the Links tab, give a Title and Slug, then build the URL with the cascading builder: choose " +
      "an Area (Repository or Pipeline) and keep choosing until an option is marked [valid]. Several " +
      "levels can be valid at once. Pasting a full in-project URL pre-selects the closest match."
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

  return wrap;
}

/** Pipelines tab: pipelines with a "Create Link type" dropdown + Create. */
function buildPipelinesSection(): HTMLElement {
  const wrap = el("div");
  wrap.appendChild(
    el(
      "p",
      "subtitle",
      "Pipelines in this project (needs the Build (read) permission). Choose a Link type and press Create to pre-fill a dynamic link."
    )
  );
  const table = el("table", "data-table");
  const head = el("thead");
  const headRow = el("tr");
  ["Pipeline", "Runs", "Last result", "Create Link type"].forEach((label) =>
    headRow.appendChild(el("th", undefined, label))
  );
  head.appendChild(headRow);
  table.appendChild(head);
  const body = el("tbody");
  table.appendChild(body);
  wrap.appendChild(table);
  void loadAdminPipelines(body);
  return wrap;
}

/** Link types offered per pipeline in the Pipelines tab. */
const PIPELINE_LINK_TYPES: Array<[string, string]> = [
  ["latest", "Latest build (dynamic)"],
  ["latest-succeeded", "Latest succeeded build (dynamic)"],
  ["latest-failed", "Latest failed build (dynamic)"],
  ["artifacts", "Latest build artifacts (dynamic)"],
  ["logs", "Latest build logs (dynamic)"]
];

/** Loads pipelines into the Pipelines tab. */
async function loadAdminPipelines(body: HTMLElement): Promise<void> {
  body.innerHTML = "";
  try {
    const pipelines = await getPipelineSummaries();
    if (pipelines.length === 0) {
      const row = el("tr");
      const cell = el("td", "empty", "No pipelines.");
      cell.colSpan = 4;
      row.appendChild(cell);
      body.appendChild(row);
      return;
    }
    pipelines.forEach((pipeline) => {
      const row = el("tr");
      row.appendChild(el("td", undefined, pipeline.name));
      row.appendChild(el("td", undefined, String(pipeline.runCount)));
      row.appendChild(el("td", undefined, pipeline.lastResult || "never"));
      const createCell = el("td");
      const inline = el("div", "inline-actions");
      const select = document.createElement("select");
      PIPELINE_LINK_TYPES.forEach(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        select.appendChild(option);
      });
      inline.appendChild(select);
      inline.appendChild(rowButton("Create", () => quickAddPipelineLink(pipeline, select.value)));
      createCell.appendChild(inline);
      row.appendChild(createCell);
      body.appendChild(row);
    });
  } catch (error) {
    const row = el("tr");
    const cell = el("td", "empty", "Pipelines unavailable: " + describeError(error));
    cell.colSpan = 4;
    row.appendChild(cell);
    body.appendChild(row);
  }
}

/** Pre-fills the link form from a pipeline shortcut and switches to the Links tab. */
function quickAddPipelineLink(pipeline: PipelineSummary, mode: string): void {
  const base =
    `https://dev.azure.com/${organizationName()}/${encodeURIComponent(projectName())}` +
    `/_build/results?buildId=${DYNAMIC_TOKEN}`;
  let view = "&view=results";
  let buildMode: "latest" | "latest-succeeded" | "latest-failed" = "latest";
  let suffix = "latest build";
  if (mode === "latest-succeeded") {
    buildMode = "latest-succeeded";
    suffix = "latest succeeded build";
  } else if (mode === "latest-failed") {
    buildMode = "latest-failed";
    suffix = "latest failed build";
  } else if (mode === "artifacts") {
    view = "&view=artifacts&pathAsName=false&type=publishedArtifacts";
    suffix = "build artifacts";
  } else if (mode === "logs") {
    view = "&view=logs";
    suffix = "build logs";
  }
  editingLinkId = null;
  formLinkComment = "";
  formLinkUrl = base + view;
  formLinkDynamicSpec = { kind: "build", buildMode, definitionId: pipeline.id };
  formLinkTitle = `${pipeline.name}: ${suffix}`;
  formLinkSlug = slugify(`${pipeline.name}-${mode}`);
  builderChosen = [];
  builderSelected = [];
  builderLevels = [rootOptions()];
  builderCache.clear();
  builderMemory.clear(); builderLevelMemory.length = 0; builderLastLogTarget = null;
  builderError = "";
  switchToLinksAndParse();
}

/** Repos tab: repositories with a "Link type" dropdown + Create, and a visibility toggle. */
function buildReposSection(): HTMLElement {
  const wrap = el("div");
  wrap.appendChild(
    el(
      "p",
      "subtitle",
      "Repositories in this project. Choose a Link type and press Create to pre-fill a dynamic link; untick Show in hub to hide a repository from the Repos hub."
    )
  );
  const table = el("table", "data-table");
  const head = el("thead");
  const headRow = el("tr");
  ["Show", "Repository", "Default branch", "Create Link type"].forEach((label) =>
    headRow.appendChild(el("th", undefined, label))
  );
  head.appendChild(headRow);
  table.appendChild(head);
  const body = el("tbody");
  table.appendChild(body);
  wrap.appendChild(table);
  void loadAdminRepos(body);
  return wrap;
}

/** Link types offered per repository in the Repos tab. */
const REPO_LINK_TYPES: Array<[string, string]> = [
  ["pr-newest-open", "Newest open PR (dynamic)"],
  ["pr-oldest-open", "Oldest open PR (dynamic)"],
  ["commit-latest", "Latest commit - default branch (dynamic)"],
  ["repo-root", "Repository root"],
  ["pr-list", "Open pull requests"],
  ["pr-all", "All pull requests"],
  ["commits", "Commits (default branch)"],
  ["branches", "Branches"],
  ["tags", "Tags"]
];

/** Loads repositories into the Repos tab (link-type dropdown, Create button, visibility toggle). */
async function loadAdminRepos(body: HTMLElement): Promise<void> {
  body.innerHTML = "";
  try {
    const [repos, hidden] = await Promise.all([listRepositories(), getHiddenRepos()]);
    const hiddenSet = new Set(hidden);
    if (repos.length === 0) {
      const row = el("tr");
      const cell = el("td", "empty", "No repositories.");
      cell.colSpan = 4;
      row.appendChild(cell);
      body.appendChild(row);
      return;
    }
    repos
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((repo) => {
        const row = el("tr");

        // Show (public visibility).
        const showCell = el("td");
        const show = document.createElement("input");
        show.type = "checkbox";
        show.checked = !hiddenSet.has(repo.id);
        show.title = "Show this repository in the Repos hub";
        show.addEventListener("change", () => {
          void setRepoHidden(repo.id, !show.checked).catch((error) => {
            show.checked = !show.checked;
            fail("Unable to update repository visibility.", error);
          });
        });
        showCell.appendChild(show);
        row.appendChild(showCell);

        row.appendChild(el("td", undefined, repo.name));
        row.appendChild(el("td", undefined, repo.defaultBranch || "-"));

        // Create Link type: the dropdown and the Create button sit next to each other.
        const createCell = el("td");
        const inline = el("div", "inline-actions");
        const select = document.createElement("select");
        REPO_LINK_TYPES.forEach(([value, label]) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          select.appendChild(option);
        });
        inline.appendChild(select);
        inline.appendChild(rowButton("Create", () => quickAddRepoLink(repo, select.value)));
        createCell.appendChild(inline);
        row.appendChild(createCell);

        body.appendChild(row);
      });
  } catch (error) {
    const row = el("tr");
    const cell = el("td", "empty", "Repositories unavailable: " + describeError(error));
    cell.colSpan = 5;
    row.appendChild(cell);
    body.appendChild(row);
  }
}

/** Switches to the Links tab (with a history entry) and configures the builder from the URL. */
function switchToLinksAndParse(): void {
  activeTab = "links";
  errorText = "";
  // A hash navigation so Back returns to the previous tab (the tab came from a Repos/Pipelines
  // shortcut, which should be reversible).
  if (nav) {
    try {
      nav.navigate(pagesProjectSettingsUrl(projectName()) + "#links");
    } catch (error) {
      // Fall through to an in-place switch.
    }
  }
  render();
  // Parse the pre-filled URL so the builder levels reflect it (never truncated).
  void applyPastedUrl();
}

/** Pre-fills the link form from a repository shortcut and switches to the Links tab. */
function quickAddRepoLink(repo: RepositoryInfo, mode: string): void {
  const base = linkBase() + "/_git/" + encodeURIComponent(repo.name);
  editingLinkId = null;
  formLinkComment = "";
  formLinkDynamicSpec = undefined;
  switch (mode) {
    case "pr-newest-open":
    case "pr-oldest-open":
      formLinkUrl = base + "/pullrequest/" + DYNAMIC_TOKEN;
      formLinkDynamicSpec = {
        kind: "pr",
        prScope: mode === "pr-oldest-open" ? "oldest-open" : "newest-open",
        repositoryId: repo.id
      };
      formLinkTitle = `${repo.name}: ${mode === "pr-oldest-open" ? "oldest open PR" : "newest open PR"}`;
      formLinkSlug = slugify(`${repo.name}-${mode === "pr-oldest-open" ? "oldest-pr" : "newest-pr"}`);
      break;
    case "commit-latest":
      formLinkUrl = base + "/commit/" + DYNAMIC_TOKEN;
      formLinkDynamicSpec = {
        kind: "commit",
        repositoryId: repo.id,
        branch: repo.defaultBranch || "main"
      };
      formLinkTitle = `${repo.name}: latest commit`;
      formLinkSlug = slugify(`${repo.name}-latest-commit`);
      break;
    case "pr-list":
      formLinkUrl = base + "/pullrequests?_a=active";
      formLinkTitle = `${repo.name}: open pull requests`;
      formLinkSlug = slugify(`${repo.name}-pull-requests`);
      break;
    case "pr-all":
      formLinkUrl = base + "/pullrequests?_a=all";
      formLinkTitle = `${repo.name}: all pull requests`;
      formLinkSlug = slugify(`${repo.name}-all-pull-requests`);
      break;
    case "commits":
      formLinkUrl = base + "/commits";
      formLinkTitle = `${repo.name}: commits`;
      formLinkSlug = slugify(`${repo.name}-commits`);
      break;
    case "branches":
      formLinkUrl = base + "/branches";
      formLinkTitle = `${repo.name}: branches`;
      formLinkSlug = slugify(`${repo.name}-branches`);
      break;
    case "tags":
      formLinkUrl = base + "/tags";
      formLinkTitle = `${repo.name}: tags`;
      formLinkSlug = slugify(`${repo.name}-tags`);
      break;
    default:
      // Repository root (a fixed link).
      formLinkUrl = base;
      formLinkTitle = repo.name;
      formLinkSlug = slugify(repo.name);
      break;
  }
  // The shortcut bypasses the builder; start it fresh.
  builderChosen = [];
  builderSelected = [];
  builderLevels = [rootOptions()];
  builderCache.clear();
  builderMemory.clear(); builderLevelMemory.length = 0; builderLastLogTarget = null;
  builderError = "";
  switchToLinksAndParse();
}

/** Builds the add/edit form (one field per line) plus always-visible validation. */
function buildForm(): HTMLElement {
  const form = el("div", "form");

  const nameField = textField("Title", formName, true, (value) => {
    formName = value;
  });
  const slugField = textField("Slug", formSlug, true, (value) => {
    formSlug = value;
  });
  const commentField = textField("Comment", formComment, true, (value) => {
    formComment = value;
  });

  // Slug is immutable when editing so existing URLs never break.
  slugField.input.disabled = editingPageId != null;

  // Append the labelled rows in order (name, slug, comment).
  form.appendChild(nameField.row);
  form.appendChild(slugField.row);
  form.appendChild(commentField.row);

  // Always-visible guidance/validation line (updated live as the user types).
  const hint = el("p", "hint");
  form.appendChild(hint);

  // Buttons sit below the fields; the primary action is disabled until valid.
  const buttons = el("div", "form-buttons");
  const primary = el("button", "primary", editingPageId ? "Save changes" : "Add page");
  const secondary = el("button", undefined, editingPageId ? "Cancel" : "Clear");
  buttons.appendChild(primary);
  buttons.appendChild(secondary);
  form.appendChild(buttons);

  // Live validation: recompute the message and the primary button's enabled state.
  const refresh = () => {
    // Show red only for a slug the user has actually entered and that is invalid; an empty
    // form shows neutral guidance (no scary red at first sight).
    const error = slugError();
    hint.textContent =
      error || "Slug: lowercase letters/numbers separated by single hyphens; must be unique.";
    hint.classList.toggle("error", Boolean(error));
    slugField.input.classList.toggle("invalid", Boolean(error));
    const nameOk = formName.trim().length > 0;
    const slugOk = formSlug.trim().length > 0 && !error;
    primary.disabled = !nameOk || !slugOk;
  };

  // Listening on input revalidates without re-rendering, so focus/caret are preserved.
  nameField.input.addEventListener("input", refresh);
  slugField.input.addEventListener("input", refresh);
  commentField.input.addEventListener("input", refresh);
  refresh();

  primary.addEventListener("click", () => void onPrimary());
  secondary.addEventListener("click", () => onSecondary());

  return form;
}

/** Creates a labelled text field; returns both the row (for layout) and the input. */
function textField(
  label: string,
  value: string,
  enabledField: boolean,
  onChange: (value: string) => void
): { row: HTMLElement; input: HTMLInputElement } {
  const row = el("label", "form-row");
  row.appendChild(el("span", "form-label", label));
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.disabled = !enabledField;
  input.addEventListener("input", () => onChange(input.value));
  row.appendChild(input);
  return { row, input };
}

/** Builds the page table with per-row actions. */
function buildTable(): HTMLElement {
  const table = el("table", "data-table");
  const head = el("thead");
  const headRow = el("tr");
  ["Title", "Slug", "Size", "Comment", "Updated", "Status"].forEach((label) =>
    headRow.appendChild(el("th", undefined, label))
  );
  head.appendChild(headRow);
  table.appendChild(head);

  const body = el("tbody");
  table.appendChild(body);

  const pages = (index.pages || []).slice().sort(byOrderThenName);
  if (pages.length === 0) {
    const row = el("tr");
    const cell = el("td", "empty", "No pages yet.");
    cell.colSpan = 6;
    row.appendChild(cell);
    body.appendChild(row);
    return table;
  }

  pages.forEach((meta, i) => {
    const row = el("tr", "data-row");
    // Rationale: do not dim the whole row for a disabled page - that made the now-"Enable"
    // action look like a disabled (ghosted) button even though it was still clickable. Mark
    // only the page name so the state is still visible without affecting the actions.
    const nameCell = el("td", undefined, meta.name);
    if (!meta.enabled) {
      nameCell.classList.add("disabled-name");
    }
    row.appendChild(nameCell);
    row.appendChild(el("td", "mono", meta.slug));
    row.appendChild(el("td", undefined, formatBytes(meta.sizeBytes)));
    row.appendChild(el("td", undefined, meta.comment || ""));
    row.appendChild(el("td", undefined, meta.updatedUtc || "never"));
    row.appendChild(el("td", "status", statusText(meta)));

    body.appendChild(row);

    // Actions get their own row spanning the data columns (Name..Status), left-aligned, so the
    // data cells keep the full table width and never wrap awkwardly.
    const actionsRow = el("tr", "actions-row");
    const actionsCell = el("td");
    actionsCell.colSpan = 6;
    const actionsBox = el("div", "row-actions");

    // A single Edit action replaces separate rename/comment actions.
    actionsBox.appendChild(rowButton("View", () => openInNewTab(pageViewUrl(meta.slug))));
    actionsBox.appendChild(rowButton("Edit", () => onEdit(meta)));
    actionsBox.appendChild(rowButton("Clear", () => void onClear(meta)));
    actionsBox.appendChild(
      rowButton(meta.enabled ? "Disable" : "Enable", () =>
        void onUpdate(meta.pageId, { enabled: !meta.enabled })
      )
    );
    actionsBox.appendChild(
      rowButton(meta.hidden ? "Unhide" : "Hide", () =>
        void onUpdate(meta.pageId, { hidden: !meta.hidden })
      )
    );
    const up = rowButton("↑", () => void onMove(pages, i, -1));
    up.disabled = i === 0;
    const down = rowButton("↓", () => void onMove(pages, i, 1));
    down.disabled = i === pages.length - 1;
    actionsBox.appendChild(up);
    actionsBox.appendChild(down);
    actionsBox.appendChild(rowButton("Delete", () => void onDelete(meta)));

    actionsCell.appendChild(actionsBox);
    actionsRow.appendChild(actionsCell);
    body.appendChild(actionsRow);
  });

  return table;
}

/** Creates a small action button bound to a handler. */
function rowButton(label: string, handler: () => void): HTMLButtonElement {
  const button = el("button", undefined, label);
  button.addEventListener("click", handler);
  return button;
}

/** Sort key: explicit order first, then name (stable, predictable listing). */
function byOrderThenName(a: PageMetadata, b: PageMetadata): number {
  return (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name);
}

/** Compact status label derived from the metadata flags. */
function statusText(meta: PageMetadata): string {
  const parts: string[] = [];
  parts.push(meta.enabled ? "enabled" : "disabled");
  if (meta.hidden) {
    parts.push("hidden");
  }
  if (!meta.sizeBytes) {
    parts.push("empty");
  }
  return parts.join(", ");
}

/** Returns a slug validation message for a non-empty invalid slug, else an empty string. */
function slugError(): string {
  // Reserved slugs include trashed pages, so a new page cannot reuse a trashed URL.
  const existing = [
    ...(index.pages || []).map((page) => page.slug),
    ...(index.trash || []).map((entry) => entry.page.slug)
  ];
  // Editing allows the page's own slug to remain; creating requires a unique slug.
  return validateSlug(formSlug, existing, editingPageId != null);
}

/** True when the form may be submitted. */
function formValid(): boolean {
  return formName.trim().length > 0 && formSlug.trim().length > 0 && !slugError();
}

/** Primary action: create a page, or save edits to the page being edited. */
async function onPrimary(): Promise<void> {
  if (!formValid()) {
    return;
  }
  try {
    if (editingPageId) {
      // Slug is intentionally not sent: it must not change on an existing page.
      index = await updatePage(editingPageId, {
        name: formName.trim(),
        comment: formComment.trim()
      });
    } else {
      index = await addPage(formName.trim(), formSlug.trim(), formComment.trim());
    }
    resetForm();
  } catch (error) {
    fail(editingPageId ? "Unable to save the page." : "Unable to add the page.", error);
  }
}

/** Secondary action: clear the form (add mode) or cancel editing (edit mode). */
function onSecondary(): void {
  resetForm();
}

/** Resets the form to "add" mode and clears the fields. */
function resetForm(): void {
  editingPageId = null;
  formName = "";
  formSlug = "";
  formComment = "";
  errorText = "";
  render();
}

/** Switches the shared form into edit mode for a page (slug locked). */
function onEdit(meta: PageMetadata): void {
  editingPageId = meta.pageId;
  formName = meta.name;
  formSlug = meta.slug;
  formComment = meta.comment || "";
  errorText = "";
  render();
}

/** Applies a metadata patch and re-renders. */
async function onUpdate(pageId: string, patch: Partial<PageMetadata>): Promise<void> {
  try {
    index = await updatePage(pageId, patch);
    errorText = "";
    render();
  } catch (error) {
    fail("Unable to update the page.", error);
  }
}

/** Clears a page's content (page and metadata remain). */
async function onClear(meta: PageMetadata): Promise<void> {
  if (!(await confirmDialog(`Clear the content of "${meta.name}"? This cannot be undone.`))) {
    return;
  }
  try {
    index = await clearPage(meta.pageId);
    errorText = "";
    render();
  } catch (error) {
    fail("Unable to clear the page.", error);
  }
}

/** Moves a page to the trash. */
async function onDelete(meta: PageMetadata): Promise<void> {
  if (
    !(await confirmDialog(
      `Move "${meta.name}" to the trash? It can be restored, and is permanently deleted after 5 days.`
    ))
  ) {
    return;
  }
  try {
    index = await removePage(meta.pageId);
    errorText = "";
    render();
  } catch (error) {
    fail("Unable to move the page to the trash.", error);
  }
}

/** Restores a trashed page. */
async function onRestore(trashId: string): Promise<void> {
  try {
    index = await restorePage(trashId);
    errorText = "";
    render();
  } catch (error) {
    fail("Unable to restore the page.", error);
  }
}

/** Permanently deletes a trashed page and its content. */
async function onPurge(entry: TrashEntry): Promise<void> {
  if (!(await confirmDialog(`Permanently delete "${entry.page.name}"? This cannot be undone.`))) {
    return;
  }
  try {
    index = await purgeTrashEntry(entry.trashId);
    errorText = "";
    render();
  } catch (error) {
    fail("Unable to delete the page.", error);
  }
}

/** Builds the trash table with restore and delete-instantly actions. */
function buildTrashTable(): HTMLElement {
  const table = el("table", "data-table");
  const head = el("thead");
  const headRow = el("tr");
  ["Name", "Slug", "Deleted", "Permanent delete by"].forEach((label) =>
    headRow.appendChild(el("th", undefined, label))
  );
  head.appendChild(headRow);
  table.appendChild(head);

  const body = el("tbody");
  table.appendChild(body);

  const trash = (index.trash || [])
    .slice()
    .sort((a, b) => b.deletedUtc.localeCompare(a.deletedUtc));
  if (trash.length === 0) {
    const row = el("tr");
    const cell = el("td", "empty", "Trash is empty.");
    cell.colSpan = 4;
    row.appendChild(cell);
    body.appendChild(row);
    return table;
  }

  trash.forEach((entry) => {
    const row = el("tr", "data-row");
    row.appendChild(el("td", undefined, entry.page.name));
    row.appendChild(el("td", "mono", entry.page.slug));
    row.appendChild(
      el("td", undefined, entry.deletedUtc + (entry.deletedBy ? ` (${entry.deletedBy})` : ""))
    );
    row.appendChild(el("td", "col-nowrap", trashExpiryUtc(entry.deletedUtc) || "-"));
    body.appendChild(row);

    // Restore / Delete instantly on their own row, left-aligned (see the pages table).
    const actionsRow = el("tr", "actions-row");
    const actionsCell = el("td");
    actionsCell.colSpan = 4;
    const box = el("div", "row-actions");
    box.appendChild(rowButton("Restore", () => void onRestore(entry.trashId)));
    box.appendChild(rowButton("Delete instantly", () => void onPurge(entry)));
    actionsCell.appendChild(box);
    actionsRow.appendChild(actionsCell);
    body.appendChild(actionsRow);
  });

  return table;
}

/** Swaps the order of a page with its neighbour in the given direction (-1 up, +1 down). */
async function onMove(pages: PageMetadata[], at: number, direction: number): Promise<void> {
  const other = pages[at + direction];
  const current = pages[at];
  if (!other || !current) {
    return;
  }
  try {
    // Swap the two neighbours' order values; enough for a single-step move.
    const orderCurrent = current.order;
    const orderOther = other.order;
    index = await updatePage(current.pageId, { order: orderOther });
    index = await updatePage(other.pageId, { order: orderCurrent });
    errorText = "";
    render();
  } catch (error) {
    fail("Unable to reorder.", error);
  }
}

// ---- Links admin ----------------------------------------------------------------------------

/** Organization name from the SDK (for URL validation). */
function organizationName(): string {
  const host = SDK.getHost();
  return host ? host.name : "";
}

/** Current project name from the SDK (for URL validation). */
function projectName(): string {
  const web = SDK.getWebContext();
  return web && web.project ? web.project.name : "";
}

/** Current project id (GUID) from the SDK; several ADO URLs use it instead of the name. */
function projectId(): string {
  const web = SDK.getWebContext();
  return web && web.project ? web.project.id : "";
}

/** Builds the add/edit form for links (Title, Slug, URL, Comment). */
function buildLinkForm(): HTMLElement {
  const form = el("div", "form");
  const titleField = textField("Title", formLinkTitle, true, (value) => {
    formLinkTitle = value;
  });
  const slugField = textField("Slug", formLinkSlug, true, (value) => {
    formLinkSlug = value;
  });
  const urlField = textField("URL (optional)", formLinkUrl, true, (value) => {
    formLinkUrl = value;
  });
  const commentField = textField("Comment", formLinkComment, true, (value) => {
    formLinkComment = value;
  });
  // Slug is immutable when editing so existing bookmarks never break.
  slugField.input.disabled = editingLinkId != null;

  form.appendChild(titleField.row);
  form.appendChild(slugField.row);
  form.appendChild(commentField.row);
  form.appendChild(urlField.row);

  // Cascading builder: Area -> ... until a valid URL exists (several levels may be valid).
  const builder = el("div", "builder");
  builder.appendChild(
    el(
      "p",
      "hint",
      "Build the link below. A link is valid as soon as an option is marked [valid]; several may be valid at once."
    )
  );
  builderContainer = builder;
  linkUrlInput = urlField.input;
  form.appendChild(builder);
  renderBuilder();

  const hint = el("p", "hint");
  form.appendChild(hint);

  const buttons = el("div", "form-buttons");
  const primary = el("button", "primary", editingLinkId ? "Save changes" : "Add link");
  const secondary = el("button", undefined, editingLinkId ? "Cancel" : "Clear");
  buttons.appendChild(primary);
  buttons.appendChild(secondary);
  form.appendChild(buttons);

  // Live validation: title/slug, a valid URL, and a resolvable dynamic part.
  const refresh = () => {
    const slugProblem = linkSlugError();
    const urlProblem = linkUrlError();
    const dynamicProblem = linkDynamicError();
    const error = slugProblem || urlProblem || dynamicProblem;
    hint.textContent =
      error ||
      "Add link clears only the slug, so you can build several links from the same selections; use Clear to start over.";
    hint.classList.toggle("error", Boolean(error));
    slugField.input.classList.toggle("invalid", Boolean(slugProblem));
    urlField.input.classList.toggle("invalid", Boolean(urlProblem));
    primary.disabled =
      formLinkTitle.trim().length === 0 || formLinkSlug.trim().length === 0 || Boolean(error);
  };

  titleField.input.addEventListener("input", refresh);
  slugField.input.addEventListener("input", refresh);
  urlField.input.addEventListener("input", () => {
    // A manually typed URL overrides any builder result.
    formLinkUrl = urlField.input.value;
    // Keep the dynamic spec while any placeholder is present (dynamic OR log tokens).
    if (!hasAnyToken(formLinkUrl)) {
      formLinkDynamicSpec = undefined;
    }
    // A hand edit invalidates the last parse, so the next change re-parses.
    lastParsedUrl = "";
    refresh();
  });
  // Pasted URLs are parsed and pre-select matching builder options.
  urlField.input.addEventListener("change", () => applyPastedUrl());
  urlField.input.addEventListener("paste", () => window.setTimeout(() => applyPastedUrl(), 0));
  commentField.input.addEventListener("input", refresh);
  linkFormRefresh = refresh;
  refresh();

  primary.addEventListener("click", () => void onPrimaryLink());
  secondary.addEventListener("click", () => resetLinkForm());
  return form;
}

/** Base URL for a link (the org/project prefix is fixed and never shown to the admin). */
function linkBase(): string {
  return `https://dev.azure.com/${organizationName()}/${encodeURIComponent(projectName())}`;
}

/** The hub URL that opens a published page in the viewer (the View action opens it in a new tab). */
function pageViewUrl(slug: string): string {
  return withQueryParam(pagesHubUrl(HUB_PAGES), "page", slug);
}

/** The hub URL that opens a link's target (the hub resolves dynamic/fixed links, then navigates). */
function linkViewUrl(slug: string): string {
  return withQueryParam(pagesHubUrl(HUB_LINKS), "page", slug);
}

/** Opens a URL in a new browser tab (used by the View actions). */
function openInNewTab(url: string): void {
  window.open(url, "_blank", "noopener");
}

/** Path key for the parent of a level (used for the builder cache/memory). */
function builderParentKey(level: number): string {
  return builderChosen
    .slice(0, level)
    .map((option) => option.key)
    .join(">");
}

/** Path key including the option at a level (the parent key for the next level). */
function builderPathKey(level: number): string {
  return builderChosen
    .slice(0, level + 1)
    .map((option) => option.key)
    .join(">");
}

/** Renders the builder's level selects (with a filter for long option lists). */
function renderBuilder(): void {
  if (!builderContainer) {
    return;
  }
  builderContainer.innerHTML = "";
  if (builderError) {
    // Informational notes ("Detected a pipeline link", "stored as fixed") are not errors, so they
    // use the neutral hint style; the form's own validation shows the red hint below the form.
    builderContainer.appendChild(el("p", "hint builder-note", builderError));
  }
  for (let level = 0; level < builderLevels.length; level += 1) {
    const options = builderLevels[level];
    if (!options || options.length === 0) {
      break;
    }
    const row = el("div", "form-row");
    row.appendChild(el("span", "form-label", level === 0 ? "Area" : `Level ${level + 1}`));
    const placeholder = level === 0 ? "(choose an area)" : "(choose)";
    const select = document.createElement("select");
    // Fills the select from the (optionally filtered) option list, keeping the current choice.
    const fill = (needle: string) => {
      const wanted = needle.trim().toLowerCase();
      select.innerHTML = "";
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = placeholder;
      select.appendChild(blank);
      options
        .filter((option) => !wanted || option.label.toLowerCase().indexOf(wanted) >= 0)
        .forEach((option) => {
          const choice = document.createElement("option");
          choice.value = option.key;
          choice.textContent = option.terminal ? `${option.label}  [valid]` : option.label;
          select.appendChild(choice);
        });
      select.value = builderSelected[level] || "";
    };
    fill("");
    select.addEventListener("change", () => void onBuilderChange(level, select.value));
    row.appendChild(select);
    // A filter keeps a long list (e.g. 200 log targets) usable.
    if (options.length > 12) {
      const filterInput = document.createElement("input");
      filterInput.type = "text";
      filterInput.className = "level-filter";
      filterInput.placeholder = `Filter ${options.length} options...`;
      filterInput.addEventListener("input", () => fill(filterInput.value));
      row.appendChild(filterInput);
    }
    builderContainer.appendChild(row);
    if (!builderSelected[level]) {
      break;
    }
  }
}

/** Handles a builder selection: truncate deeper levels, load children, restore memory. */
async function onBuilderChange(level: number, key: string): Promise<void> {
  builderError = "";
  if (!key) {
    builderSelected = builderSelected.slice(0, level);
    builderChosen = builderChosen.slice(0, level);
    builderLevels = builderLevels.slice(0, level + 1);
    builderLevelMemory.length = level;
    applyBuilder();
    return;
  }
  const option = (builderLevels[level] || []).find((candidate) => candidate.key === key);
  if (!option) {
    return;
  }
  const parent = builderParentKey(level);
  builderSelected = builderSelected.slice(0, level);
  builderChosen = builderChosen.slice(0, level);
  builderLevels = builderLevels.slice(0, level + 1);

  builderSelected[level] = key;
  builderChosen[level] = option;
  builderMemory.set(parent, key);
  builderLevelMemory[level] = key;
  // Track the last chosen log target (by name); a plain view choice clears it.
  if (option.names) {
    builderLastLogTarget = option;
  } else if (option.key.indexOf("view:") === 0) {
    builderLastLogTarget = null;
  }

  if (!option.loadChildren) {
    applyBuilder();
    return;
  }
  const childPath = builderPathKey(level);
  let children = builderCache.get(childPath);
  if (!children) {
    try {
      children = await option.loadChildren();
      builderCache.set(childPath, children);
    } catch (error) {
      // A load failure (e.g. a missing permission) must not lose the form; show it in the box.
      children = [];
      builderError = error instanceof Error ? error.message : String(error);
      builderLevels[level + 1] = children;
      applyBuilder();
      return;
    }
  }
  // A dynamic build has no per-build log ids; its targets are name-based, so carry the last log
  // target forward unchanged (it resolves against whatever build is current when opened).
  const lastLog = builderLastLogTarget;
  if (isDynamicBuildMode(option) && lastLog && !children.some((child) => child.key === lastLog.key)) {
    children = [lastLog, ...children];
  }
  builderLevels[level + 1] = children;
  applyBuilder();
  // Restore a previously chosen child at this level, if any (so you can go back to a branch).
  const remembered = builderMemory.get(childPath);
  if (remembered && children.some((child) => child.key === remembered)) {
    await onBuilderChange(level + 1, remembered);
    return;
  }
  // No exact path memory: fall back to the soft per-level memory so changing an earlier level
  // keeps the closest target by name (e.g. the same log target on another build).
  const soft = builderLevelMemory[level + 1];
  if (soft && children.some((child) => child.key === soft)) {
    await onBuilderChange(level + 1, soft);
    return;
  }
  // A dynamic build's log target is offered by name; re-select it so the location is kept.
  if (isDynamicBuildMode(option) && lastLog) {
    const placeholder = children.find((child) => child.key === lastLog.key);
    if (placeholder) {
      await onBuilderChange(level + 1, placeholder.key);
      return;
    }
  }
  renderBuilder();
}

/** True when an option is a dynamic (latest/...) build mode (its children are named targets). */
function isDynamicBuildMode(option: BuilderOption): boolean {
  return Boolean(option.dynamic && option.dynamic.kind === "build" && option.key !== "mode:fixed");
}

/** Applies the builder path to the URL field and the dynamic spec. */
function applyBuilder(): void {
  if (builderChosen.length > 0 && !isFixedArea(builderChosen)) {
    const result = composePath(linkBase(), builderChosen);
    formLinkUrl = normalizeTokens(result.url);
    formLinkDynamicSpec = result.dynamic;
    if (linkUrlInput) {
      linkUrlInput.value = formLinkUrl;
    }
  } else if (isFixedArea(builderChosen)) {
    // A fixed link's URL is typed by the admin; the builder contributes nothing.
    formLinkDynamicSpec = undefined;
    if (linkUrlInput) {
      formLinkUrl = linkUrlInput.value;
    }
  }
  renderBuilder();
  if (linkFormRefresh) {
    linkFormRefresh();
  }
}

/**
 * Handles a pasted in-project URL: pre-selects the matching builder options and either keeps a
 * concrete target fixed or restores the dynamic spec when the URL already contains the token.
 */
function applyPastedUrl(): void {
  const url = formLinkUrl.trim();
  if (!url) {
    return;
  }
  // Skip re-parsing the same value: a paste fires both paste and change, and a second parse would
  // visibly re-expand the builder levels.
  if (url === lastParsedUrl) {
    return;
  }
  lastParsedUrl = url;
  // Claim the newest generation; an older, slower run will see itself as stale and stop.
  const generation = ++pasteGeneration;
  const info = describeProjectUrl(url, organizationName(), projectName(), projectId());
  if (!info.ok) {
    // Not a valid in-project URL: store it as a fixed link when it is an absolute http(s) URL.
    if (isHttpUrl(url)) {
      applyFixedArea("Not an in-project URL; stored as a fixed link.", generation);
    }
    return; // Otherwise linkUrlError shows the reason.
  }
  if (info.area === "repository" && info.repositoryName) {
    formLinkDynamicSpec = undefined;
    void autoSelectRepo(info.repositoryName, url, info, generation);
  } else if (info.area === "build") {
    formLinkDynamicSpec = undefined;
    void autoSelectBuild(info, url, generation);
  } else {
    // An in-project URL we do not model (settings, dashboards, wiki, ...): store it as Fixed.
    applyFixedArea("Stored as a fixed in-project link.", generation);
  }
}

/** Resets the builder and selects the Fixed area, keeping the typed URL (unmodelled/out-of-project). */
function applyFixedArea(message: string, generation: number): void {
  formLinkDynamicSpec = undefined;
  builderChosen = [];
  builderSelected = [];
  builderLevels = [rootOptions()];
  builderCache.clear();
  builderMemory.clear();
  builderLevelMemory.length = 0;
  builderLastLogTarget = null;
  void onBuilderChange(0, "area:fixed").then(() => {
    if (isStalePaste(generation)) {
      return;
    }
    builderError = message;
    renderBuilder();
    if (linkFormRefresh) {
      linkFormRefresh();
    }
  });
}

/** True when a paste run has been superseded by a newer one (its mutations must be dropped). */
function isStalePaste(generation: number): boolean {
  return generation !== pasteGeneration;
}

/** Pre-selects the pipeline -> build -> view -> stage/job/task chain from a pasted URL. */
async function autoSelectBuild(
  info: {
    buildId?: string;
    view?: string;
    stageId?: string;
    jobId?: string;
    taskId?: string;
    artifactPath?: string;
    params: Array<[string, string]>;
  },
  pastedUrl: string,
  generation: number
): Promise<void> {
  builderError = "";
  const tokenized = hasToken(pastedUrl);
  const fixedId = !tokenized && info.buildId ? info.buildId : undefined;
  const buildInfo = fixedId ? await getBuildInfo(fixedId) : null;
  if (isStalePaste(generation)) {
    return;
  }
  const definitionId = buildInfo ? buildInfo.definitionId : 0;

  builderChosen = [];
  builderSelected = [];
  builderLevels = [rootOptions()];
  builderCache.clear();
  builderMemory.clear(); builderLevelMemory.length = 0; builderLastLogTarget = null;

  // Level 0: Area = Pipeline.
  await onBuilderChange(0, "area:build");
  if (isStalePaste(generation)) {
    return;
  }

  // Level 1: the pipeline (by definition id).
  if (definitionId) {
    const pipe = (builderLevels[1] || []).find((candidate) => candidate.key === "pipe:" + definitionId);
    if (pipe) {
      await onBuilderChange(1, pipe.key);
      if (isStalePaste(generation)) {
        return;
      }
    }
  }

  // Level 2: build mode (Fixed when we have a concrete build id, else Latest).
  const modeKey = fixedId ? "mode:fixed" : "mode:latest";
  const mode = (builderLevels[2] || []).find((candidate) => candidate.key === modeKey);
  if (mode) {
    await onBuilderChange(2, mode.key);
    if (isStalePaste(generation)) {
      return;
    }
  }

  // Level 3: build number (fixed only); an unknown id is added as "(invalid)".
  if (fixedId) {
    const level = builderChosen.length;
    let buildOption = (builderLevels[level] || []).find((candidate) => candidate.key === "build:" + fixedId);
    if (!buildOption) {
      buildOption = {
        key: "build:" + fixedId,
        label: `Build ${fixedId} (invalid)`,
        url: "/_build/results?buildId=" + fixedId,
        terminal: true,
        loadChildren: async () => buildTargets(Number(fixedId))
      };
      builderLevels[level] = [buildOption, ...(builderLevels[level] || [])];
      builderCache.set(builderPathKey(level - 1), builderLevels[level]);
    }
    await onBuilderChange(level, buildOption.key);
    if (isStalePaste(generation)) {
      return;
    }
  }

  // Target level: match by NAME. Log targets are stored by name, so the pasted ids are resolved to
  // names against the pasted build and matched; anything the target does not consume stays as a
  // fixed level, so the stored URL never truncates the pasted URL.
  const consumed = new Set<string>();
  if (info.view) {
    const level = builderChosen.length;
    const names = await resolvePastedNames(fixedId, info);
    if (isStalePaste(generation)) {
      return;
    }
    let match = (builderLevels[level] || []).find((candidate) =>
      targetMatches(candidate, info.view || "", names)
    );
    if (!match && info.view === "logs" && (names.stage || names.job || names.task)) {
      // No listed target matched (e.g. duplicate names): synthesize a token-based log target so the
      // location still survives later changes.
      match = syntheticLogTarget(names);
      builderLevels[level] = [match, ...(builderLevels[level] || [])];
    }
    if (match) {
      await onBuilderChange(level, match.key);
      if (isStalePaste(generation)) {
        return;
      }
      consumedParams(match.url).forEach((name) => consumed.add(name));
    } else {
      // An unknown/custom view: keep it (and its parameters) as fixed levels.
      appendParamLevel("view", info.view);
      consumed.add("view");
    }
  }

  // Every parameter the target did not consume becomes a fixed level (never truncate).
  for (const [key, value] of info.params || []) {
    if (key === "buildId" || consumed.has(key)) {
      continue;
    }
    appendParamLevel(key, value);
  }

  applyBuilder();
  builderError = "Detected a pipeline link; adjust any level below.";
  renderBuilder();
  if (linkFormRefresh) {
    linkFormRefresh();
  }
}

/** Appends a synthetic fixed level for a query parameter (never truncates the URL). */
function appendParamLevel(key: string, value: string, names?: Map<string, string>): void {
  const option = paramOption(key, value, names || new Map<string, string>());
  const level = builderChosen.length;
  builderChosen[level] = option;
  builderSelected[level] = option.key;
  builderLevels[level] = [option];
}

/** Resolves the pasted s/j/t ids to their names using the pasted build's timeline. */
async function resolvePastedNames(
  buildId: string | undefined,
  info: { stageId?: string; jobId?: string; taskId?: string }
): Promise<{ stage?: string; job?: string; task?: string }> {
  const names: { stage?: string; job?: string; task?: string } = {};
  if (!buildId || (!info.stageId && !info.jobId && !info.taskId)) {
    return names;
  }
  try {
    const records = await getBuildTimeline(buildId);
    const byId = new Map(records.map((record) => [record.id, record]));
    const stage = info.stageId ? byId.get(info.stageId) : undefined;
    const job = info.jobId ? byId.get(info.jobId) : undefined;
    const task = info.taskId ? byId.get(info.taskId) : undefined;
    names.stage = stage && stage.name;
    names.job = job && job.name;
    names.task = task && task.name;
  } catch (error) {
    // Without the timeline we match a plain view and keep the raw ids as fixed params.
  }
  return names;
}

/** A token-based log target for a pasted logs URL that had no listed match. */
function syntheticLogTarget(names: { stage?: string; job?: string; task?: string }): BuilderOption {
  const label = [names.stage, names.job, names.task].filter(Boolean).join(" / ");
  return {
    key: "target:logs:" + label,
    label: "Logs: " + label,
    url:
      "&view=logs" +
      (names.stage ? "&s=" + LOG_STAGE_TOKEN : "") +
      (names.job ? "&j=" + LOG_JOB_TOKEN : "") +
      (names.task ? "&t=" + LOG_TASK_TOKEN : ""),
    terminal: true,
    names,
    dynamic: { kind: "build", logTarget: { view: "logs", ...names } }
  };
}

/** A builder option that reproduces one query parameter exactly. */
function paramOption(key: string, value: string, names: Map<string, string>): BuilderOption {
  return {
    key: `param:${key}:${value}`,
    label: paramLabel(key, value, names),
    url: `&${key}=${encodeURIComponent(value)}`,
    terminal: true
  };
}

/** A human label for a query parameter (names a stage/job/task when known). */
function paramLabel(key: string, value: string, names: Map<string, string>): string {
  switch (key) {
    case "view":
      return "View: " + viewLabel(value);
    case "s":
      return "Stage: " + (names.get(value) || `fixed (${value})`);
    case "j":
      return "Job: " + (names.get(value) || `fixed (${value})`);
    case "t":
      return "Task: " + (names.get(value) || `fixed (${value})`);
    case "path":
      return "Path: " + value;
    case "type":
      return "Artifacts type: " + value;
    default:
      return `${key}: ${value}`;
  }
}

/** A friendly name for a build view. */
function viewLabel(view: string): string {
  switch (view) {
    case "results":
      return "Results (summary)";
    case "codecoverage-tab":
      return "Code coverage";
    case "artifacts":
      return "Artifacts";
    case "logs":
      return "Logs";
    default:
      return view || "(default)";
  }
}

/** Maps a build "view" query value to a builder view option key. */
function viewOptionKey(view?: string): string {
  switch (view) {
    case "results":
      return "view:results";
    case "codecoverage-tab":
      return "view:coverage";
    case "artifacts":
      return "view:artifacts";
    case "logs":
      return "view:logs";
    default:
      return "";
  }
}

/** Pre-selects Area = Repository and the repository; restores the dynamic leaf for a token URL. */
async function autoSelectRepo(
  name: string,
  pastedUrl: string,
  info: { commit?: string; prId?: string },
  generation: number
): Promise<void> {
  builderError = "";
  await onBuilderChange(0, "area:repo");
  if (isStalePaste(generation)) {
    return;
  }
  const repos = builderCache.get("area:repo") || [];
  const repo = repos.find((candidate) => candidate.label.toLowerCase() === name.toLowerCase());
  if (!repo) {
    formLinkUrl = pastedUrl;
    if (linkUrlInput) {
      linkUrlInput.value = formLinkUrl;
    }
    builderError = `Repository '${name}' was not found in this project.`;
    renderBuilder();
    if (linkFormRefresh) {
      linkFormRefresh();
    }
    return;
  }
  await onBuilderChange(1, repo.key);
  if (isStalePaste(generation)) {
    return;
  }

  if (hasToken(pastedUrl)) {
    // Restore the dynamic leaf: a commit token -> latest commit; a PR token -> newest open PR.
    const children = builderLevels[2] || [];
    const leafKey = info.commit ? "commit:default" : "pr:newest-open";
    const leaf = children.find((candidate) => candidate.key === leafKey);
    if (leaf) {
      await onBuilderChange(2, leaf.key);
    }
    builderError = "Detected a repository link; restored the dynamic target.";
  } else {
    // A concrete target: keep the pasted URL exactly (fixed).
    formLinkUrl = pastedUrl;
    formLinkDynamicSpec = undefined;
    if (linkUrlInput) {
      linkUrlInput.value = formLinkUrl;
    }
    builderError = "";
  }
  if (isStalePaste(generation)) {
    return;
  }
  renderBuilder();
  if (linkFormRefresh) {
    linkFormRefresh();
  }
}

/** URL validation: required, and either a tokenized builder URL or a valid in-project URL. */
function linkUrlError(): string {
  const url = formLinkUrl.trim();
  // A fixed link is any absolute http(s) URL (it need not be in-project).
  if (isFixedArea(builderChosen)) {
    return fixedUrlError(url);
  }
  if (!url) {
    return "Choose options (or paste a URL) to build a link.";
  }
  if (hasToken(url)) {
    const base = linkBase();
    return url.startsWith(base + "/") ? "" : `The link must be inside this project (${base}).`;
  }
  const check = checkProjectUrl(url, organizationName(), projectName(), projectId());
  return check.ok ? "" : check.error || "Invalid URL.";
}

/** Dynamic validation: the chosen path must be valid and the token present. */
function linkDynamicError(): string {
  if (builderChosen.length > 0) {
    const result = composePath(linkBase(), builderChosen);
    if (!result.terminal) {
      return "Pick a valid link target (an option marked [valid]).";
    }
  }
  if (formLinkDynamicSpec && !hasAnyToken(formLinkUrl)) {
    return "The link is missing its placeholder ({{dyn}} or a log target).";
  }
  return "";
}

/** Slug validation for a link (unique across live and trashed links, reserved slugs blocked). */
function linkSlugError(): string {
  const existing = [
    ...(links.links || []).map((link) => link.slug),
    ...(links.trash || []).map((entry) => entry.link.slug)
  ];
  return validateSlug(formLinkSlug, existing, editingLinkId != null);
}

/** True when the link form may be submitted. */
function linkFormValid(): boolean {
  return (
    formLinkTitle.trim().length > 0 &&
    formLinkSlug.trim().length > 0 &&
    !linkSlugError() &&
    !linkUrlError() &&
    !linkDynamicError()
  );
}

/** Primary link action: create a link, or save edits (including the dynamic spec). */
async function onPrimaryLink(): Promise<void> {
  if (!linkFormValid()) {
    return;
  }
  const url = formLinkUrl.trim();
  const spec = formLinkDynamicSpec;
  // Remember a fixed (possibly out-of-project) link so the hub/settings can label it.
  const area = isFixedArea(builderChosen) ? "fixed" : undefined;
  try {
    if (editingLinkId) {
      links = await updateLink(editingLinkId, {
        title: formLinkTitle.trim(),
        url,
        comment: formLinkComment.trim(),
        dynamic: spec,
        area
      });
      resetLinkForm();
    } else {
      links = await addLink(
        formLinkTitle.trim(),
        formLinkSlug.trim(),
        url,
        formLinkComment.trim(),
        spec,
        area
      );
      // Keep the selections so several links can be built from the same path; only the slug is
      // cleared, and the user must press Clear to start over.
      editingLinkId = null;
      formLinkSlug = "";
      errorText = "";
      render();
    }
  } catch (error) {
    fail(editingLinkId ? "Unable to save the link." : "Unable to add the link.", error);
  }
}

/** Resets the link form to "add" mode (everything, including the builder). */
function resetLinkForm(): void {
  editingLinkId = null;
  formLinkTitle = "";
  formLinkSlug = "";
  formLinkUrl = "";
  formLinkComment = "";
  formLinkDynamicSpec = undefined;
  builderChosen = [];
  builderSelected = [];
  builderLevels = [rootOptions()];
  builderCache.clear();
  builderMemory.clear(); builderLevelMemory.length = 0; builderLastLogTarget = null;
  lastParsedUrl = "";
  errorText = "";
  render();
}

/** Switches the link form into edit mode (slug locked). */
function onEditLink(link: LinkEntry): void {
  editingLinkId = link.linkId;
  formLinkTitle = link.title;
  formLinkSlug = link.slug;
  formLinkUrl = link.url;
  formLinkComment = link.comment || "";
  formLinkDynamicSpec = link.dynamic;
  // The stored path cannot be reconstructed exactly; start the builder fresh (the URL is shown).
  builderChosen = [];
  builderSelected = [];
  builderLevels = [rootOptions()];
  builderCache.clear();
  builderMemory.clear(); builderLevelMemory.length = 0; builderLastLogTarget = null;
  // The stored URL is already shown; mark it parsed so a blur does not re-parse it.
  lastParsedUrl = link.url.trim();
  errorText = "";
  render();
  // Preselect the fixed area for a stored fixed (or out-of-project) link so the form validates.
  if (
    link.area === "fixed" ||
    (isHttpUrl(link.url) && !checkProjectUrl(link.url, organizationName(), projectName(), projectId()).ok)
  ) {
    void onBuilderChange(0, "area:fixed");
  }
}

/** Moves a link to the trash. */
async function onDeleteLink(link: LinkEntry): Promise<void> {
  if (
    !(await confirmDialog(
      `Move "${link.title}" to the trash? It can be restored, and is permanently deleted after 5 days.`
    ))
  ) {
    return;
  }
  try {
    links = await removeLink(link.linkId);
    errorText = "";
    render();
  } catch (error) {
    fail("Unable to move the link to the trash.", error);
  }
}

/** Restores a trashed link. */
async function onRestoreLink(trashId: string): Promise<void> {
  try {
    links = await restoreLink(trashId);
    errorText = "";
    render();
  } catch (error) {
    fail("Unable to restore the link.", error);
  }
}

/** Permanently deletes a trashed link. */
async function onPurgeLink(entry: LinkTrashEntry): Promise<void> {
  if (!(await confirmDialog(`Permanently delete "${entry.link.title}"? This cannot be undone.`))) {
    return;
  }
  try {
    links = await purgeLink(entry.trashId);
    errorText = "";
    render();
  } catch (error) {
    fail("Unable to delete the link.", error);
  }
}

/** Builds the links table with per-row actions on their own row. */
function buildLinkTable(): HTMLElement {
  const table = el("table", "data-table");
  const head = el("thead");
  const headRow = el("tr");
  ["Title", "Slug", "Area", "URL", "Comment"].forEach((label) =>
    headRow.appendChild(el("th", undefined, label))
  );
  head.appendChild(headRow);
  table.appendChild(head);

  const body = el("tbody");
  table.appendChild(body);

  const items = (links.links || []).slice().sort(byLinkOrderThenTitle);
  if (items.length === 0) {
    const row = el("tr");
    const cell = el("td", "empty", "No links yet.");
    cell.colSpan = 5;
    row.appendChild(cell);
    body.appendChild(row);
    return table;
  }

  items.forEach((link) => {
    const row = el("tr", "data-row");
    row.appendChild(el("td", undefined, link.title));
    row.appendChild(el("td", "mono", link.slug));
    row.appendChild(el("td", "col-nowrap", areaLabel(link)));
    row.appendChild(el("td", "url", link.url));
    row.appendChild(el("td", undefined, link.comment || ""));
    body.appendChild(row);

    const actionsRow = el("tr", "actions-row");
    const actionsCell = el("td");
    actionsCell.colSpan = 5;
    const box = el("div", "row-actions");
    box.appendChild(rowButton("View", () => openInNewTab(linkViewUrl(link.slug))));
    box.appendChild(rowButton("Edit", () => onEditLink(link)));
    box.appendChild(rowButton("Delete", () => void onDeleteLink(link)));
    actionsCell.appendChild(box);
    actionsRow.appendChild(actionsCell);
    body.appendChild(actionsRow);
  });

  return table;
}

/** Builds the links trash table with restore and delete-instantly actions. */
function buildLinkTrashTable(): HTMLElement {
  const table = el("table", "data-table");
  const head = el("thead");
  const headRow = el("tr");
  ["Title", "Slug", "Deleted", "Permanent delete by"].forEach((label) => headRow.appendChild(el("th", undefined, label)));
  head.appendChild(headRow);
  table.appendChild(head);

  const body = el("tbody");
  table.appendChild(body);

  const trash = (links.trash || [])
    .slice()
    .sort((a, b) => b.deletedUtc.localeCompare(a.deletedUtc));
  if (trash.length === 0) {
    const row = el("tr");
    const cell = el("td", "empty", "Links trash is empty.");
    cell.colSpan = 4;
    row.appendChild(cell);
    body.appendChild(row);
    return table;
  }

  trash.forEach((entry) => {
    const row = el("tr", "data-row");
    row.appendChild(el("td", undefined, entry.link.title));
    row.appendChild(el("td", "mono", entry.link.slug));
    row.appendChild(
      el("td", undefined, entry.deletedUtc + (entry.deletedBy ? ` (${entry.deletedBy})` : ""))
    );
    row.appendChild(el("td", "col-nowrap", trashExpiryUtc(entry.deletedUtc) || "-"));
    body.appendChild(row);

    const actionsRow = el("tr", "actions-row");
    const actionsCell = el("td");
    actionsCell.colSpan = 4;
    const box = el("div", "row-actions");
    box.appendChild(rowButton("Restore", () => void onRestoreLink(entry.trashId)));
    box.appendChild(rowButton("Delete instantly", () => void onPurgeLink(entry)));
    actionsCell.appendChild(box);
    actionsRow.appendChild(actionsCell);
    body.appendChild(actionsRow);
  });

  return table;
}

/** Short Area label for a link (Repo/PR/Pipeline/Artifact/Fixed). */
function areaLabel(link: LinkEntry): string {
  return linkAreaLabel(link.url, link.area);
}

/** Sort key for links: explicit order first, then title. */
function byLinkOrderThenTitle(a: LinkEntry, b: LinkEntry): number {
  return (a.order || 0) - (b.order || 0) || a.title.localeCompare(b.title);
}

/** Stores an error message (with detail) and re-renders so it is visible. */
function fail(message: string, error?: unknown): void {
  errorText = error ? `${message} ${describeError(error)}` : message;
  if (error) {
    logError(message, error);
  }
  render();
}
