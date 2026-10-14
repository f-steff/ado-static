import * as SDK from "azure-devops-extension-sdk";

import {
  ProjectInfo,
  ProjectStats,
  getProjectStats,
  listProjectDocuments,
  listProjects,
  writeProjectDocuments
} from "../common/data-service";
import {
  ExportBundle,
  ProjectBundle,
  backupFileName,
  buildBundle,
  decodeBundle,
  encodeBundle
} from "../common/backup";
import { buildAbout } from "../common/about";
import { formatBytesWhole } from "../common/format";
import { getHeading } from "../common/branding";
import { pagesOrgSettingsUrl, pagesProjectSettingsUrl, extensionVersion } from "../common/extension-urls";
import { filterByName } from "../common/filter";
import { getHostNavigation, HostNavigationService } from "../common/host-nav";
import { describeError, logError, logInfo } from "../common/log";

/**
 * Organization-settings admin for Pages.
 *
 * Rationale: Pages is always enabled (the enable/disable switch was removed), so this page is an
 * informational overview: how many pages each project has, their total size, and the most recent
 * update, with each project linking directly to its Pages settings page.
 */

let projects: ProjectInfo[] = [];
let filter = "";
// Active tab: overview | about.
let orgTab = "overview";
let nav: HostNavigationService | undefined;
// Known tabs; the active tab is mirrored into the host hash so Back/Forward work.
const ORG_TABS = ["overview", "backup", "about"];
const stats = new Map<string, ProjectStats>();

SDK.init({ applyTheme: true });
logInfo("Pages org admin initializing.");

// Safety net: fail explicitly rather than letting the host show its generic timeout.
let settled = false;
const guard = window.setTimeout(() => {
  if (!settled) {
    settled = true;
    SDK.notifyLoadFailed("Pages organization settings initialization timed out.");
  }
}, 20000);

SDK.ready()
  .then(async () => {
    try {
      // The navigation service backs both project links and the tab hash (Back/Forward).
      nav = await getHostNavigation();
      const initialTab = (await nav.getHash() || "").replace(/^#/, "");
      if (ORG_TABS.indexOf(initialTab) >= 0) {
        orgTab = initialTab;
      }
      nav.onHashChanged((value) => {
        const id = (value || "").replace(/^#/, "");
        if (ORG_TABS.indexOf(id) >= 0 && id !== orgTab) {
          orgTab = id;
          render();
        }
      });
      const projectList = await listProjects();
      projects = projectList;
      render();
      settled = true;
      window.clearTimeout(guard);
      SDK.notifyLoadSucceeded();
      // Load per-project statistics in the background so the page appears immediately.
      void loadStats();
      logInfo("Pages org admin ready.", { projects: projects.length });
    } catch (error) {
      settled = true;
      window.clearTimeout(guard);
      logError("Org admin initialization failed.", error);
      renderFatal(error);
      SDK.notifyLoadFailed(describeError(error));
    }
  })
  .catch((error) => {
    settled = true;
    window.clearTimeout(guard);
    logError("SDK ready failed.", error);
    SDK.notifyLoadFailed(describeError(error));
  });

/** Tiny element factory. */
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

/** Switches tab via a same-document hash navigation (instant, real history entry for Back). */
function navigateTab(id: string): void {
  if (nav) {
    try {
      nav.navigate(pagesOrgSettingsUrl() + "#" + id);
    } catch {
      // Fall through to an in-place switch.
    }
  }
  render();
}

/** Builds the page shell (tabs: Overview / About). */
function render(): void {  const root = document.getElementById("root");
  if (!root) {
    return;
  }
  root.innerHTML = "";

  const page = el("div", "page");
  page.appendChild(getHeading("h1", "Static"));
  page.appendChild(
    el("p", "subtitle", "Organization-wide view of Static usage across projects.")
  );

  // Tabbed interface: Overview (left); Backup and About grouped on the right.
  const tabs = el("div", "tabs");
  const tabDefs: Array<[string, string, boolean]> = [
    ["overview", "Overview", false],
    ["backup", "Backup", true],
    ["about", "About", false]
  ];
  tabDefs.forEach(([id, label, right]) => {
    const button = el("button", "tab" + (orgTab === id ? " active" : "") + (right ? " tab-right" : ""), label);
    button.addEventListener("click", () => {
      orgTab = id;
      navigateTab(id);
    });
    tabs.appendChild(button);
  });
  page.appendChild(tabs);

  const content = el("div", "tab-content");
  if (orgTab === "about") {
    content.appendChild(buildAbout());
  } else if (orgTab === "backup") {
    content.appendChild(buildBackupSection());
  } else {
    const toolbar = el("div", "toolbar");
    const filterInput = document.createElement("input");
    filterInput.type = "text";
    filterInput.placeholder = "Filter projects...";
    filterInput.value = filter;
    // Re-render only the table as the user types; keeps focus in the filter box.
    filterInput.addEventListener("input", () => {
      filter = filterInput.value;
      renderProjects();
    });
    toolbar.appendChild(filterInput);
    content.appendChild(toolbar);

    const listSection = el("div", "section");
    const table = el("table", "data-table org-table");
    const head = el("thead");
    const headRow = el("tr");
    // NOTE: the metric columns (Links, Pages, PRs, Repos) are intentionally in alphabetical order;
    // keep them sorted when new static groups are added. The empty last column absorbs the extra
    // width on wide screens so the numbers stay readable rather than being stretched apart.
    const columns: Array<[string, string]> = [
      ["Project", "col-project"],
      ["Links", "col-number"],
      ["Pages", "col-number"],
      ["Pipelines", "col-number"],
      ["PRs", "col-number"],
      ["Repos", "col-number"],
      ["", "col-spacer"]
    ];
    columns.forEach(([label, cls]) => headRow.appendChild(el("th", cls, label)));
    head.appendChild(headRow);
    table.appendChild(head);
    const body = el("tbody");
    body.id = "projects-body";
    table.appendChild(body);
    listSection.appendChild(table);
    content.appendChild(listSection);
  }
  page.appendChild(content);

  // Running version, centered at the bottom (matches the hub frames).
  page.appendChild(el("p", "version", `Static ${extensionVersion()}`));

  root.appendChild(page);
  if (orgTab === "overview") {
    renderProjects();
  }
}

/** Renders the project table filtered by a case-insensitive substring match on the name. */
function renderProjects(): void {
  const body = document.getElementById("projects-body");
  if (!body) {
    return;
  }
  body.innerHTML = "";

  const visible = filterByName(projects, filter).slice().sort((a, b) => a.name.localeCompare(b.name));
  if (visible.length === 0) {
    const row = el("tr");
    const cell = el("td", "empty", "No matching projects.");
    cell.colSpan = 7;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }

  visible.forEach((project) => {
    const row = el("tr");
    row.dataset.projectId = project.id;
    row.appendChild(projectLinkCell(project));
    row.appendChild(cellWithRole("links", "...", "col-number"));
    row.appendChild(cellWithRole("pages", "...", "col-number"));
    row.appendChild(cellWithRole("pipelines", "...", "col-number"));
    row.appendChild(cellWithRole("prs", "...", "col-number"));
    row.appendChild(cellWithRole("repos", "...", "col-number"));
    row.appendChild(el("td", "col-spacer"));
    body.appendChild(row);
    applyStatsToRow(project.id);
  });
}

/** Project name cell: a link to that project's Static settings page. */
function projectLinkCell(project: ProjectInfo): HTMLTableCellElement {
  const cell = el("td", "col-project");
  const anchor = el("a", undefined, project.name);
  anchor.href = pagesProjectSettingsUrl(project.name);
  anchor.addEventListener("click", (event) => {
    // Honour modified clicks (new tab/window) by letting the real href navigate.
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    void navTo(pagesProjectSettingsUrl(project.name));
  });
  cell.appendChild(anchor);
  return cell;
}

/** Navigates the host to a URL using the (already resolved) navigation service. */
async function navTo(url: string): Promise<void> {
  const nav = await getHostNavigation();
  nav.navigate(url);
}

/** Creates a table cell that can be updated later by role. */
function cellWithRole(role: string, text: string, className?: string): HTMLTableCellElement {
  const cell = el("td", className);
  cell.dataset.role = role;
  cell.textContent = text;
  return cell;
}

/** Applies cached statistics to a row's cells, if the row is present. */
function applyStatsToRow(projectId: string): void {
  const row = document.querySelector<HTMLTableRowElement>(`tr[data-project-id="${projectId}"]`);
  const value = stats.get(projectId);
  if (!row || !value) {
    return;
  }
  const pages = row.querySelector<HTMLElement>('[data-role="pages"]');
  const links = row.querySelector<HTMLElement>('[data-role="links"]');
  const pipelines = row.querySelector<HTMLElement>('[data-role="pipelines"]');
  const prs = row.querySelector<HTMLElement>('[data-role="prs"]');
  const repos = row.querySelector<HTMLElement>('[data-role="repos"]');
  if (pages) {
    pages.textContent = String(value.pages);
  }
  if (links) {
    links.textContent = String(value.links);
  }
  if (pipelines) {
    pipelines.textContent = String(value.pipelines);
  }
  if (prs) {
    prs.textContent = String(value.openPrs);
  }
  if (repos) {
    repos.textContent = String(value.repos);
  }
}

/** Loads per-project statistics with a small concurrency pool. */
async function loadStats(): Promise<void> {
  const queue = projects.slice();
  const worker = async () => {
    while (queue.length > 0) {
      const project = queue.shift();
      if (!project) {
        break;
      }
      stats.set(project.id, await getProjectStats(project.id));
      applyStatsToRow(project.id);
    }
  };
  await Promise.all(Array.from({ length: 8 }, () => worker()));
}

// Remembers the last export so a blocked download can be retried without rebuilding the archive.
let lastBackup: { fileName: string; bytes: Uint8Array } | undefined;

// Shown on the Backup tab: one pipeline that backs up by default and, when run with mode = restore,
// restores the newest backup of itself (so the same definition does both directions).
const PIPELINE_SNIPPET = [
  "parameters:",
  "  - name: mode",
  "    default: backup",
  "    values: [backup, restore]",
  "",
  "steps:",
  "  # Snapshot first, so every run (including a restore) leaves a fresh backup artifact.",
  "  - task: StaticAdmin@0",
  "    inputs:",
  "      mode: backup",
  "      backupPath: '$(Build.ArtifactStagingDirectory)/static-backup.zip'",
  "      artifactName: 'static-backup'",
  "",
  "  # Restore downloads the newest 'static-backup' artifact of this same pipeline.",
  "  - task: DownloadPipelineArtifact@2",
  "    condition: eq('${{ parameters.mode }}', 'restore')",
  "    inputs:",
  "      source: specific",
  "      project: '$(System.TeamProject)'",
  "      pipeline: '$(System.DefinitionId)'",
  "      runVersion: latest",
  "      artifactName: 'static-backup'",
  "      targetPath: '$(Pipeline.Workspace)/static-backup'",
  "",
  "  - task: StaticAdmin@0",
  "    condition: eq('${{ parameters.mode }}', 'restore')",
  "    inputs:",
  "      mode: restore",
  "      backupPath: '$(Pipeline.Workspace)/static-backup/static-backup.zip'",
  "      dryRun: false",
  ""
].join("\n");

/**
 * Backup tab: download every project's Static data as a ZIP, or restore one back.
 * Rationale: the two Marketplace editions keep separate data (it is scoped per extension id), so one
 * portable archive is how an organization is copied between them (for example to seed the dev
 * edition before a release) and doubles as a backup. Pages travel inside it in full, because their
 * content chunks are ordinary documents in each project's collection.
 */
function buildBackupSection(): HTMLElement {
  const section = el("div", "section");
  section.appendChild(el("h2", undefined, "Backup and restore"));
  section.appendChild(
    el(
      "p",
      "subtitle",
      "Download a ZIP of every project's Static data (pages, links, trash and settings), or restore " +
        "one. Restoring replaces the data of the projects the file contains."
    )
  );
  // Rationale: the release and development editions are separate extensions with separate data, so
  // switching between them is not a change of view - the other edition starts from an empty project.
  // Saying so here is the difference between a safe swap and an apparent loss of everything.
  section.appendChild(
    el(
      "p",
      "hint error",
      "The release (static) and development (static-dev) editions keep separate data: installing " +
        "one in place of the other starts from an empty project. Always Download a backup first, " +
        "then install the other edition, then Restore it here (or from a pipeline, see below)."
    )
  );

  const context = SDK.getExtensionContext();
  const host = SDK.getHost();
  const organization = host && host.name ? host.name : "";

  // ---- Download -------------------------------------------------------------------------------
  section.appendChild(el("h3", undefined, "Download a backup"));
  const exportStatus = el("p", "subtitle", "");
  const retryButton = el("button", undefined, "Save again");
  retryButton.hidden = true;
  retryButton.addEventListener("click", () => {
    if (lastBackup) {
      downloadBytes(lastBackup.fileName, lastBackup.bytes, "application/zip");
    }
  });

  const exportButton = el("button", "primary", "Download backup");
  exportButton.addEventListener("click", () => {
    void (async () => {
      exportButton.disabled = true;
      retryButton.hidden = true;
      exportStatus.textContent = "Reading projects...";
      try {
        const bundles: ProjectBundle[] = [];
        for (const project of projects) {
          exportStatus.textContent = `Reading ${project.name}...`;
          const documents = await listProjectDocuments(project.id);
          if (documents.length > 0) {
            bundles.push({ projectId: project.id, projectName: project.name, documents });
          }
        }
        const bundle = buildBundle(bundles, {
          publisher: (context && context.publisherId) || "",
          extension: (context && context.extensionId) || "",
          organization
        });
        const bytes = encodeBundle(bundle);
        const fileName = backupFileName(organization);
        lastBackup = { fileName, bytes };
        const saved = downloadBytes(fileName, bytes, "application/zip");
        // Keep a retry visible in case the sandbox blocked the download.
        retryButton.hidden = saved;
        exportStatus.textContent =
          `${bundles.length} project(s), ${formatBytesWhole(bytes.length)}.` +
          (saved ? "" : " The download was blocked; choose Save again.");
      } catch (error) {
        exportStatus.textContent = `Backup failed: ${describeError(error)}`;
      } finally {
        exportButton.disabled = false;
      }
    })();
  });

  const exportButtons = el("div", "form-buttons");
  exportButtons.appendChild(exportButton);
  exportButtons.appendChild(retryButton);
  section.appendChild(exportButtons);
  section.appendChild(exportStatus);

  // ---- Restore --------------------------------------------------------------------------------
  section.appendChild(el("h3", undefined, "Restore from a backup"));
  section.appendChild(
    el(
      "p",
      "subtitle",
      "Choose a ZIP produced by a backup, then choose Restore and confirm. The data of the projects " +
        "in the file is replaced."
    )
  );

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".zip,application/zip";
  fileInput.id = "static-backup-file";
  const fileLabel = el("label", "field-label", "Backup file (ZIP)");
  fileLabel.htmlFor = fileInput.id;
  const fileRow = el("div", "form-row");
  fileRow.appendChild(fileLabel);
  fileRow.appendChild(fileInput);

  // The status line carries the whole flow: the chosen file's summary, then the confirmation
  // question, then the result. Keeping the question in the line (instead of a dialog) is what makes
  // the three buttons below read as one visible sequence.
  const restoreStatus = el("p", "subtitle", "");

  const restoreButton = el("button", "primary", "Restore");
  const clearButton = el("button", undefined, "Clear");
  const confirmButton = el("button", "primary", "Confirm restore");

  const restoreButtons = el("div", "form-buttons");
  restoreButtons.appendChild(restoreButton);
  restoreButtons.appendChild(clearButton);
  restoreButtons.appendChild(confirmButton);
  section.appendChild(fileRow);
  section.appendChild(restoreStatus);
  section.appendChild(restoreButtons);

  // Flow state:
  //   idle    - nothing chosen: Restore and Clear are inactive, Confirm restore is hidden.
  //   error   - a file was chosen but is unusable: only Clear is active.
  //   armed   - a usable file is chosen: Restore and Clear are active, Confirm restore is hidden.
  //   confirm - Restore was pressed: Confirm restore appears; Clear still clears the selection.
  //   busy    - the restore is running: every button is inactive.
  let pendingRestore: ExportBundle | undefined;
  let confirmTargets: ProjectBundle[] = [];

  const applyState = (state: "idle" | "error" | "armed" | "confirm" | "busy") => {
    restoreButton.disabled = state !== "armed";
    clearButton.disabled = state === "idle" || state === "busy";
    // A plain button has no `display` rule, so `hidden` works without extra CSS.
    confirmButton.hidden = state !== "confirm" && state !== "busy";
    confirmButton.disabled = state === "busy";
  };

  /** Returns the section to its initial state (nothing chosen, nothing pending). */
  const resetRestore = () => {
    pendingRestore = undefined;
    confirmTargets = [];
    fileInput.value = "";
    restoreStatus.textContent = "";
    applyState("idle");
  };

  applyState("idle");
  clearButton.addEventListener("click", resetRestore);

  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    pendingRestore = undefined;
    confirmTargets = [];
    if (!file) {
      resetRestore();
      return;
    }
    applyState("idle");
    void (async () => {
      restoreStatus.textContent = `Reading ${file.name}...`;
      try {
        const parsed = await decodeBundle(new Uint8Array(await file.arrayBuffer()));
        if (!parsed.ok) {
          restoreStatus.textContent = parsed.error;
          applyState("error");
          return;
        }
        const known = new Set(projects.map((project) => project.id));
        const targets = parsed.bundle.projects.filter((project) => known.has(project.projectId));
        if (targets.length === 0) {
          restoreStatus.textContent = "None of the projects in this backup exist in this organization.";
          applyState("error");
          return;
        }
        pendingRestore = parsed.bundle;
        confirmTargets = targets;
        const documents = targets.reduce((sum, project) => sum + project.documents.length, 0);
        const from = parsed.bundle.source.organization ? ` from ${parsed.bundle.source.organization}` : "";
        restoreStatus.textContent =
          `${file.name}: ${targets.length} project(s), ${documents} document(s)${from}. ` +
          "Choose Restore to apply it.";
        applyState("armed");
      } catch (error) {
        restoreStatus.textContent = `Could not read that file: ${describeError(error)}`;
        applyState("error");
      }
    })();
  });

  restoreButton.addEventListener("click", () => {
    if (!pendingRestore || confirmTargets.length === 0) {
      return;
    }
    const documents = confirmTargets.reduce((sum, project) => sum + project.documents.length, 0);
    const from = pendingRestore.source.organization || "another organization";
    restoreStatus.textContent =
      `Replace the Static data of ${confirmTargets.length} project(s) (${documents} document(s)) ` +
      `with the backup from ${from}? Choose Confirm restore to proceed.`;
    applyState("confirm");
  });

  confirmButton.addEventListener("click", () => {
    void (async () => {
      const bundle = pendingRestore;
      const targets = confirmTargets;
      if (!bundle || targets.length === 0) {
        resetRestore();
        return;
      }
      const documents = targets.reduce((sum, project) => sum + project.documents.length, 0);
      const skipped = bundle.projects.length - targets.length;
      applyState("busy");
      try {
        for (const project of targets) {
          restoreStatus.textContent = `Restoring ${project.projectName || project.projectId}...`;
          await writeProjectDocuments(project.projectId, project.documents, true);
        }
        await loadStats();
        const result =
          `Restored ${targets.length} project(s), ${documents} document(s).` +
          (skipped > 0 ? ` Skipped ${skipped} project(s) that no longer exist.` : "");
        // Report after resetting, so the result survives in the status line.
        resetRestore();
        restoreStatus.textContent = result;
      } catch (error) {
        resetRestore();
        restoreStatus.textContent = `Restore failed: ${describeError(error)}`;
      }
    })();
  });

  section.appendChild(
    el(
      "p",
      "hint",
      "The backup contains only Static data (no tokens or secrets). Pages are included in full, " +
        "because their content is stored in the same collection."
    )
  );

  // ---- Pipeline -------------------------------------------------------------------------------
  section.appendChild(el("h3", undefined, "Automate it in a pipeline"));
  section.appendChild(
    el(
      "p",
      "subtitle",
      "One pipeline does both: run it with mode = backup (the default) to write the archive, or " +
        "mode = restore to put this pipeline's newest backup back. The tasks detect which edition " +
        "is installed, so the same pipeline works before and after a swap."
    )
  );
  const snippet = el("pre", "code");
  snippet.textContent = PIPELINE_SNIPPET;
  section.appendChild(snippet);
  section.appendChild(
    el("p", "hint", "Full input list and more examples: docs/06-pipeline-integration.md.")
  );
  return section;
}
/** Triggers a client-side download; returns false when the browser blocked it. */
function downloadBytes(fileName: string, bytes: Uint8Array, type: string): boolean {
  try {
    const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    return true;
  } catch (error) {
    logInfo("the backup download was blocked.", error);
    return false;
  }
}

/** Renders a fatal error in place of the UI. */
function renderFatal(error: unknown): void {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }
  root.innerHTML = "";
  root.appendChild(el("div", "page error", "Error: " + describeError(error)));
}
