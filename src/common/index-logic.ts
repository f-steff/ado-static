// Pure index mutations for the Pages data model.
//
// Rationale: keeping these free of the SDK, fetch and the DOM makes the CRUD, trash, purge and
// slug-reservation rules unit-testable in plain Node (see tests/logic.test.ts). Every function
// returns a new index and never mutates its input, so a failed write cannot corrupt cached state.
import type { PageIndex, PageMetadata, TrashEntry } from "./data-service";

/** The identity/timestamp stamped onto a new trash entry. */
export interface TrashStamp {
  trashId: string;
  deletedUtc: string;
  deletedBy: string;
}

/** An index guaranteed to have concrete `pages`/`trash` arrays (used internally). */
interface WorkingIndex extends PageIndex {
  pages: PageMetadata[];
  trash: TrashEntry[];
}

/** Clones the index deep enough that nested page/trash objects are not shared with the caller. */
function cloneIndex(index: PageIndex): WorkingIndex {
  return {
    ...index,
    pages: (index.pages || []).map((page) => ({ ...page })),
    trash: (index.trash || []).map((entry) => ({ ...entry, page: { ...entry.page } }))
  };
}

/** Every page that reserves a slug: live pages plus trashed pages (FR-ADM-11). */
function reservingPages(index: PageIndex): PageMetadata[] {
  return [...(index.pages || []), ...(index.trash || []).map((entry) => entry.page)];
}

/** Case-insensitive slug check across live and trashed pages. */
export function slugInUse(index: PageIndex, slug: string): boolean {
  const needle = (slug || "").toLowerCase();
  return reservingPages(index).some((page) => page.slug.toLowerCase() === needle);
}

/** Creates a page; throws when the slug (live or trashed) is already taken. */
export function addPageToIndex(
  index: PageIndex,
  page: { pageId: string; name: string; slug: string; comment?: string }
): PageIndex {
  if (slugInUse(index, page.slug)) {
    throw new Error(`The slug '${page.slug}' is already in use (including items in the trash).`);
  }
  const next = cloneIndex(index);
  next.pages.push({
    pageId: page.pageId,
    name: page.name,
    slug: page.slug,
    order: next.pages.length,
    enabled: true,
    hidden: false,
    comment: page.comment || "",
    sizeBytes: 0,
    contentVersion: 0,
    updatedUtc: "",
    updatedBy: ""
  });
  return next;
}

/** Applies a metadata patch to one page (no-op when the page is unknown). */
export function updatePageInIndex(
  index: PageIndex,
  pageId: string,
  patch: Partial<PageMetadata>
): PageIndex {
  const next = cloneIndex(index);
  const page = next.pages.find((candidate) => candidate.pageId === pageId);
  if (page) {
    Object.assign(page, patch);
  }
  return next;
}

/** Moves a page to the trash (metadata retained; content is left in place until purged). */
export function removePageFromIndex(index: PageIndex, pageId: string, stamp: TrashStamp): PageIndex {
  const next = cloneIndex(index);
  const at = next.pages.findIndex((page) => page.pageId === pageId);
  if (at < 0) {
    return next;
  }
  const [page] = next.pages.splice(at, 1);
  next.trash.push({ ...stamp, page });
  return next;
}

/** Restores a trashed page to the end of the live list. */
export function restorePageInIndex(index: PageIndex, trashId: string): PageIndex {
  const next = cloneIndex(index);
  const at = next.trash.findIndex((entry) => entry.trashId === trashId);
  if (at < 0) {
    return next;
  }
  const [entry] = next.trash.splice(at, 1);
  entry.page.order = next.pages.length;
  next.pages.push(entry.page);
  return next;
}

/** Removes one trash entry and reports the pageId whose content must be purged. */
export function purgeTrashInIndex(
  index: PageIndex,
  trashId: string
): { index: PageIndex; pageId: string } {
  const next = cloneIndex(index);
  const at = next.trash.findIndex((entry) => entry.trashId === trashId);
  if (at < 0) {
    return { index: next, pageId: "" };
  }
  const [entry] = next.trash.splice(at, 1);
  return { index: next, pageId: entry.page.pageId };
}

/** Trash entries deleted strictly before `nowMs - days` (pure, so retention is testable). */
export function expiredTrashEntries(index: PageIndex, nowMs: number, days: number): TrashEntry[] {
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  return (index.trash || []).filter((entry) => Date.parse(entry.deletedUtc) < cutoff);
}

/** ISO time at which a trashed item is permanently deletable (`deletedUtc` + `days`). */
export function trashExpiryUtc(deletedUtc: string, days = 5): string {
  const deleted = Date.parse(deletedUtc);
  if (Number.isNaN(deleted)) {
    return "";
  }
  return new Date(deleted + days * 24 * 60 * 60 * 1000).toISOString();
}

/** Removes the given trash entries, reporting the pageIds whose content must be purged. */
export function removeTrashEntries(
  index: PageIndex,
  trashIds: string[]
): { index: PageIndex; pageIds: string[] } {
  const next = cloneIndex(index);
  const removed = next.trash.filter((entry) => trashIds.includes(entry.trashId));
  next.trash = next.trash.filter((entry) => !trashIds.includes(entry.trashId));
  return { index: next, pageIds: removed.map((entry) => entry.page.pageId) };
}

/** Resets a page's content metadata after a clear (size 0, version bumped, updated cleared). */
export function clearPageInIndex(index: PageIndex, pageId: string): PageIndex {
  const next = cloneIndex(index);
  const page = next.pages.find((candidate) => candidate.pageId === pageId);
  if (page) {
    page.sizeBytes = 0;
    page.contentVersion = (page.contentVersion || 0) + 1;
    page.updatedUtc = "";
    page.updatedBy = "";
  }
  return next;
}

/** Computes the organization statistics (page count, total size, latest update) from an index. */
export function projectStats(index: PageIndex): { pages: number; totalBytes: number; updatedUtc: string } {
  const pages = index.pages || [];
  return {
    pages: pages.length,
    totalBytes: pages.reduce((sum, page) => sum + (page.sizeBytes || 0), 0),
    // Latest updatedUtc across pages (ISO-8601 strings sort lexicographically).
    updatedUtc: pages.reduce((latest, page) => (page.updatedUtc > latest ? page.updatedUtc : latest), "")
  };
}
