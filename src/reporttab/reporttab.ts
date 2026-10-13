import * as SDK from "azure-devops-extension-sdk";

import { getHeading, iconFor } from "../common/branding";
import { getHostNavigation, HostNavigationService } from "../common/host-nav";
import { describeError, logError, logInfo } from "../common/log";

/**
 * Build-results report tab.
 *
 * Rationale: when a PublishPage run sets `tabName`, the task attaches the page's HTML to the build
 * (attachment type `static-page-html`). This frame lists those attachments and renders the chosen
 * one in a sandboxed iframe. It shows nothing meaningful when the task did not attach a report.
 *
 * The attachment type is intentionally NOT `report-html` (the Html Reports extension's type) so
 * the two extensions never show each other's attachments.
 */

const ATTACHMENT_TYPE = "static-page-html";

// Host navigation (best effort): lets the selected report be reflected in the URL (?pagetab=...).
let nav: HostNavigationService | null = null;

interface Attachment {
  name?: string;
  _links?: { self?: { href?: string } };
}

// The build this tab is showing (filled by the host via onBuildChanged).
interface BuildInfo {
  id: number;
  project?: { id?: string; name?: string };
}

SDK.init({ applyTheme: true });
logInfo("Static page report tab initializing.");

SDK.ready()
  .then(async () => {
    // The navigation service (when available) makes the selected report bookmarkable.
    try {
      nav = await getHostNavigation();
    } catch (error) {
      nav = null;
    }
    const config = SDK.getConfiguration() as {
      onBuildChanged?: (callback: (build: BuildInfo) => void) => void;
    };
    if (config && typeof config.onBuildChanged === "function") {
      config.onBuildChanged((build) => {
        void render(build);
      });
    } else {
      renderMessage("No build context was provided.");
    }
  })
  .catch((error) => {
    logError("Report tab initialization failed.", error);
    renderMessage("Initialization error: " + describeError(error));
  });

/** Loads the task's attachments for the build and renders them (or a friendly message). */
async function render(build: BuildInfo): Promise<void> {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }
  root.innerHTML = "";
  try {
    const organization = SDK.getHost().name;
    const projectId = (build.project && build.project.id) || SDK.getWebContext().project?.id || "";
    const attachments = await listAttachments(organization, projectId, build.id);
    if (attachments.length === 0) {
      // The task ran without a tabName (or attached nothing): show a gentle note, not an error.
      renderMessage("No static page report was attached to this build.");
      return;
    }
    await renderReports(root, attachments);
  } catch (error) {
    logError("Unable to load the report attachments.", error);
    renderMessage("Unable to load the report: " + describeError(error));
  }
}

/** Lists the build's attachments of our type (needs `vso.build` read). */
async function listAttachments(
  organization: string,
  projectId: string,
  buildId: number
): Promise<Attachment[]> {
  const base = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
    projectId
  )}/_apis/build/builds/${buildId}/attachments/${ATTACHMENT_TYPE}`;
  const response = await authorizedFetch(`${base}?api-version=6.0`);
  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    throw new Error(`GET attachments -> ${response.status} ${await response.text()}`);
  }
  // The raw REST shape is { count, value: Attachment[] } (the SDK client unwraps `value`).
  const body = (await response.json()) as { value?: Attachment[] } | Attachment[];
  const list = Array.isArray(body) ? body : body.value || [];
  return list.filter((attachment) => attachment && attachment.name);
}

/** Renders a tab strip and a sandboxed iframe for the selected attachment. */
async function renderReports(root: HTMLElement, attachments: Attachment[]): Promise<void> {
  const page = document.createElement("div");
  page.appendChild(getHeading("h1", "Static page", iconFor("pages")));

  const tabs = document.createElement("div");
  tabs.className = "report-tabs";
  const frame = document.createElement("iframe");
  frame.className = "report-frame";
  // Sandbox the pipeline HTML (no same-origin) exactly like the hub viewer does.
  frame.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads");

  const ordered = attachments.slice().sort(byName);
  // Preselect a report named in the URL (?pagetab=...) so each report is bookmarkable.
  let selected = ordered[0];
  if (nav) {
    try {
      const params = (await nav.getQueryParams()) || {};
      const wanted = params.pagetab || "";
      const found = ordered.find((attachment) => (attachment.name || "") === wanted);
      if (found) {
        selected = found;
      }
    } catch (error) {
      // Older hosts may not expose query params; fall back to the first report.
    }
  }

  const buttons: HTMLButtonElement[] = [];
  const select = (attachment: Attachment): void => {
    buttons.forEach((button) => button.classList.toggle("active", button.dataset.name === attachment.name));
    void showAttachment(frame, attachment);
    if (nav) {
      // Reflect the choice in the URL so it can be bookmarked/shared.
      void nav
        .getQueryParams()
        .then((params) => nav && nav.setQueryParams({ ...(params || {}), pagetab: attachment.name || "" }))
        .catch(() => undefined);
    }
  };
  ordered.forEach((attachment) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "report-tab" + (attachment === selected ? " active" : "");
    button.dataset.name = attachment.name || "";
    button.textContent = tabLabel(attachment.name || "");
    button.addEventListener("click", () => select(attachment));
    buttons.push(button);
    tabs.appendChild(button);
  });

  page.appendChild(tabs);
  page.appendChild(frame);
  root.appendChild(page);
  await showAttachment(frame, selected);
}

/** Fetches one attachment's HTML and puts it in the frame (Basic auth, like the reference). */
async function showAttachment(frame: HTMLIFrameElement, attachment: Attachment): Promise<void> {
  const href = attachment._links && attachment._links.self && attachment._links.self.href;
  if (!href) {
    frame.setAttribute("srcdoc", "<p>This attachment has no download link.</p>");
    return;
  }
  frame.setAttribute("srcdoc", "<p style='font-family:sans-serif;padding:16px'>Loading...</p>");
  try {
    const response = await authorizedFetch(href, true);
    if (!response.ok) {
      throw new Error(`GET attachment -> ${response.status}`);
    }
    frame.setAttribute("srcdoc", await response.text());
  } catch (error) {
    frame.setAttribute(
      "srcdoc",
      `<p style='font-family:sans-serif;padding:16px'>Unable to load the report: ${escapeHtml(
        describeError(error)
      )}</p>`
    );
  }
}

/** A fetch that authorizes with the extension's access token (Basic ':' + token). */
async function authorizedFetch(url: string, content = false): Promise<Response> {
  const token = await SDK.getAccessToken();
  const headers: Record<string, string> = {
    Authorization: "Basic " + btoa(":" + token)
  };
  if (!content) {
    headers.Accept = "application/json";
  }
  return fetch(url, { headers });
}

/** The visible label for an attachment, from "<tab>~<job>~<stage>~<attempt>~<file>". */
function tabLabel(name: string): string {
  const parts = (name || "").split("~");
  const tab = parts[0] || "Report";
  const stage = parts[2];
  // "__default" is the no-stage name; the task dashifies it to "default".
  return stage && stage !== "__default" && stage !== "default" ? `${tab} (${stage})` : tab;
}

/** Sorts attachments by their name (stable, predictable tab order). */
function byName(a: Attachment, b: Attachment): number {
  return (a.name || "").localeCompare(b.name || "");
}

/** Shows a plain message in place of the report. */
function renderMessage(text: string): void {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }
  root.innerHTML = "";
  const message = document.createElement("p");
  message.className = "report-message";
  message.textContent = text;
  root.appendChild(message);
}

/** Escapes text before inserting into srcdoc so a crafted error cannot inject markup. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
