import * as SDK from "azure-devops-extension-sdk";

import { filterByName } from "../common/filter";
import { getHeading, iconFor } from "../common/branding";
import { extensionVersion } from "../common/extension-urls";
import { formatRelativeTime } from "../common/format";
import { PullRequestInfo, getPullRequestById, listPullRequests } from "../common/git-service";
import { isValidPullRequestId } from "../common/pr-url";
import { getHostNavigation, HostNavigationService } from "../common/host-nav";
import { describeError, logError, logInfo } from "../common/log";

/**
 * PR hub.
 *
 * Lists the project's pull requests (all statuses) with a brief summary and a link to each PR.
 * Rationale: complements the Repos hub with "what is in flight"; data comes from the read-only
 * Git REST API (`vso.code`).
 */

let nav: HostNavigationService;
let pullRequests: PullRequestInfo[] = [];
let filter = "";
// Open PRs are shown by default; completed/abandoned are opt-in.
let includeClosed = false;
// False until the first load finishes (so the shell can show a loading row immediately).
let loaded = false;
// Non-empty when the last load failed (e.g. a missing permission); shown in place of rows.
let loadError = "";

// `applyTheme: true` applies the user's theme (light/dark) variables to this document.
SDK.init({ applyTheme: true });
logInfo("Pages pr hub initializing.");

// Safety net: report an explicit failure if initialization stalls.
let settled = false;
const guard = window.setTimeout(() => {
  if (!settled) {
    settled = true;
    SDK.notifyLoadFailed("PR initialization timed out.");
  }
}, 20000);

SDK.ready()
  .then(async () => {
    try {
      nav = await getHostNavigation();
      render();
      settled = true;
      window.clearTimeout(guard);
      SDK.notifyLoadSucceeded();
      // Pull requests load after the shell so the page appears immediately.
      void loadPullRequests();
    } catch (error) {
      settled = true;
      window.clearTimeout(guard);
      logError("PR initialization failed.", error);
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

/** Builds the page shell: heading, filter, and the pull-request table. */
function render(): void {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }
  root.innerHTML = "";
  document.title = "Pull requests";

  const page = el("div", "page");
  page.appendChild(getHeading("h1", "Pull requests", iconFor("pr")));
  const web = SDK.getWebContext();
  const project = web && web.project ? web.project.name : "this project";
  page.appendChild(el("p", "subtitle", `Pull requests in ${project}.`));

  const toolbar = el("div", "toolbar");
  const filterInput = document.createElement("input");
  filterInput.type = "text";
  filterInput.placeholder = "Filter pull requests...";
  filterInput.value = filter;
  filterInput.addEventListener("input", () => {
    filter = filterInput.value;
    renderRows();
  });
  toolbar.appendChild(filterInput);
  const closedLabel = el("label", "toggle");
  const closedInput = document.createElement("input");
  closedInput.type = "checkbox";
  closedInput.checked = includeClosed;
  closedInput.addEventListener("change", () => {
    includeClosed = closedInput.checked;
    renderRows();
  });
  closedLabel.appendChild(closedInput);
  closedLabel.appendChild(document.createTextNode("Include completed / abandoned"));
  toolbar.appendChild(closedLabel);

  // Global PR jump (right-aligned): resolve any PR by id, in any state, and go to it.
  const globalPr = el("div", "global-pr");
  globalPr.appendChild(el("span", "global-pr-label", "Global PR #"));
  const prNumber = document.createElement("input");
  prNumber.type = "number";
  prNumber.min = "1";
  prNumber.step = "1";
  prNumber.className = "global-pr-input";
  prNumber.setAttribute("aria-label", "Global pull request number");
  const prJump = el("button", "global-pr-jump", "Jump");
  const prNotice = el("span", "global-pr-notice");
  // The input accepts digits only (strip anything else as it is typed/pasted).
  prNumber.addEventListener("input", () => {
    const digits = prNumber.value.replace(/[^0-9]/g, "");
    if (digits !== prNumber.value) {
      prNumber.value = digits;
    }
  });
  prJump.addEventListener("click", () => void jumpToPullRequest(prNumber, prNotice));
  prNumber.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      void jumpToPullRequest(prNumber, prNotice);
    }
  });
  globalPr.appendChild(prNumber);
  globalPr.appendChild(prJump);
  globalPr.appendChild(prNotice);
  toolbar.appendChild(globalPr);

  page.appendChild(toolbar);

  const table = el("table", "data-table");
  const head = el("thead");
  const headRow = el("tr");
  ["Title", "Repository", "Author", "Created", "Status", "Branches"].forEach((label) =>
    headRow.appendChild(el("th", undefined, label))
  );
  head.appendChild(headRow);
  table.appendChild(head);
  const body = el("tbody");
  body.id = "pr-body";
  table.appendChild(body);
  page.appendChild(table);
  page.appendChild(el("p", "version", `Static ${extensionVersion()}`));
  root.appendChild(page);

  renderRows();
}

/** Renders the (filtered) pull-request rows. */
function renderRows(): void {
  const body = document.getElementById("pr-body");
  if (!body) {
    return;
  }
  body.innerHTML = "";
  if (!loaded) {
    // First paint, before data arrives (keeps the hub switch feeling instant).
    const row = el("tr");
    const cell = el("td", "empty", "Loading pull requests...");
    cell.colSpan = 6;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  if (loadError) {
    const row = el("tr");
    const cell = el("td", "empty", loadError);
    cell.colSpan = 6;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }

  // Only open (active) PRs unless the user opted in to closed ones; then filter by title.
  const base = includeClosed
    ? pullRequests
    : pullRequests.filter((pr) => (pr.status || "").toLowerCase() === "active");
  const visible = filterByName(base, filter)
    .slice()
    .sort((a, b) => b.createdUtc.localeCompare(a.createdUtc));
  if (visible.length === 0) {
    const row = el("tr");
    const cell = el("td", "empty", base.length === 0 ? "No open pull requests." : "No matching pull requests.");
    cell.colSpan = 6;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }

  visible.forEach((pr) => {
    const row = el("tr");
    const titleCell = el("td");
    titleCell.appendChild(prAnchor(pr));
    row.appendChild(titleCell);
    row.appendChild(el("td", undefined, pr.repository));
    row.appendChild(el("td", undefined, pr.author));
    row.appendChild(el("td", undefined, formatRelativeTime(pr.createdUtc)));
    row.appendChild(el("td", "status", (pr.draft ? "draft, " : "") + pr.status));
    row.appendChild(el("td", "branches", `${pr.sourceBranch} -> ${pr.targetBranch}`));
    body.appendChild(row);
  });
}

/** Loads the pull requests, then re-renders (or shows a permission message). */
async function loadPullRequests(): Promise<void> {
  try {
    pullRequests = await listPullRequests();
    logInfo("Pages pr hub ready.", { pullRequests: pullRequests.length });
  } catch (error) {
    pullRequests = [];
    loadError = describeError(error);
  }
  loaded = true;
  renderRows();
}

/** A PR title that opens the pull request in the host (same tab). */
function prAnchor(pr: PullRequestInfo): HTMLAnchorElement {
  const anchor = el("a", undefined, pr.title);
  anchor.href = pr.webUrl;
  anchor.title = pr.webUrl;
  anchor.addEventListener("click", (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    void nav.navigate(pr.webUrl);
  });
  return anchor;
}

/**
 * Jumps to any pull request by number. Rationale: PR numbers are a single organization-wide
 * sequence, so the number alone identifies a PR - its project and repository are resolved on jump
 * (the number is looked up across the whole organization, any state). Shows "Unknown #" briefly when
 * it cannot be resolved, but keeps the typed number so it can be corrected.
 */
async function jumpToPullRequest(input: HTMLInputElement, notice: HTMLElement): Promise<void> {
  const value = input.value.replace(/[^0-9]/g, "");
  if (!isValidPullRequestId(value)) {
    return;
  }
  const id = parseInt(value, 10);
  notice.textContent = "Searching...";
  notice.classList.remove("error");
  try {
    const pr = await getPullRequestById(id);
    if (pr) {
      notice.textContent = "";
      notice.classList.remove("error");
      void nav.navigate(pr.webUrl);
      return;
    }
  } catch (error) {
    // A lookup failure is treated like "not found" below.
  }
  // Not found: show it briefly (the number stays for correction).
  notice.textContent = `Unknown #${id}`;
  notice.classList.add("error");
  window.setTimeout(() => {
    if (notice.textContent === `Unknown #${id}`) {
      notice.textContent = "";
      notice.classList.remove("error");
    }
  }, 2500);
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
