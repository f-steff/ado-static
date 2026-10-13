import * as SDK from "azure-devops-extension-sdk";

import {
  ProjectInfo,
  ProjectStats,
  getProjectStats,
  listProjects
} from "../common/data-service";
import { buildAbout } from "../common/about";
import { getHeading } from "../common/branding";
import { pagesOrgSettingsUrl, pagesProjectSettingsUrl, extensionVersion } from "../common/extension-urls";
import { filterByName } from "../common/filter";
import { getHostNavigation, HostNavigationService } from "../common/host-nav";
import { withQueryParam } from "../common/urls";
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
const ORG_TABS = ["overview", "about"];
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
    } catch (error) {
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

  // Tabbed interface: Overview (left) and About (right) - the same layout as the project settings.
  const tabs = el("div", "tabs");
  const overviewTab = el("button", "tab" + (orgTab === "overview" ? " active" : ""), "Overview");
  overviewTab.addEventListener("click", () => {
    orgTab = "overview";
    navigateTab("overview");
  });
  tabs.appendChild(overviewTab);
  const aboutTab = el("button", "tab tab-right" + (orgTab === "about" ? " active" : ""), "About");
  aboutTab.addEventListener("click", () => {
    orgTab = "about";
    navigateTab("about");
  });
  tabs.appendChild(aboutTab);
  page.appendChild(tabs);

  const content = el("div", "tab-content");
  if (orgTab === "about") {
    content.appendChild(buildAbout());
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
  if (orgTab !== "about") {
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

/** Renders a fatal error in place of the UI. */
function renderFatal(error: unknown): void {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }
  root.innerHTML = "";
  root.appendChild(el("div", "page error", "Error: " + describeError(error)));
}
