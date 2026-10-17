import * as SDK from "azure-devops-extension-sdk";

import {
  LinkEntry,
  LinkIndex,
  PrivateLinksIndex,
  ProposalIndex,
  addPrivateLink,
  currentUser,
  deletePrivateLinks,
  emptyLinks,
  emptyPrivateLinks,
  emptyProposals,
  getLinks,
  getPrivateLinks,
  getProposals,
  newPageId,
  purgeExpiredLinks,
  putProposal,
  removeProposals,
  savePrivateLinks,
  updatePrivateLink
} from "../common/data-service";
import { getHeading, iconFor } from "../common/branding";
import { linkAreaLabel } from "../common/link-url";
import { resolveLink } from "../common/dynamic-resolve";
import { HUB_LINKS, pagesHubUrl } from "../common/extension-urls";
import { getHostNavigation, HostNavigationService } from "../common/host-nav";
import { PermissionState, canAccessProjectSettings } from "../common/permissions";
import { LinkDraft, createLinkEditor } from "../common/link-editor";
import { mergedRows, proposalFor, reconcile, slugTaken } from "../common/private-links";
import { confirmDialog } from "../common/dialog";
import { describeError, logError, logInfo } from "../common/log";
import { encodeQuery, withQueryParam } from "../common/urls";
import { el, iconButton } from "../common/dom";
import { ICON_DELETE, ICON_EDIT, ICON_SHARE, ICON_ADD } from "../common/icons";

/**
 * Links hub.
 *
 * Two tables, one heading: the links a project administrator curated for everyone, and the private
 * links only the signed-in user can see. A private link can be **shared**: that offers a frozen
 * snapshot to the project's settings page as a proposed link, where anyone with access to those
 * settings can add it to the project. An accepted proposal is promoted - the project owns the link
 * and the private original is cleaned up on the owner's next visit (see common/private-links.ts).
 *
 * Private links live in the extension data service's **User** scope, so the service isolates them per
 * user; nothing here filters other people's links out, because they are never in this store.
 */

const HUB_ID = HUB_LINKS;

let nav: HostNavigationService;
// The project's curated links.
let index: LinkIndex = emptyLinks();
// This user's private links for this project.
let mine: PrivateLinksIndex = emptyPrivateLinks();
// The project's proposal list (readable by everyone; written only by the settings page).
let proposals: ProposalIndex = emptyProposals();
let currentQuery: Record<string, string> = {};
// Whether the current user may open this project's settings. Only wording and hints depend on it
// (`null` = could not be evaluated).
let canOpenProjectSettings: PermissionState = null;
// "list" or "editor" (add/edit a private link); mirrored into the host hash so Back works.
let view: "list" | "editor" = "list";
let editingPrivateId: string | null = null;
// The filter box's value (title, slug and comment are all searched).
let filter = "";
// A one-off message shown above the tables.
let notice = "";

/** The shared link editor, configured for this user's private links. */
const linkEditor = createLinkEditor({
  // The slug must be free among the project's links too: a `?page=<slug>` bookmark resolves project
  // links first, so reusing one would open somebody else's link.
  takenSlugs: () => [
    ...(index.links || []).map((link) => link.slug),
    ...(index.trash || []).map((entry) => entry.link.slug),
    ...(mine.links || []).filter((link) => link.linkId !== editingPrivateId).map((link) => link.slug)
  ],
  hint: "Private links are visible only to you until you share one with the project.",
  addLabel: "Add private link",
  saveLabel: "Save changes",
  onSave: (draft) => void onSavePrivate(draft),
  onCancel: () => showList()
});

// `applyTheme: true` applies the user's theme (light/dark) variables to this document.
SDK.init({ applyTheme: true });
logInfo("Links hub initializing.");

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
      // Auto-purge links trashed more than the retention window ago; the permission probe runs
      // alongside it, because it only words the empty state and must not delay the rows.
      const [links, privateLinks, projectProposals, projectSettings] = await Promise.all([
        purgeExpiredLinks(5),
        getPrivateLinks(),
        getProposals(),
        canAccessProjectSettings()
      ]);
      index = links;
      mine = privateLinks;
      proposals = projectProposals;
      canOpenProjectSettings = projectSettings;
      await applyDecisions();
      // The editor view is addressable (so Back works and a reload keeps it).
      const hash = (await nav.getHash()) || "";
      if (hash === "add") {
        view = "editor";
        editingPrivateId = null;
        linkEditor.reset();
      } else if (hash.startsWith("edit")) {
        view = "editor";
        const wanted = hash.split("=")[1] || "";
        const link = (mine.links || []).find((candidate) => candidate.linkId === wanted);
        if (link) {
          editingPrivateId = link.linkId;
          linkEditor.setDraft(link, true);
        } else {
          // The link is gone (or never existed): fall back to the list rather than an empty form.
          view = "list";
        }
      }
      nav.onHashChanged((value) => {
        const next = (value || "").replace(/^#/, "");
        if (next === "add" || next.startsWith("edit")) {
          view = "editor";
        } else {
          view = "list";
          editingPrivateId = null;
        }
        renderList("");
      });
      await render();
      logInfo("Links hub ready.", {
        links: (index.links || []).length,
        privateLinks: (mine.links || []).length,
        proposals: (proposals.proposals || []).length
      });
    } catch (error) {
      settled = true;
      window.clearTimeout(guard);
      logError("Links initialization failed.", error);
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

/**
 * Applies the outcome of any decided proposal to this user's private links.
 * Rationale: nobody else can write to this user's store, so acceptance does not delete the private
 * original - the decision travels back through the proposal record and is applied here (promotion
 * removes the private link, rejection returns it with a marker).
 */
async function applyDecisions(): Promise<void> {
  const owner = currentUser();
  const plan = reconcile(mine.links || [], proposals.proposals || [], owner.id, new Date());
  if (!plan.changed) {
    return;
  }
  mine = { ...mine, links: plan.links };
  await savePrivateLinks(mine);
  if (plan.removeProposalIds.length > 0) {
    proposals = await removeProposals(plan.removeProposalIds);
  }
  if (plan.removeLinkIds.length > 0) {
    // A promoted proposal is a project link now, so that table changed too.
    index = await getLinks();
  }
  logInfo("Applied proposal decisions.", {
    promoted: plan.removeLinkIds.length,
    rejected: plan.removeProposalIds.length
  });
}

/** Renders either the list or (for a `?page=` bookmark) the resolved target. */
async function render(): Promise<void> {
  const slug = currentQuery.page || "";
  const projectLink = slug ? (index.links || []).find((candidate) => candidate.slug === slug) : undefined;
  // A private link resolves only when no project link owns the slug (project links win).
  const privateLink =
    slug && !projectLink ? (mine.links || []).find((candidate) => candidate.slug === slug) : undefined;
  const link = projectLink || privateLink;
  if (link) {
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

/** Shows the list view and puts the address back on the list. */
function showList(): void {
  view = "list";
  editingPrivateId = null;
  notice = "";
  try {
    // A *named* hash rather than "": setting an empty hash leaves a bare trailing '#' in the host URL.
    nav.setHash("list");
  } catch {
    // A hash we cannot set must not stop the form from closing.
  }
  renderList("");
}

/** Opens the editor for a new or an existing private link. */
function showEditor(link?: LinkEntry): void {
  editingPrivateId = link ? link.linkId : null;
  view = "editor";
  notice = "";
  if (link) {
    linkEditor.setDraft(link, true);
  } else {
    linkEditor.reset();
  }
  try {
    nav.setHash(link ? `edit=${link.linkId}` : "add");
  } catch {
    // Fall through to an in-place switch.
  }
  renderList("");
}

/** Saves the private link being edited (create or update). */
async function onSavePrivate(draft: LinkDraft): Promise<void> {
  try {
    if (editingPrivateId) {
      mine = await updatePrivateLink(editingPrivateId, {
        title: draft.title,
        url: draft.url,
        comment: draft.comment,
        dynamic: draft.dynamic,
        area: draft.area,
        updatedUtc: new Date().toISOString(),
        // Editing clears a previous rejection: the message belongs to the old snapshot.
        rejectedUtc: undefined
      });
    } else {
      mine = await addPrivateLink(draft.title, draft.slug, draft.url, draft.comment, draft.dynamic, draft.area);
    }
    showList();
  } catch (error) {
    notice = describeError(error);
    logError("Unable to save the private link.", error);
    renderList(notice);
  }
}

/** Deletes one private link. */
async function deletePrivateLink(link: LinkEntry): Promise<void> {
  const confirmed = await confirmDialog(
    `Delete "${link.title}"? It is a private link, so this removes it for you only.`
  );
  if (!confirmed) {
    return;
  }
  try {
    mine = await deletePrivateLinks([link.linkId]);
    // A proposal for a deleted link is withdrawn, so nobody is asked to review it.
    const orphan = (proposals.proposals || []).find(
      (proposal) => proposal.privateLinkId === link.linkId && proposal.state === "open"
    );
    if (orphan) {
      proposals = await removeProposals([orphan.proposalId]);
    }
    notice = "";
    renderList("");
  } catch (error) {
    notice = describeError(error);
    logError("Unable to delete the private link.", error);
    renderList(notice);
  }
}

/** Offers a private link to the project as a proposed link (the reviewers see this snapshot). */
async function sharePrivateLink(link: LinkEntry): Promise<void> {
  if (link.proposal) {
    // Already waiting for a decision - sharing again would only duplicate the record.
    renderList(`"${link.title}" is already proposed to the project.`);
    return;
  }
  if (slugTaken(index, [], link.slug)) {
    renderList(
      `The slug '${link.slug}' is already used by a project link, so this link cannot be offered as it is. ` +
        "Edit it to use another slug, then share it."
    );
    return;
  }
  const confirmed = await confirmDialog(
    `Share "${link.title}" with the project?\n\n` +
      "The project settings page shows it as a proposed link, where anyone who can open those settings " +
      "can add it to the project. The title, slug, URL and comment above are submitted; you keep your " +
      "private copy until it is added."
  );
  if (!confirmed) {
    return;
  }
  try {
    const owner = currentUser();
    const proposal = proposalFor(link, { id: owner.id, name: owner.name }, newPageId());
    proposals = await putProposal(proposal);
    mine = await updatePrivateLink(link.linkId, {
      proposal: { proposalId: proposal.proposalId, proposedUtc: proposal.proposedUtc },
      rejectedUtc: undefined
    });
    notice = `"${link.title}" was proposed to the project.`;
    renderList(notice);
  } catch (error) {
    notice = describeError(error);
    logError("Unable to propose the private link.", error);
    renderList(notice);
  }
}

/** The list of links (or the editor); the filter narrows the single merged table. */
function renderList(message: string, loading = false): void {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }
  root.innerHTML = "";
  document.title = "Static links";
  if (message) {
    notice = message;
  }

  const page = el("div", "page");
  page.appendChild(getHeading("h1", "Static links", iconFor("links")));
  page.appendChild(el("p", "subtitle", "Bookmarkable links into this project."));
  if (notice && view === "list") {
    page.appendChild(el("p", "notice", notice));
  }

  if (view === "editor") {
    page.appendChild(editorSection());
  } else {
    page.appendChild(linksSection(loading));
    page.appendChild(addButton());
  }

  root.appendChild(page);
  // The rows are filled in *after* the page is in the document: renderRows() looks the table up by
  // id, and an element that is not attached yet cannot be found. (0.2.6 rendered the table empty for
  // exactly that reason - the first paint's loading row is appended through a live reference, which
  // is why only the loaded rows were missing.)
  if (view === "list" && !loading) {
    renderRows();
  }
  // Running version, centered at the bottom of the frame.
  page.appendChild(el("p", "version", `Static ${version()}`));
}

/**
 * The merged list: the project's links and the user's private links in one table.
 * Rationale: one list with a Status column replaces two tables that repeated every column, and the
 * private links (the ones a member can act on) are no longer pushed below the fold.
 */
function linksSection(loading: boolean): HTMLElement {
  const section = el("div", "section");

  // Filter over title, slug and comment - the same interaction as the Repos hub.
  const toolbar = el("div", "toolbar");
  const filterInput = document.createElement("input");
  filterInput.type = "text";
  filterInput.placeholder = "Filter links...";
  filterInput.value = filter;
  // Re-render only the rows as the user types; keeps focus in the filter box.
  filterInput.addEventListener("input", () => {
    filter = filterInput.value;
    renderRows();
  });
  toolbar.appendChild(filterInput);
  section.appendChild(toolbar);

  const table = el("table", "data-table");
  const head = el("thead");
  const headRow = el("tr");
  ["Title", "Slug", "Area", "Comment", "Status", "Actions"].forEach((label, index) => {
    const cell = el("th", index >= 4 ? "col-right" : undefined, label);
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);
  table.appendChild(head);
  const body = el("tbody");
  body.id = "links-body";
  table.appendChild(body);
  section.appendChild(table);

  if (loading) {
    // Shown only during the first paint, before data arrives (keeps the switch feeling instant).
    const row = el("tr");
    const cell = el("td", "empty", "Loading links...");
    cell.colSpan = 6;
    row.appendChild(cell);
    body.appendChild(row);
  }
  return section;
}

/** Renders the merged rows for the current filter (called on load and on every keystroke). */
function renderRows(): void {
  const body = document.getElementById("links-body");
  if (!body) {
    return;
  }
  body.innerHTML = "";
  const rows = mergedRows(index, mine.links || [], filter);

  if (rows.length === 0) {
    const row = el("tr");
    const trimmed = filter.trim();
    const message = trimmed
      ? `No links match "${trimmed}".`
      : emptyMessage();
    const cell = el("td", "empty", message);
    cell.colSpan = 6;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }

  rows.forEach(({ link, status, mine: own }) => {
    const row = el("tr");
    const titleCell = el("td");
    titleCell.appendChild(linkAnchor(link));
    row.appendChild(titleCell);
    row.appendChild(el("td", "mono", link.slug));
    row.appendChild(el("td", "col-nowrap", areaLabel(link)));
    row.appendChild(el("td", undefined, link.comment || ""));
    row.appendChild(el("td", "col-right status", status));
    row.appendChild(own ? actionCell(link) : el("td", "col-right"));
    body.appendChild(row);
  });
}

/** Edit / Delete / Share, kept together in a single cell so they stay on one row. */
function actionCell(link: LinkEntry): HTMLElement {
  // A flex wrapper inside the cell (rather than a flex cell) keeps the table's columns intact.
  const cell = el("td", "col-right");
  const box = el("div", "row-actions");
  const edit = iconButton({ icon: ICON_EDIT, label: `Edit "${link.title}"`, onClick: () => showEditor(link) });
  const remove = iconButton({
    icon: ICON_DELETE,
    label: `Delete "${link.title}"`,
    onClick: () => void deletePrivateLink(link)
  });
  const proposed = Boolean(link.proposal);
  // A rejected link is simply private again, so the tooltip is what says it was not accepted.
  const rejected = Boolean(link.rejectedUtc) && !proposed;
  const share = iconButton({
    icon: ICON_SHARE,
    label: proposed
      ? `"${link.title}" is already proposed`
      : rejected
        ? `Share "${link.title}" with the project again (the last proposal was not accepted)`
        : `Share "${link.title}" with the project`,
    onClick: () => void sharePrivateLink(link),
    disabled: proposed
  });
  box.appendChild(edit);
  box.appendChild(remove);
  box.appendChild(share);
  cell.appendChild(box);
  return cell;
}

/** The "Add private link" button (or a hint when the user may curate project links instead). */
function addButton(): HTMLElement {
  const wrap = el("div", "form-buttons");
  const add = el("button", "primary");
  add.type = "button";
  add.title = "Create a link only you can see";
  // The icon is our own markup, not user content.
  add.innerHTML = `${ICON_ADD}<span>Add private link</span>`;
  add.addEventListener("click", () => showEditor());
  wrap.appendChild(add);
  return wrap;
}

/** The editor view: the shared link form, plus what the buttons do. */
function editorSection(): HTMLElement {
  const section = el("div", "section");
  section.appendChild(el("h2", undefined, editingPrivateId ? "Edit private link" : "Add private link"));
  section.appendChild(
    el(
      "p",
      "subtitle",
      editingPrivateId
        ? "This link is yours; saving keeps it private until you share it."
        : "This link is visible only to you. You can share it with the project afterwards."
    )
  );
  section.appendChild(linkEditor.buildForm());
  return section;
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

/** The running extension version (shown at the bottom). */
function version(): string {
  const context = SDK.getExtensionContext();
  return context && context.version ? context.version : "unknown";
}

/** Short Area label for a link (Repo/PR/Pipeline/Artifact/Fixed). */
function areaLabel(link: LinkEntry): string {
  return linkAreaLabel(link.url, link.area);
}

/**
 * Empty-state wording for the merged list.
 * Rationale: "add them under Project settings" is wrong advice for a member who cannot open those
 * settings, so the message follows the permission probe (and stays neutral when it is unknown).
 */
function emptyMessage(): string {
  if (canOpenProjectSettings === false) {
    return "No links yet. Ask a project administrator to add project links under Project settings -> Static -> Links, or add a private link.";
  }
  return "No links yet. Add a project link under Project settings -> Static -> Links, or add a private link.";
}

/** Renders a fatal error in place of the UI. */
function renderFatal(error: unknown): void {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }
  root.innerHTML = "";
  root.appendChild(
    el("div", "page error", "Error: " + (describeError(error)))
  );
}
