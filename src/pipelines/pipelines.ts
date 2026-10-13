import * as SDK from "azure-devops-extension-sdk";

import { getHeading, iconFor } from "../common/branding";
import { extensionVersion } from "../common/extension-urls";
import { PipelineSummary, getPipelineSummaries } from "../common/build-service";
import { filterByName } from "../common/filter";
import { formatRelativeTime } from "../common/format";
import { getHostNavigation, HostNavigationService } from "../common/host-nav";
import { describeError, logError, logInfo } from "../common/log";

/**
 * Pipelines hub.
 *
 * Lists the project's pipelines with a brief summary (run count, last result/time, fails since
 * the last success) and links into each pipeline/build. Requires the Build (read) permission;
 * without it a clear message is shown.
 */

let nav: HostNavigationService;
let pipelines: PipelineSummary[] = [];
let filter = "";

SDK.init({ applyTheme: true });
logInfo("Pages pipelines hub initializing.");

let settled = false;
const guard = window.setTimeout(() => {
  if (!settled) {
    settled = true;
    SDK.notifyLoadFailed("Pipelines initialization timed out.");
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
      // Pipelines load after the shell so the page appears immediately.
      void loadPipelines();
    } catch (error) {
      settled = true;
      window.clearTimeout(guard);
      logError("Pipelines initialization failed.", error);
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

/** The organization/project web base for building links. */
function webBase(): string {
  const host = SDK.getHost();
  const web = SDK.getWebContext();
  const organization = host ? host.name : "";
  const project = web && web.project ? web.project.name : "";
  return `https://dev.azure.com/${organization}/${encodeURIComponent(project)}`;
}

/** Builds the page shell (heading, filter, table). */
function render(): void {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }
  root.innerHTML = "";
  document.title = "Pipelines";

  const page = el("div", "page");
  page.appendChild(getHeading("h1", "Pipelines", iconFor("pipelines")));
  const web = SDK.getWebContext();
  const project = web && web.project ? web.project.name : "this project";
  page.appendChild(el("p", "subtitle", `Pipelines in ${project}.`));

  const toolbar = el("div", "toolbar");
  const filterInput = document.createElement("input");
  filterInput.type = "text";
  filterInput.placeholder = "Filter pipelines...";
  filterInput.value = filter;
  filterInput.addEventListener("input", () => {
    filter = filterInput.value;
    renderRows();
  });
  toolbar.appendChild(filterInput);
  page.appendChild(toolbar);

  const table = el("table", "data-table");
  const head = el("thead");
  const headRow = el("tr");
  ["Pipeline", "Runs", "Last result", "Last run", "Fails since success"].forEach((label) =>
    headRow.appendChild(el("th", undefined, label))
  );
  head.appendChild(headRow);
  table.appendChild(head);
  const body = el("tbody");
  body.id = "pipelines-body";
  table.appendChild(body);
  page.appendChild(table);
  page.appendChild(el("p", "version", `Static ${extensionVersion()}`));
  root.appendChild(page);
  renderRows();
}

/** Renders the (filtered) pipeline rows, or a loading/permission message. */
function renderRows(): void {
  const body = document.getElementById("pipelines-body");
  if (!body) {
    return;
  }
  body.innerHTML = "";
  if (pipelines.length === 0 && !filter) {
    const row = el("tr");
    const cell = el("td", "empty", "Loading pipelines...");
    cell.colSpan = 5;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  const visible = filterByName(pipelines, filter);
  if (visible.length === 0) {
    const row = el("tr");
    const cell = el("td", "empty", "No matching pipelines.");
    cell.colSpan = 5;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }

  visible.forEach((pipeline) => {
    const row = el("tr");
    const nameCell = el("td");
    nameCell.appendChild(link(pipeline.name, `${webBase()}/_build?definitionId=${pipeline.id}`));
    row.appendChild(nameCell);
    row.appendChild(el("td", "num", String(pipeline.runCount)));
    const resultCell = el("td");
    if (pipeline.lastBuildId) {
      const label = pipeline.lastResult || "build";
      resultCell.appendChild(
        link(
          label,
          `${webBase()}/_build/results?buildId=${pipeline.lastBuildId}&view=results`
        )
      );
    } else {
      resultCell.textContent = "never";
    }
    row.appendChild(resultCell);
    row.appendChild(el("td", undefined, pipeline.lastFinishedUtc ? formatRelativeTime(pipeline.lastFinishedUtc) : "never"));
    row.appendChild(el("td", "num", String(pipeline.failsSinceSuccess)));
    body.appendChild(row);
  });
}

/** A link that navigates the host in the same tab. */
function link(text: string, url: string): HTMLAnchorElement {
  const anchor = el("a", undefined, text);
  anchor.href = url;
  anchor.addEventListener("click", (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    void nav.navigate(url);
  });
  return anchor;
}

/** Loads the pipeline summaries and re-renders. */
async function loadPipelines(): Promise<void> {
  try {
    pipelines = await getPipelineSummaries();
    renderRows();
  } catch (error) {
    const body = document.getElementById("pipelines-body");
    if (!body) {
      return;
    }
    body.innerHTML = "";
    const row = el("tr");
    const cell = el("td", "empty", describeError(error));
    cell.colSpan = 5;
    row.appendChild(cell);
    body.appendChild(row);
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
