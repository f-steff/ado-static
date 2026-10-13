import * as SDK from "azure-devops-extension-sdk";

import { getHiddenRepos } from "../common/data-service";
import { filterByName } from "../common/filter";
import { getHeading, iconFor } from "../common/branding";
import { firstName } from "../common/contributors";
import { extensionVersion } from "../common/extension-urls";
import { formatRelativeTime } from "../common/format";
import { getRepoStats, listRepositories, RepoStats, RepositoryInfo } from "../common/git-service";
import { getHostNavigation, HostNavigationService } from "../common/host-nav";
import { describeError, logError, logInfo } from "../common/log";

/**
 * Repos hub.
 *
 * Lists the current project's repositories with a few all-time statistics (last commit, commits,
 * committers, branches) and a name filter identical to the org-settings project filter.
 *
 * Rationale: the repository list comes from the read-only Git REST API; the per-repo statistics
 * load progressively so the list appears immediately instead of waiting for every git call.
 */

let nav: HostNavigationService;
let repositories: RepositoryInfo[] = [];
let filter = "";
const stats = new Map<string, RepoStats>();
// False until the repository list arrives (so the shell can show a loading row immediately).
let loaded = false;
// Non-empty when the last load failed (e.g. a missing permission); shown in place of rows.
let loadError = "";

// `applyTheme: true` applies the user's theme (light/dark) variables to this document.
SDK.init({ applyTheme: true });
logInfo("Pages repos hub initializing.");

// Safety net: report an explicit failure if initialization stalls.
let settled = false;
const guard = window.setTimeout(() => {
  if (!settled) {
    settled = true;
    SDK.notifyLoadFailed("Repos initialization timed out.");
  }
}, 20000);

// SDK lifecycle: init -> ready -> load repositories -> render -> notify.
SDK.ready()
  .then(async () => {
    try {
      nav = await getHostNavigation();
      render();
      settled = true;
      window.clearTimeout(guard);
      SDK.notifyLoadSucceeded();
      // The repository list loads after the shell so the page appears immediately.
      void loadRepositories();
    } catch (error) {
      settled = true;
      window.clearTimeout(guard);
      logError("Repos initialization failed.", error);
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

/** Builds the page shell: heading, filter, and the repository table. */
function render(): void {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }
  root.innerHTML = "";

  const page = el("div", "page");
  page.appendChild(getHeading("h1", "Repositories", iconFor("repos")));
  const web = SDK.getWebContext();
  const project = web && web.project ? web.project.name : "this project";
  page.appendChild(el("p", "subtitle", `Repositories in ${project}.`));

  const toolbar = el("div", "toolbar");
  const filterInput = document.createElement("input");
  filterInput.type = "text";
  filterInput.placeholder = "Filter repositories...";
  filterInput.value = filter;
  // Re-render only the rows as the user types; keeps focus in the filter box.
  filterInput.addEventListener("input", () => {
    filter = filterInput.value;
    renderRows();
  });
  toolbar.appendChild(filterInput);
  page.appendChild(toolbar);

  const table = el("table", "data-table");
  const head = el("thead");
  const headRow = el("tr");
  ["Repository", "Main contributor", "Default branch", "Last commit", "Commits", "Committers", "Branches"].forEach(
    (label) => headRow.appendChild(el("th", undefined, label))
  );
  head.appendChild(headRow);
  table.appendChild(head);
  const body = el("tbody");
  body.id = "repos-body";
  table.appendChild(body);
  page.appendChild(table);
  page.appendChild(el("p", "version", `Static ${extensionVersion()}`));
  root.appendChild(page);

  renderRows();
}

/** Renders the (filtered) repository rows; statistics are filled in as they arrive. */
function renderRows(): void {
  const body = document.getElementById("repos-body");
  if (!body) {
    return;
  }
  body.innerHTML = "";

  if (!loaded) {
    // First paint, before data arrives (keeps the hub switch feeling instant).
    const row = el("tr");
    const cell = el("td", "empty", "Loading repositories...");
    cell.colSpan = 7;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  if (loadError) {
    const row = el("tr");
    const cell = el("td", "empty", loadError);
    cell.colSpan = 7;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }

  const visible = filterByName(repositories, filter).slice().sort((a, b) => a.name.localeCompare(b.name));
  if (visible.length === 0) {
    const row = el("tr");
    const cell = el("td", "empty", repositories.length === 0 ? "No repositories." : "No matching repositories.");
    cell.colSpan = 7;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }

  visible.forEach((repo) => {
    const row = el("tr");
    row.dataset.repoId = repo.id;

    const nameCell = el("td");
    nameCell.appendChild(repoLink(repo));
    row.appendChild(nameCell);

    // Defaults are shown until the statistics call returns.
    row.appendChild(cellWithRole("main", "..."));
    row.appendChild(el("td", undefined, repo.defaultBranch || "-"));
    row.appendChild(cellWithRole("last", "..."));
    row.appendChild(cellWithRole("commits", "..."));
    row.appendChild(cellWithRole("committers", "..."));
    row.appendChild(cellWithRole("branches", "..."));
    body.appendChild(row);
    applyStatsToRow(repo.id);
  });
}

/** Creates a link that opens the repository in the Azure DevOps host (top page). */
function repoLink(repo: RepositoryInfo): HTMLAnchorElement {
  const anchor = el("a", undefined, repo.name);
  anchor.href = repo.webUrl;
  anchor.addEventListener("click", (event) => {
    // Honour modified clicks (new tab/window) by letting the real href navigate.
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    void nav.navigate(repo.webUrl);
  });
  return anchor;
}

/** Creates a table cell that can be updated later by role. */
function cellWithRole(role: string, text: string): HTMLTableCellElement {
  const cell = el("td");
  cell.dataset.role = role;
  cell.textContent = text;
  return cell;
}

/** Applies cached statistics to a row's cells, if the row is present. */
function applyStatsToRow(repoId: string): void {
  const row = document.querySelector<HTMLTableRowElement>(`tr[data-repo-id="${repoId}"]`);
  const value = stats.get(repoId);
  if (!row || !value) {
    return;
  }
  const set = (role: string, text: string) => {
    const cell = row.querySelector<HTMLElement>(`[data-role="${role}"]`);
    if (cell) {
      cell.textContent = text;
    }
  };
  // Main contributor shows the first name; the full name is the hover tooltip.
  const mainCell = row.querySelector<HTMLElement>('[data-role="main"]');
  if (mainCell) {
    mainCell.textContent = value.mainContributor ? firstName(value.mainContributor) : "-";
    mainCell.title = value.mainContributor || "";
  }
  set("last", value.lastCommitUtc ? `${formatRelativeTime(value.lastCommitUtc)} - ${value.lastCommitBy}` : "no commits");
  set("commits", `${value.commits}${value.commitsCapped ? "+" : ""}`);
  set("committers", String(value.committers));
  set("branches", String(value.branches));
}

/** Loads the repository list (excluding hidden ones), then renders and starts the statistics. */
async function loadRepositories(): Promise<void> {
  try {
    const [all, hidden] = await Promise.all([listRepositories(), getHiddenRepos()]);
    const hiddenSet = new Set(hidden);
    repositories = all.filter((repo) => !hiddenSet.has(repo.id));
    logInfo("Pages repos hub ready.", { repositories: repositories.length });
  } catch (error) {
    repositories = [];
    loadError = describeError(error);
  }
  loaded = true;
  renderRows();
  if (!loadError) {
    // Load statistics in the background so the list renders immediately.
    void loadStats();
  }
}

/** Loads per-repository statistics with a small concurrency pool. */
async function loadStats(): Promise<void> {
  const queue = repositories.slice();
  const worker = async () => {
    while (queue.length > 0) {
      const repo = queue.shift();
      if (!repo) {
        break;
      }
      stats.set(repo.id, await getRepoStats(repo.id));
      applyStatsToRow(repo.id);
    }
  };
  await Promise.all(Array.from({ length: 5 }, () => worker()));
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
