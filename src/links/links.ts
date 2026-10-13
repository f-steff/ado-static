import * as SDK from "azure-devops-extension-sdk";

import { LinkEntry, LinkIndex, emptyLinks, getLinks, purgeExpiredLinks } from "../common/data-service";
import { getHeading, iconFor } from "../common/branding";
import { linkAreaLabel } from "../common/link-url";
import { resolveLink } from "../common/dynamic-resolve";
import { HUB_LINKS, pagesHubUrl } from "../common/extension-urls";
import { getHostNavigation, HostNavigationService } from "../common/host-nav";
import { logError, logInfo } from "../common/log";
import { encodeQuery, withQueryParam } from "../common/urls";

/**
 * Links hub.
 *
 * A curated list of bookmarkable links for this project. Each link is addressed by
 * `?page={slug}` (like pages); selecting one navigates the host to its stored URL in the same
 * tab. Links built from the project stay in-project; a "fixed" link (including one published by
 * the PublishLink task) may point outside it.
 */

const HUB_ID = HUB_LINKS;

let nav: HostNavigationService;
let index: LinkIndex = emptyLinks();
let currentQuery: Record<string, string> = {};

// `applyTheme: true` applies the user's theme (light/dark) variables to this document.
SDK.init({ applyTheme: true });
logInfo("Pages links hub initializing.");

// Safety net: report an explicit failure if initialization stalls.
let settled = false;
const guard = window.setTimeout(() => {
  if (!settled) {
    settled = true;
    SDK.notifyLoadFailed("Links initialization timed out.");
  }
}, 20000);

// SDK lifecycle: init -> ready -> load -> render -> notify.
SDK.ready()
  .then(async () => {
    try {
      nav = await getHostNavigation();
      currentQuery = (await nav.getQueryParams()) || {};
      // First paint: render the heading and a loading row at once, then clear the host's loading
      // indicator. Rationale: switching hubs replaces the whole iframe, so showing the header
      // immediately makes the switch feel instant; the rows fill in as soon as data arrives.
      renderList("", true);
      settled = true;
      window.clearTimeout(guard);
      SDK.notifyLoadSucceeded();
      // Auto-purge links trashed more than the retention window ago, then render the list.
      index = await purgeExpiredLinks(5);
      await render();
      logInfo("Pages links hub ready.", { links: (index.links || []).length });
    } catch (error) {
      settled = true;
      window.clearTimeout(guard);
      logError("Links initialization failed.", error);
      renderFatal(error);
      SDK.notifyLoadFailed(error instanceof Error ? error.message : String(error));
    }
  })
  .catch((error) => {
    settled = true;
    window.clearTimeout(guard);
    logError("SDK ready failed.", error);
    SDK.notifyLoadFailed(String(error));
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

/** Renders either the list or (for a `?page=` bookmark) the resolved target. */
async function render(): Promise<void> {
  const slug = currentQuery.page || "";
  const link = slug ? (index.links || []).find((candidate) => candidate.slug === slug) : undefined;
  if (slug && link) {
    const error = await openLink(link);
    if (error) {
      renderList(error);
    }
    return;
  }
  renderList(slug ? `No link with the slug '${slug}' exists in this project.` : "");
}

/**
 * Bookmark path: resolve a dynamic link (if any) and navigate to the in-project target.
 * Returns an error message when the dynamic part could not be resolved.
 */
async function openLink(link: LinkEntry): Promise<string> {
  document.title = link.title;
  let url = link.url;
  if (link.dynamic) {
    const result = await resolveLink(link.dynamic, link.url);
    if (!result.ok || !result.url) {
      return `Could not open "${link.title}": ${result.error || "the target could not be resolved."}`;
    }
    url = result.url;
  }
  nav.navigate(url);
  return "";
}

/** The list of links; each title is a link that navigates to its target in the same tab. */
function renderList(notice: string, loading = false): void {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }
  root.innerHTML = "";
  document.title = "Static links";

  const page = el("div", "page");
  page.appendChild(getHeading("h1", "Static links", iconFor("links")));
  page.appendChild(el("p", "subtitle", "Bookmarkable links into this project."));
  if (notice) {
    page.appendChild(el("p", "error", notice));
  }

  const table = el("table", "data-table");
  const head = el("thead");
  const headRow = el("tr");
  ["Title", "Slug", "Area", "Comment"].forEach((label) =>
    headRow.appendChild(el("th", undefined, label))
  );
  head.appendChild(headRow);
  table.appendChild(head);
  const body = el("tbody");
  table.appendChild(body);
  page.appendChild(table);

  const links = (index.links || []).filter((link) => !link.hidden).slice().sort(byOrderThenTitle);
  if (loading) {
    // Shown only during the first paint, before data arrives (keeps the switch feeling instant).
    const row = el("tr");
    const cell = el("td", "empty", "Loading links...");
    cell.colSpan = 4;
    row.appendChild(cell);
    body.appendChild(row);
  } else if (links.length === 0) {
    const row = el("tr");
    const cell = el("td", "empty", "No links yet. Add them under Project settings -> Pages.");
    cell.colSpan = 4;
    row.appendChild(cell);
    body.appendChild(row);
  } else {
    links.forEach((link) => {
      const row = el("tr");
      const titleCell = el("td");
      titleCell.appendChild(linkAnchor(link));
      row.appendChild(titleCell);
      row.appendChild(el("td", "mono", link.slug));
      row.appendChild(el("td", "col-nowrap", areaLabel(link)));
      row.appendChild(el("td", undefined, link.comment || ""));
      body.appendChild(row);
    });
  }

  root.appendChild(page);
  // Running version, centered at the bottom of the frame.
  page.appendChild(el("p", "version", `Static ${version()}`));
}

/**
 * Builds a link row anchor. The href is the bookmarkable extension URL (for copy/new-tab); a
 * plain click navigates straight to the stored target so the browser Back returns to this list.
 */
function linkAnchor(link: LinkEntry): HTMLAnchorElement {
  const anchor = el("a", undefined, link.title);
  anchor.href = linkHref(link.slug);
  anchor.title = link.url;
  anchor.addEventListener("click", (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    // A dynamic link needs resolving first; a plain link navigates straight to the target.
    if (link.dynamic) {
      void openLink(link).then((error) => {
        if (error) {
          renderList(error);
        }
      });
    } else {
      nav.navigate(link.url);
    }
  });
  return anchor;
}

/** The hub's own URL carrying the current params and the requested link slug. */
function linkHref(slug: string): string {
  return withQueryParam(`${pagesHubUrl(HUB_ID)}${encodeQuery(currentQuery)}`, "page", slug);
}

/** Sort key: explicit order first, then title. */
function byOrderThenTitle(a: LinkEntry, b: LinkEntry): number {
  return (a.order || 0) - (b.order || 0) || a.title.localeCompare(b.title);
}

/** The running extension version (shown at the bottom). */
function version(): string {
  const context = SDK.getExtensionContext();
  return context && context.version ? context.version : "unknown";
}

/** Short Area label for a link (Repo/PR/Pipeline/Artifact/Fixed). */
function areaLabel(link: LinkEntry): string {
  return linkAreaLabel(link.url, link.area);
}

/** Renders a fatal error in place of the UI. */
function renderFatal(error: unknown): void {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }
  root.innerHTML = "";
  root.appendChild(el("div", "page error", "Error: " + (error instanceof Error ? error.message : String(error))));
}
