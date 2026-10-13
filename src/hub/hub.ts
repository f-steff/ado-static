import * as SDK from "azure-devops-extension-sdk";

import {
  PageIndex,
  PageMetadata,
  emptyIndex,
  getPageContent,
  purgeExpiredTrash
} from "../common/data-service";
import { extensionVersion, HUB_PAGES, pagesHubUrl } from "../common/extension-urls";
import { formatBytes } from "../common/format";
import { getHeading, iconFor } from "../common/branding";
import { getHostNavigation, HostNavigationService } from "../common/host-nav";
import { logError, logInfo, logWarn } from "../common/log";
import { clearPageStore, readPageStore, writePageStore } from "../common/page-store";
import { encodeQuery, withQueryParam } from "../common/urls";

/**
 * Pages hub.
 *
 * Two modes:
 *  - Landing (no `?page=`): lists this project's published pages as links.
 *  - Viewer (`?page={slug}`): renders only that page inside a sandboxed iframe.
 *
 * Rationale: a page link performs a full reload through the host query string, so the address
 * bar URL is the single source of truth (bookmarkable, refresh-safe). Extension content runs in
 * a cross-origin iframe, so clicks are intercepted and applied with the host navigation service
 * instead of a plain navigation; the real href is kept so copy/middle-click still work.
 */

const NS = "pages-hub";

/**
 * Builds the bridge injected into the sandboxed content.
 *
 * Rationale: the content runs in an opaque-origin frame where `location.search` is empty but
 * `location.hash` and `history.replaceState` work. The bridge therefore mirrors the host query
 * parameters into the content's **hash** (so pages that read/write `location.hash` keep working)
 * and reports hash changes back to the host (so a page's own state lands in the address bar).
 * The host's own `page` key is never forwarded to the page.
 */
function buildBridge(
  initialParams: Record<string, string>,
  pageSlug: string,
  hubBase: string,
  initialStore: Record<string, string>
): string {
  const initial = JSON.stringify(initialParams || {});
  const slug = JSON.stringify(pageSlug || "");
  const base = JSON.stringify(hubBase || "");
  const store = JSON.stringify(initialStore || {});
  return `(function () {
  var NS = "pages-hub";
  var initial = ${initial};
  var pageSlug = ${slug};
  var hubBase = ${base};
  var initialStore = ${store};
  var IGNORE = { page: 1 };
  function owned(p) {
    var o = {};
    for (var k in p) { if (!IGNORE[k] && k && p[k] !== undefined) { o[k] = String(p[k]); } }
    return o;
  }
  function encode(p) {
    var parts = [];
    for (var k in p) { parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(p[k])); }
    return parts.join("&");
  }
  function decode(h) {
    var o = {};
    String(h || "").replace(/^#/, "").split("&").forEach(function (pair) {
      if (!pair) { return; }
      var i = pair.indexOf("=");
      var k = decodeURIComponent(i < 0 ? pair : pair.slice(0, i));
      var v = decodeURIComponent(i < 0 ? "" : pair.slice(i + 1));
      o[k] = v;
    });
    return o;
  }
  function applyHash(p) {
    var q = encode(p);
    var cur = location.hash.replace(/^#/, "");
    if (q === cur) { return; }
    try { history.replaceState(null, "", "#" + q); } catch (e) { try { location.hash = q; } catch (e2) {} }
  }
  function report() { parent.postMessage({ ns: NS, type: "params", params: decode(location.hash) }, "*"); }
  // Expose a working localStorage backed by the extension frame (opaque-origin frames cannot use
  // the real one). Reads are synchronous from the injected snapshot; writes are forwarded to the
  // parent, which persists them on the stable gallery origin so they survive content upgrades.
  var mem = initialStore || {};
  function persist(k, v) { parent.postMessage({ ns: NS, type: "store", key: String(k), value: v == null ? null : String(v) }, "*"); }
  var fakeStore = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
    setItem: function (k, v) { mem[k] = String(v); persist(k, v); },
    removeItem: function (k) { delete mem[k]; persist(k, null); },
    clear: function () {
      for (var k in mem) { if (Object.prototype.hasOwnProperty.call(mem, k)) { delete mem[k]; } }
      parent.postMessage({ ns: NS, type: "clear" }, "*");
    },
    key: function (i) { var keys = Object.keys(mem); return i >= 0 && i < keys.length ? keys[i] : null; }
  };
  try { Object.defineProperty(fakeStore, "length", { get: function () { return Object.keys(mem).length; }, configurable: true }); } catch (e) {}
  try { Object.defineProperty(window, "localStorage", { value: fakeStore, configurable: true }); } catch (e) {}
  // Seed the hash before the page's own scripts read it, so the initial state survives.
  applyHash(owned(initial));
  window.addEventListener("hashchange", report);
  // replaceState/pushState do not raise hashchange, so mirror them to the host as well.
  try {
    var rs = history.replaceState, ps = history.pushState;
    history.replaceState = function () { rs.apply(history, arguments); report(); };
    history.pushState = function () { ps.apply(history, arguments); report(); };
  } catch (e) {}
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || m.ns !== NS) { return; }
    if (m.type === "params") { applyHash(owned(m.params || {})); }
  });
  // Popout: a page calls window.open(location.href), but its own URL is "about:srcdoc", so
  // redirect that (and other about:/empty URLs) to the real hub URL carrying the current state,
  // opening a genuine new browser tab.
  try {
    var origOpen = window.open;
    window.open = function (url, name, features) {
      var target = url;
      if (!target || target === location.href || String(target).indexOf("about:") === 0) {
        var p = decode(location.hash);
        p.page = pageSlug;
        target = hubBase + "?" + encode(p);
      }
      return origOpen.call(window, target, name, features);
    };
  } catch (e) {}
  parent.postMessage({ ns: NS, type: "ready" }, "*");
})();`;
}

interface BridgeMessage {
  ns?: string;
  type?: string;
  params?: Record<string, string>;
  key?: string;
  value?: string | null;
}

// Module state: navigation service, loaded index, current query, and the content frame.
let nav: HostNavigationService;
let index: PageIndex = emptyIndex();
let currentQuery: Record<string, string> = {};
let currentSlug = "";
let frame: HTMLIFrameElement | null = null;
let lastPosted = "";
// Page-owned query keys reported by the content, so dropped ones can be cleared from the URL.
let lastFrameKeys: string[] = [];

// `applyTheme: true` applies the user's theme (light/dark) variables to this document.
SDK.init({ applyTheme: true });
logInfo("Pages hub initializing.");

// Safety net: report an explicit failure if initialization stalls, so the host does not show
// its generic timeout message.
let settled = false;
const loadGuard = window.setTimeout(() => {
  if (!settled) {
    settled = true;
    SDK.notifyLoadFailed("Pages initialization timed out.");
  }
}, 20000);

// SDK lifecycle: init -> ready -> load index -> render list or viewer -> notify.
SDK.ready()
  .then(async () => {
    try {
      nav = await getHostNavigation();
      // Bridge messages from the sandboxed content (identity-checked in onMessage).
      window.addEventListener("message", onMessage);
      currentQuery = (await nav.getQueryParams()) || {};
      const slug = currentQuery.page || "";
      if (!slug) {
        // First paint for the landing list: heading + loading row, then clear the host indicator.
        // Rationale: switching hubs replaces the iframe, so the header at once feels instant.
        renderLanding("", true);
        settled = true;
        window.clearTimeout(loadGuard);
        SDK.notifyLoadSucceeded();
      }
      // Permanently remove pages trashed more than 5 days ago (lazy: enforced when the hub loads).
      index = await purgeExpiredTrash(5);
      await render();
      if (slug) {
        // A deep link to a page waits for its content (the viewer is the whole frame).
        settled = true;
        window.clearTimeout(loadGuard);
        SDK.notifyLoadSucceeded();
      }
      logInfo("Pages hub ready.");
    } catch (error) {
      settled = true;
      window.clearTimeout(loadGuard);
      logError("Initialization failed.", error);
      renderError(error);
      SDK.notifyLoadFailed(error instanceof Error ? error.message : String(error));
    }
  })
  .catch((error) => {
    settled = true;
    window.clearTimeout(loadGuard);
    logError("SDK ready failed.", error);
    SDK.notifyLoadFailed(error instanceof Error ? error.message : String(error));
  });

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

/** Sets the browser tab title via the host (falls back to the local document title). */
function setTitle(title: string): void {
  document.title = title;
  try {
    if (nav) {
      nav.setDocumentTitle(title);
    }
  } catch (error) {
    // Older hosts may not support it; the local title still applies.
  }
}

/** Chooses the landing list or the single-page viewer from the `?page=` query value. */
async function render(): Promise<void> {
  const slug = currentQuery.page || "";
  const meta = slug ? (index.pages || []).find((page) => page.slug === slug) : undefined;
  if (slug && meta) {
    await renderViewer(meta);
    return;
  }
  renderLanding(slug ? `No page with the slug '${slug}' exists in this project.` : "");
}

/** Landing mode: a table of the project's pages, each name a link to the viewer. */
function renderLanding(notice: string, loading = false): void {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }
  root.innerHTML = "";

  const page = el("div", "page");
  page.appendChild(getHeading("h1", "Static pages", iconFor("pages")));
  page.appendChild(el("p", "subtitle", "Published pages for this project. Select one to open it."));
  // Browser tab title; the ADO breadcrumb itself is host-rendered and cannot be extended.
  setTitle("Static pages");
  if (notice) {
    page.appendChild(el("p", "error", notice));
  }

  const table = el("table", "data-table");
  const head = el("thead");
  const headRow = el("tr");
  ["Name", "Slug", "Size", "Comments", "Updated"].forEach((label) =>
    headRow.appendChild(el("th", undefined, label))
  );
  head.appendChild(headRow);
  table.appendChild(head);
  const body = el("tbody");
  table.appendChild(body);
  page.appendChild(table);
  // Running version, centered at the bottom of the frame.
  page.appendChild(el("p", "version", `Static ${extensionVersion()}`));
  root.appendChild(page);

  // Hidden pages are omitted from the list (they still open by direct link).
  const pages = (index.pages || []).filter((meta) => !meta.hidden).slice().sort(byOrderThenName);
  if (loading) {
    // First paint, before the index arrives (keeps the hub switch feeling instant).
    const row = el("tr");
    const cell = el("td", "empty", "Loading pages...");
    cell.colSpan = 5;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  if (pages.length === 0) {
    const row = el("tr");
    const cell = el("td", "empty", "No pages yet. They appear after a pipeline publishes one.");
    cell.colSpan = 5;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }

  pages.forEach((meta) => {
    const row = el("tr");
    const nameCell = el("td");
    nameCell.appendChild(pageLink(meta.name, meta.slug));
    row.appendChild(nameCell);
    row.appendChild(el("td", "mono", meta.slug));
    row.appendChild(el("td", undefined, formatBytes(meta.sizeBytes)));
    row.appendChild(el("td", undefined, meta.comment || ""));
    row.appendChild(el("td", undefined, formatUpdated(meta)));
    body.appendChild(row);
  });
}

/** Viewer mode: only the selected page, full-bleed, in a sandboxed iframe. */
async function renderViewer(meta: PageMetadata): Promise<void> {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }
  root.innerHTML = "";
  currentSlug = meta.slug;
  // Browser tab title; the ADO breadcrumb itself is host-rendered and cannot be extended.
  setTitle(meta.name);

  // Slim in-content breadcrumb (the host breadcrumb cannot show the selected page): a link back
  // to the list, then the page title.
  const crumb = el("div", "crumb");
  const back = el("a", undefined, "Pages");
  back.href = pagesHubUrl(HUB_PAGES);
  back.addEventListener("click", (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    nav.navigate(pagesHubUrl(HUB_PAGES));
  });
  crumb.appendChild(back);
  crumb.appendChild(el("span", undefined, " / "));
  crumb.appendChild(el("span", undefined, meta.name));
  root.appendChild(crumb);

  const viewer = el("div", "viewer");
  // The sandbox is the security boundary for untrusted, pipeline-published HTML.
  frame = el("iframe", "content");
  // `allow-popups`(+escape) lets a page open its popout/"fullscreen" view in a real new browser
  // tab; `allow-downloads` lets it export files (e.g. CSV). Scripts stay sandboxed (no
  // allow-same-origin), so opaque-origin isolation from the ADO host is preserved.
  frame.setAttribute(
    "sandbox",
    "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads"
  );
  frame.setAttribute("title", meta.name);
  viewer.appendChild(frame);
  root.appendChild(viewer);

  // A disabled page is reachable by direct link but must not render (docs/05).
  if (!meta.enabled) {
    showNotice("Page disabled", `"${meta.name}" is disabled. Enable it in Project settings -> Pages.`);
    return;
  }
  const html = await getPageContent(meta.pageId);
  if (html == null) {
    showNotice("No content yet", "This page has not been published by a pipeline.");
    return;
  }
  setFrameContent(html, currentQuery);
}

/** Renders a fatal initialization error in place of the UI. */
function renderError(error: unknown): void {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }
  root.innerHTML = "";
  const container = el("div", "page error");
  container.textContent =
    "Initialization error: " + (error instanceof Error ? error.message : String(error));
  root.appendChild(container);
}

/** Builds a page link: real href for copy/new-tab, click intercepted for an in-place reload. */
function pageLink(text: string, slug: string): HTMLAnchorElement {
  const anchor = el("a", undefined, text);
  anchor.href = pageHref(slug);
  anchor.addEventListener("click", (event) => {
    // Honour modified clicks (new tab/window, download) by letting the real href navigate.
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    void goToPage(slug);
  });
  return anchor;
}
/** The hub's own URL carrying the current parameters and the requested `page`. */
function pageHref(slug: string): string {
  return withQueryParam(`${pagesHubUrl(HUB_PAGES)}${encodeQuery(currentQuery)}`, "page", slug);
}

/**
 * Navigates to a page via a real host navigation (not a soft query rewrite). Rationale: the
 * user wants the browser Back button to return to the list, which requires a history entry; the
 * host navigation service performs a full navigation and pushes one.
 */
function goToPage(slug: string): void {
  nav.navigate(pageHref(slug));
}

/** Shows a simple message in the content area (disabled/not-found/empty states). */
function showNotice(title: string, message: string): void {
  // Escape the interpolated values so a crafted slug/name cannot inject markup into the frame.
  setFrameContent(
    "<!doctype html><html><body style='font-family:Segoe UI,sans-serif;margin:24px'>" +
      `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p></body></html>`,
    {}
  );
}

/** Applies HTML to the sandboxed frame, injecting the parameter bridge first. */
function setFrameContent(html: string, params: Record<string, string>): void {
  if (!frame) {
    return;
  }
  frame.setAttribute(
    "srcdoc",
    withBridge(html, params, currentSlug, pagesHubUrl(HUB_PAGES), readPageStore(currentSlug))
  );
}

/** Injects the bridge script as early as possible so it can observe page behaviour. */
function withBridge(
  html: string,
  params: Record<string, string>,
  pageSlug: string,
  hubBase: string,
  store: Record<string, string>
): string {
  const script = `<script>${buildBridge(params, pageSlug, hubBase, store)}</script>`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => match + script);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (match) => match + script);
  }
  return script + html;
}

/** Human-readable "updated" text; "never" when the page has no content yet. */
function formatUpdated(meta: PageMetadata): string {
  if (!meta.updatedUtc) {
    return "never";
  }
  return `${meta.updatedUtc}${meta.updatedBy ? ` (${meta.updatedBy})` : ""}`;
}

/** Sort key: explicit order first, then name (stable, predictable listing). */
function byOrderThenName(a: PageMetadata, b: PageMetadata): number {
  return (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name);
}

/** Handles messages from the sandboxed content; identity-checked by source window. */
function onMessage(event: MessageEvent): void {
  const data = event.data as BridgeMessage | undefined;
  if (!data || data.ns !== NS) {
    return;
  }
  // The frame has an opaque origin, so the source window is the strongest identity check.
  if (frame && event.source !== frame.contentWindow) {
    logWarn("Ignoring bridge message from an unknown source.");
    return;
  }
  if (data.type === "ready") {
    lastPosted = "";
    postToFrame(currentQuery, true);
    return;
  }
  if (data.type === "store") {
    // Content saved a value (e.g. "Save view"); persist it on the extension origin.
    writePageStore(currentSlug, String(data.key || ""), data.value == null ? null : String(data.value));
    return;
  }
  if (data.type === "clear") {
    clearPageStore(currentSlug);
    return;
  }
  if (data.type === "params") {
    // Content-initiated change: mirror it into the URL, always keeping the current slug.
    const reported: Record<string, string> = {};
    Object.keys(data.params || {}).forEach((key) => {
      reported[key] = String((data.params as Record<string, string>)[key] ?? "");
    });
    const params: Record<string, string> = { ...reported };
    // Clear page-owned keys the content has dropped (e.g. a Reset), so the URL stays accurate.
    lastFrameKeys.forEach((key) => {
      if (!(key in reported) && key !== "page") {
        params[key] = "";
      }
    });
    lastFrameKeys = Object.keys(reported);
    if (currentSlug) {
      params.page = currentSlug;
    }
    nav.setQueryParams(params);
  }
}

/** Sends parameters into the content, skipping no-op sends to avoid feedback loops. */
function postToFrame(params: Record<string, string>, force: boolean): void {
  if (!frame || !frame.contentWindow) {
    return;
  }
  const serialized = JSON.stringify(params || {});
  if (!force && serialized === lastPosted) {
    return;
  }
  lastPosted = serialized;
  frame.contentWindow.postMessage({ ns: NS, type: "params", params: params || {} }, "*");
}

/** Escapes text before inserting into srcdoc so metadata JSON cannot execute. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
