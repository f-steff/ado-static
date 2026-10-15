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
  currentProjectName,
  emptyIndex,
  emptyLinks,
  getHiddenRepos,
  organizationName,
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
  LinkProposal,
  ProposalIndex,
  acceptProposal,
  currentUser,
  decideProposal,
  emptyProposals,
  getProposals
} from "../common/data-service";
import { buildAbout } from "../common/about";
import { getHeading } from "../common/branding";
import { el, textField } from "../common/dom";
import { PipelineSummary, getPipelineSummaries } from "../common/build-service";
import { checkProjectUrl } from "../common/ado-url";
import { DYNAMIC_TOKEN, DynamicSpec } from "../common/dynamic-links";
import { isHttpUrl, linkAreaLabel } from "../common/link-url";
import { acceptanceError } from "../common/private-links";
import { LinkDraft, createLinkEditor } from "../common/link-editor";
import { confirmDialog } from "../common/dialog";
import { HUB_LINKS, HUB_PAGES, extensionVersion, pagesOrgSettingsUrl, pagesProjectSettingsUrl, pagesHubUrl, projectBaseUrl } from "../common/extension-urls";
import { withQueryParam } from "../common/urls";
import { formatBytes, formatBytesWhole } from "../common/format";
import { trashExpiryUtc } from "../common/index-logic";
import { RepositoryInfo, listRepositories } from "../common/git-service";
import { getHostNavigation, hostNavigate, HostNavigationService } from "../common/host-nav";
import { PermissionState, canAccessOrgSettings } from "../common/permissions";
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
// Links members proposed from their private list, awaiting a decision (see buildProposalsSection).
let proposals: ProposalIndex = emptyProposals();
let errorText = "";
// Active settings tab: links | pages | repos | trash.
let activeTab = "links";
let editingPageId: string | null = null;
let formName = "";
let formSlug = "";
let formComment = "";
// Which project link the Links tab is editing (null = the form is in add mode). The form itself is
// the shared editor in common/link-editor, which the Links hub also uses for private links.
let editingLinkId: string | null = null;

/**
 * The shared link editor, configured for project links.
 * Rationale: a link's slug must be unique among the project's links (live and trashed), because a
 * `?page=<slug>` bookmark resolves against those first.
 */
const linkEditor = createLinkEditor({
  takenSlugs: () =>
    [
      ...(links.links || []).map((link) => link.slug),
      ...(links.trash || []).map((entry) => entry.link.slug)
    ],
  hint: "Add link clears only the slug, so you can build several links from the same selections; use Clear to start over.",
  addLabel: "Add link",
  saveLabel: "Save changes",
  onSave: (draft) => void onPrimaryLink(draft),
  onCancel: () => resetLinkForm()
});
// Whether the current user may open the organization settings. `null` means "could not be
// evaluated" - the button is then shown, because the host denies it anyway and hiding it from a
// collection administrator would be the worse failure.
let canOpenOrgSettings: PermissionState = null;

// `applyTheme: true` applies the user's theme (light/dark) variables to this document.
SDK.init({ applyTheme: true });
logInfo("Pages admin initializing.");

// Safety net: if initialization stalls (e.g. a hung SDK call), fail explicitly so the host
// shows a real error instead of the generic "taking longer than expected" message.
let settled = false;
let nav: HostNavigationService | undefined;
// Known tabs; the active tab is mirrored into the host hash so Back/Forward work.
const ADMIN_TABS = ["links", "pages", "pipelines", "repos", "trash", "about"];

/** Normalizes a hash value (strips a leading '#'). */

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
      // Probe the organization-settings permission alongside the data load so the tab strip is
      // rendered from the real answer on the first paint (no button appearing a moment later).
      const [, orgAccess] = await Promise.all([load(), canAccessOrgSettings()]);
      canOpenOrgSettings = orgAccess;
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
  proposals = await getProposals();
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
    ["trash", `Trash (${trashCount})`, true],
    ["about", "About", false]
  ];
  tabDefs.forEach(([id, label, right]) => {
    // The Org.Settings button is not a tab: it leaves this page for the organization settings. It is
    // only useful to a user who can open those settings, so a definite "no" hides it.
    if (id === "about" && canOpenOrgSettings !== false) {
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
          nav.navigate(pagesProjectSettingsUrl(currentProjectName()) + "#" + id);
        } catch {
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
    linkFormSection.appendChild(linkEditor.buildForm());
    content.appendChild(linkFormSection);

    content.appendChild(el("h2", undefined, "Links"));
    const linkTableSection = el("div", "section");
    linkTableSection.appendChild(buildLinkTable());
    content.appendChild(linkTableSection);

    const proposalSection = el("div", "section");
    proposalSection.appendChild(buildProposalsSection());
    content.appendChild(proposalSection);
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
    `https://dev.azure.com/${organizationName()}/${encodeURIComponent(currentProjectName())}` +
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
  // A shortcut always starts from a clean editor (add mode, fresh builder), then pre-fills it.
  linkEditor.reset();
  linkEditor.patch({
    title: `${pipeline.name}: ${suffix}`,
    slug: slugify(`${pipeline.name}-${mode}`),
    url: base + view,
    comment: "",
    dynamic: { kind: "build", buildMode, definitionId: pipeline.id }
  });
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
      nav.navigate(pagesProjectSettingsUrl(currentProjectName()) + "#links");
    } catch {
      // Fall through to an in-place switch.
    }
  }
  render();
  // Parse the pre-filled URL so the builder levels reflect it (never truncated).
  linkEditor.parse();
}

/** Pre-fills the link form from a repository shortcut and switches to the Links tab. */
function quickAddRepoLink(repo: RepositoryInfo, mode: string): void {
  const base = projectBaseUrl() + "/_git/" + encodeURIComponent(repo.name);
  // A shortcut always starts from a clean editor (add mode, fresh builder), then pre-fills it.
  linkEditor.reset();
  const prefill = (url: string, title: string, slug: string, dynamic?: DynamicSpec): void => {
    linkEditor.patch({ url, title, slug, comment: "", dynamic });
  };
  switch (mode) {
    case "pr-newest-open":
    case "pr-oldest-open":
      prefill(
        base + "/pullrequest/" + DYNAMIC_TOKEN,
        `${repo.name}: ${mode === "pr-oldest-open" ? "oldest open PR" : "newest open PR"}`,
        slugify(`${repo.name}-${mode === "pr-oldest-open" ? "oldest-pr" : "newest-pr"}`),
        {
          kind: "pr",
          prScope: mode === "pr-oldest-open" ? "oldest-open" : "newest-open",
          repositoryId: repo.id
        }
      );
      break;
    case "commit-latest":
      prefill(
        base + "/commit/" + DYNAMIC_TOKEN,
        `${repo.name}: latest commit`,
        slugify(`${repo.name}-latest-commit`),
        { kind: "commit", repositoryId: repo.id, branch: repo.defaultBranch || "main" }
      );
      break;
    case "pr-list":
      prefill(base + "/pullrequests?_a=active", `${repo.name}: open pull requests`, slugify(`${repo.name}-pull-requests`));
      break;
    case "pr-all":
      prefill(base + "/pullrequests?_a=all", `${repo.name}: all pull requests`, slugify(`${repo.name}-all-pull-requests`));
      break;
    case "commits":
      prefill(base + "/commits", `${repo.name}: commits`, slugify(`${repo.name}-commits`));
      break;
    case "branches":
      prefill(base + "/branches", `${repo.name}: branches`, slugify(`${repo.name}-branches`));
      break;
    case "tags":
      prefill(base + "/tags", `${repo.name}: tags`, slugify(`${repo.name}-tags`));
      break;
    default:
      // Repository root (a fixed link).
      prefill(base, repo.name, slugify(repo.name));
      break;
  }
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

/** Maps a build "view" query value to a builder view option key. */

/** Primary link action: create a link, or save edits (including the dynamic target). */
async function onPrimaryLink(draft: LinkDraft): Promise<void> {
  try {
    if (editingLinkId) {
      links = await updateLink(editingLinkId, {
        title: draft.title,
        url: draft.url,
        comment: draft.comment,
        dynamic: draft.dynamic,
        area: draft.area
      });
      resetLinkForm();
    } else {
      links = await addLink(draft.title, draft.slug, draft.url, draft.comment, draft.dynamic, draft.area);
      // Keep the selections so several links can be built from the same path; only the slug is
      // cleared, and the user must press Clear to start over.
      editingLinkId = null;
      linkEditor.patch({ slug: "" });
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
  linkEditor.reset();
  errorText = "";
  render();
}

/** Switches the link form into edit mode (slug locked). */
function onEditLink(link: LinkEntry): void {
  editingLinkId = link.linkId;
  // Preselect the Fixed area for a stored fixed (or out-of-project) link so the form validates.
  const outOfProject =
    isHttpUrl(link.url) &&
    !checkProjectUrl(link.url, organizationName(), currentProjectName(), currentProjectId()).ok;
  const area = link.area === "fixed" || outOfProject ? "fixed" : link.area;
  linkEditor.setDraft(
    {
      title: link.title,
      slug: link.slug,
      url: link.url,
      comment: link.comment || "",
      dynamic: link.dynamic,
      area
    },
    true
  );
  errorText = "";
  render();
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

/** The proposals awaiting a decision, oldest first (the order members offered them). */
function openProposals(): LinkProposal[] {
  return (proposals.proposals || [])
    .filter((proposal) => proposal.state === "open")
    .sort((a, b) => a.proposedUtc.localeCompare(b.proposedUtc));
}

/**
 * Proposed links: private links members offered to this project.
 * Rationale: a proposal is a **snapshot**, so the reviewers see exactly what was offered; accepting
 * creates an ordinary project link (the project owns it from then on, and the proposer loses nothing
 * private - their copy is cleaned up by their own client, which is the only writer allowed to).
 */
function buildProposalsSection(): HTMLElement {
  const wrap = el("div");
  const items = openProposals();
  wrap.appendChild(el("h2", undefined, `Proposed links (${items.length})`));
  wrap.appendChild(
    el(
      "p",
      "hint",
      "Private links offered by project members. Adding one makes it a normal project link; the member keeps nothing private."
    )
  );

  const table = el("table", "data-table");
  const head = el("thead");
  const headRow = el("tr");
  ["Title", "Slug", "Area", "URL", "Comment", "Proposed by"].forEach((label) =>
    headRow.appendChild(el("th", undefined, label))
  );
  head.appendChild(headRow);
  table.appendChild(head);

  const body = el("tbody");
  table.appendChild(body);

  if (items.length === 0) {
    const row = el("tr");
    const cell = el("td", "empty", "No proposed links.");
    cell.colSpan = 6;
    row.appendChild(cell);
    body.appendChild(row);
    return wrap;
  }

  items.forEach((proposal) => {
    const row = el("tr", "data-row");
    row.appendChild(el("td", undefined, proposal.title));
    row.appendChild(el("td", "mono", proposal.slug));
    row.appendChild(el("td", "col-nowrap", linkAreaLabel(proposal.url, proposal.area)));
    row.appendChild(el("td", "url", proposal.url));
    row.appendChild(el("td", undefined, proposal.comment || ""));
    row.appendChild(el("td", undefined, proposal.proposedByName || "(unknown)"));
    body.appendChild(row);

    const actionsRow = el("tr", "actions-row");
    const actionsCell = el("td");
    actionsCell.colSpan = 6;
    const box = el("div", "row-actions");
    // A proposal that cannot be added (its slug was taken, or the URL shape is wrong) explains why
    // instead of offering a button that could only fail.
    const problem = acceptanceError(
      proposal,
      links,
      organizationName(),
      currentProjectName(),
      currentProjectId()
    );
    const add = rowButton("Add to project", () => void onAcceptProposal(proposal));
    add.title = problem || "Add this link to the project";
    add.disabled = Boolean(problem);
    box.appendChild(add);
    box.appendChild(rowButton("Reject", () => void onRejectProposal(proposal)));
    if (problem) {
      box.appendChild(el("span", "error", problem));
    }
    actionsCell.appendChild(box);
    actionsRow.appendChild(actionsCell);
    body.appendChild(actionsRow);
  });

  wrap.appendChild(table);
  return wrap;
}

/** Accepts a proposal: it becomes a project link (the owner's client cleans up the private copy). */
async function onAcceptProposal(proposal: LinkProposal): Promise<void> {
  const problem = acceptanceError(
    proposal,
    links,
    organizationName(),
    currentProjectName(),
    currentProjectId()
  );
  if (problem) {
    fail(problem);
    return;
  }
  if (
    !(await confirmDialog(
      `Add "${proposal.title}" to the project links? It is offered by ${proposal.proposedByName || "a member"}, ` +
        "and becomes an ordinary project link that anyone with these settings can edit or delete."
    ))
  ) {
    return;
  }
  try {
    const result = await acceptProposal(proposal.proposalId, currentUser().name);
    links = result.links;
    proposals = result.proposals;
    errorText = "";
    render();
  } catch (error) {
    fail("Unable to add the proposed link.", error);
  }
}

/** Rejects a proposal: the member keeps the private link and is told it was not added. */
async function onRejectProposal(proposal: LinkProposal): Promise<void> {
  if (
    !(await confirmDialog(
      `Do not add "${proposal.title}"? Its owner keeps the private link and sees that it was not added.`
    ))
  ) {
    return;
  }
  try {
    proposals = await decideProposal(proposal.proposalId, "rejected", currentUser().name);
    errorText = "";
    render();
  } catch (error) {
    fail("Unable to reject the proposed link.", error);
  }
}

/** Builds the links trash table with restore and delete-instantly actions. */

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
