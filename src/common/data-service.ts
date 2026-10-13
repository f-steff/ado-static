import * as SDK from "azure-devops-extension-sdk";

import {
  addPageToIndex,
  clearPageInIndex,
  expiredTrashEntries,
  projectStats,
  purgeTrashInIndex,
  removePageFromIndex,
  removeTrashEntries,
  restorePageInIndex,
  updatePageInIndex
} from "./index-logic";
import { countOpenPullRequests, countProjectRepositories } from "./git-service";
import { countPipelines } from "./build-service";
import { DynamicSpec } from "./dynamic-links";
import { describeError, logDebug } from "./log";

/**
 * Data access for Pages.
 *
 * Transport rationale: we use the Extension Data **REST** API directly (with the extension's
 * bearer token) rather than the SDK data manager. The SDK manager's writes failed opaquely,
 * while the REST endpoint is CORS-allowed from extension origins, needs no SDK dependency,
 * and returns readable errors. (Feature Management, by contrast, is CORS-blocked  -  see
 * docs/05, which is why enablement is stored here.)
 *
 * Scope/isolation: the account-wide `Default/Current` scope is used, with a per-project
 * collection name `pages-{projectId}` for pages, and a fixed `pages` collection for the
 * organization-wide settings.
 *
 * Document ids: the REST service stores a document under a chosen id only when the body
 * includes `id`; every write therefore includes an explicit `id` (and a `kind`).
 */

const API_VERSION = "3.1-preview.1";

export interface PageMetadata {
  pageId: string;
  name: string;
  slug: string;
  order: number;
  enabled: boolean;
  hidden: boolean;
  comment: string;
  sizeBytes: number;
  contentVersion: number;
  updatedUtc: string;
  updatedBy: string;
}

export interface TrashEntry {
  trashId: string;
  deletedUtc: string;
  deletedBy: string;
  page: PageMetadata;
}

export interface PageIndex {
  id: "index";
  kind: "index";
  schemaVersion: number;
  revision: number;
  pages: PageMetadata[];
  // Deleted pages are retained here (metadata only) so they can be restored; their content
  // documents are kept until the entry is purged.
  trash?: TrashEntry[];
}

export interface ContentMeta {
  id: string;
  kind: "content-meta";
  schemaVersion: number;
  pageId: string;
  encoding: "identity" | "base64" | "gzip+base64";
  bytes: number;
  chunks: number;
  sha256: string;
  updatedUtc: string;
}

export interface ContentChunk {
  id: string;
  kind: "content";
  schemaVersion: number;
  pageId: string;
  index: number;
  data: string;
}

// Cached project id (resolved once from the web context).
let projectId = "";

/** Resolves and caches the current project id (empty on organization-level pages). */
export function currentProjectId(): string {
  if (!projectId) {
    const webContext = SDK.getWebContext();
    projectId = webContext && webContext.project ? webContext.project.id : "";
  }
  return projectId;
}

/** The organization name (used to build REST URLs). */
export function organizationName(): string {
  const host = SDK.getHost();
  return host && host.name ? host.name : "";
}

/** Per-project collection name for pages. */
function staticCollection(): string {
  const id = currentProjectId();
  if (!id) {
    throw new Error("Pages requires a project context (no project id was found).");
  }
  return `static-${id}`;
}

/** Base REST URL for a collection's documents. */
function documentsBase(collection: string): string {
  const context = SDK.getExtensionContext();
  const organization = organizationName();
  if (!organization || !context || !context.publisherId || !context.extensionId) {
    throw new Error("Cannot resolve the extension or organization for data access.");
  }
  return (
    `https://extmgmt.dev.azure.com/${organization}/_apis/ExtensionManagement/InstalledExtensions/` +
    `${context.publisherId}/${context.extensionId}/Data/Scopes/Default/Current/Collections/${collection}/Documents`
  );
}

/** Issues an authenticated request to the extension data REST API. */
async function dataRequest(method: string, url: string, body?: unknown): Promise<Response> {
  const token = await SDK.getAccessToken();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  return fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

/** GETs a document; returns null for 404 (absence is a valid state). */
async function getDocument(collection: string, id: string): Promise<Record<string, unknown> | null> {
  const response = await dataRequest("GET", `${documentsBase(collection)}/${id}?api-version=${API_VERSION}`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`GET ${collection}/${id} -> ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

/**
 * PUTs a document (creating or replacing it). The body's `id` is authoritative.
 *
 * Concurrency rationale: the service rejects an update to an existing document unless the
 * body carries the current `__etag` (HTTP 400 "document version does not match"). We
 * therefore read the existing document and carry its `__etag`, retrying once on a race.
 */
async function putDocument(collection: string, document: Record<string, unknown>): Promise<void> {
  const id = String(document.id || "");
  if (!id) {
    throw new Error("Cannot store a document without an id.");
  }
  const url = `${documentsBase(collection)}/${id}?api-version=${API_VERSION}`;
  const body: Record<string, unknown> = { ...document };

  if (body.__etag === undefined) {
    const existing = await getDocument(collection, id);
    if (existing && existing.__etag !== undefined) {
      body.__etag = existing.__etag;
    }
  }

  let response = await dataRequest("PUT", url, body);
  if (response.status === 400) {
    const text = await response.text();
    if (/version does not match/i.test(text)) {
      // Another writer changed the document; refresh the etag and retry once.
      const existing = await getDocument(collection, id);
      if (existing && existing.__etag !== undefined) {
        body.__etag = existing.__etag;
      }
      response = await dataRequest("PUT", url, body);
    } else {
      throw new Error(`PUT ${collection}/${id} -> 400 ${text}`);
    }
  }
  if (!response.ok) {
    throw new Error(`PUT ${collection}/${id} -> ${response.status} ${await response.text()}`);
  }
}

/** DELETEs a document, tolerating 404. */
async function deleteDocument(collection: string, id: string): Promise<void> {
  const response = await dataRequest("DELETE", `${documentsBase(collection)}/${id}?api-version=${API_VERSION}`);
  if (!response.ok && response.status !== 404) {
    throw new Error(`DELETE ${collection}/${id} -> ${response.status} ${await response.text()}`);
  }
}

/** LISTs a collection; an empty collection returns 404, treated as "no documents". */
async function listCollection(collection: string): Promise<Array<Record<string, unknown>>> {
  const response = await dataRequest("GET", `${documentsBase(collection)}?api-version=${API_VERSION}`);
  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    throw new Error(`LIST ${collection} -> ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as Array<Record<string, unknown>>;
  return Array.isArray(data) ? data : [];
}

/** Shape of an index when the project has no pages yet (avoids null checks upstream). */
export function emptyIndex(): PageIndex {
  return { id: "index", kind: "index", schemaVersion: 1, revision: 0, pages: [], trash: [] };
}

/** Reads the page index (metadata). Returns an empty index when none exists. */
export async function getIndex(): Promise<PageIndex> {
  try {
    const doc = await getDocument(staticCollection(), "index");
    return (doc as unknown as PageIndex) || emptyIndex();
  } catch (error) {
    logDebug("index unreadable; using empty index.", error);
    return emptyIndex();
  }
}

/** Writes the index, incrementing `revision` so callers can detect concurrent changes. */
export async function saveIndex(index: PageIndex): Promise<void> {
  const next: PageIndex = {
    ...index,
    id: "index",
    kind: "index",
    schemaVersion: 1,
    revision: (index.revision || 0) + 1
  };
  await putDocument(staticCollection(), next as unknown as Record<string, unknown>);
}

/** Deletes a document by id, tolerating absence. */
export async function deleteDocumentById(id: string): Promise<void> {
  try {
    await deleteDocument(staticCollection(), id);
  } catch (error) {
    logDebug("delete failed (document may be absent).", { id, error });
  }
}

/** Generates an opaque page id. The id is storage-only and never shown in URLs. */
export function newPageId(): string {
  const cryptoObj = window.crypto as Crypto | undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Creates an empty page in the index. Content is added later by the pipeline. */
export async function addPage(name: string, slug: string, comment = ""): Promise<PageIndex> {
  const next = addPageToIndex(await getIndex(), { pageId: newPageId(), name, slug, comment });
  await saveIndex(next);
  return next;
}

/** Applies a partial update to one page's metadata (rename, enable/hide, order, comment). */
export async function updatePage(pageId: string, patch: Partial<PageMetadata>): Promise<PageIndex> {
  const next = updatePageInIndex(await getIndex(), pageId, patch);
  await saveIndex(next);
  return next;
}

/** Moves a page to the trash (metadata retained; content kept until purged). */
export async function removePage(pageId: string): Promise<PageIndex> {
  const user = SDK.getUser();
  const next = removePageFromIndex(await getIndex(), pageId, {
    trashId: newPageId(),
    deletedUtc: new Date().toISOString(),
    deletedBy: user ? user.displayName : ""
  });
  await saveIndex(next);
  return next;
}

/** Restores a trashed page back into the index. */
export async function restorePage(trashId: string): Promise<PageIndex> {
  const next = restorePageInIndex(await getIndex(), trashId);
  await saveIndex(next);
  return next;
}

/** Permanently deletes one trash entry and its content. */
export async function purgeTrashEntry(trashId: string): Promise<PageIndex> {
  const result = purgeTrashInIndex(await getIndex(), trashId);
  if (result.pageId) {
    await deletePageContentDocs(result.pageId);
  }
  await saveIndex(result.index);
  return result.index;
}

/** Permanently deletes trash entries older than `days` (default 5). */
export async function purgeExpiredTrash(days = 5): Promise<PageIndex> {
  const index = await getIndex();
  const expired = expiredTrashEntries(index, Date.now(), days);
  if (expired.length === 0) {
    return index;
  }
  const result = removeTrashEntries(index, expired.map((entry) => entry.trashId));
  for (const pageId of result.pageIds) {
    await deletePageContentDocs(pageId);
  }
  await saveIndex(result.index);
  return result.index;
}

/** Clears a page's content (keeps the page) and resets its size/updated metadata. */
export async function clearPage(pageId: string): Promise<PageIndex> {
  await deletePageContentDocs(pageId);
  const next = clearPageInIndex(await getIndex(), pageId);
  await saveIndex(next);
  return next;
}

/** Removes a page's content-meta and all of its chunks (shared by delete and clear). */
async function deletePageContentDocs(pageId: string): Promise<void> {
  const meta = await getContentMeta(pageId);
  if (!meta) {
    return;
  }
  for (let i = 0; i < (meta.chunks || 0); i += 1) {
    await deleteDocumentById(`content-${pageId}-${i}`);
  }
  await deleteDocumentById(`content-meta-${pageId}`);
}

/** Lists every document in the project's collection. */
export async function listDocuments(): Promise<Array<Record<string, unknown>>> {
  try {
    return await listCollection(staticCollection());
  } catch (error) {
    logDebug("collection is empty or unreadable.", error);
    return [];
  }
}

/** Reads the content metadata for a page (chunk count/encoding), or null if unpublished. */
export async function getContentMeta(pageId: string): Promise<ContentMeta | null> {
  try {
    const doc = await getDocument(staticCollection(), `content-meta-${pageId}`);
    return (doc as unknown as ContentMeta) || null;
  } catch (error) {
    logDebug("content-meta not found.", { pageId, error });
    return null;
  }
}

/** Reads one content chunk; a missing chunk is treated as empty (defensive). */
async function getChunk(pageId: string, index: number): Promise<string> {
  try {
    const doc = (await getDocument(staticCollection(), `content-${pageId}-${index}`)) as unknown as ContentChunk;
    return doc && doc.data ? doc.data : "";
  } catch (error) {
    logDebug("chunk not found.", { pageId, index, error });
    return "";
  }
}

/** Loads and decodes a page's content by concatenating its chunks, or null when absent. */
export async function getPageContent(pageId: string): Promise<string | null> {
  const meta = await getContentMeta(pageId);
  if (!meta) {
    return null;
  }
  let joined = "";
  for (let i = 0; i < (meta.chunks || 0); i += 1) {
    joined += await getChunk(pageId, i);
  }
  return decodeContent(meta.encoding, joined);
}

/** Decodes stored content; `gzip+base64` uses the browser's DecompressionStream. */
export async function decodeContent(encoding: ContentMeta["encoding"], data: string): Promise<string> {
  if (!data) {
    return "";
  }
  if (encoding === "base64") {
    return textDecode(base64ToBytes(data));
  }
  if (encoding === "gzip+base64") {
    const bytes = base64ToBytes(data);
    if (typeof DecompressionStream !== "undefined") {
      const stream = new Blob([bytes as unknown as BlobPart])
        .stream()
        .pipeThrough(new DecompressionStream("gzip"));
      return await new Response(stream).text();
    }
    logDebug("DecompressionStream unavailable; gzip content cannot be decoded.");
    return "";
  }
  return data;
}

/** Decodes standard base64 to bytes without external dependencies. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** UTF-8 decodes a byte array. */
function textDecode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

// ---- Links (curated, in-project, bookmarkable links) ----------------------------------------

export interface LinkEntry {
  linkId: string;
  slug: string;
  title: string;
  url: string;
  comment: string;
  order: number;
  enabled: boolean;
  hidden: boolean;
  updatedUtc: string;
  updatedBy: string;
  // Optional dynamic resolution: the URL contains `{{dyn}}` and this spec resolves it.
  dynamic?: DynamicSpec;
  // Where the link came from: "fixed" for a stored (possibly out-of-project) URL, and
  // "pipeline" when published by the PublishLink task. Absent for legacy links.
  area?: string;
  source?: string;
}

export interface LinkTrashEntry {
  trashId: string;
  deletedUtc: string;
  deletedBy: string;
  link: LinkEntry;
}

export interface LinkIndex {
  id: "links";
  kind: "links";
  schemaVersion: number;
  revision: number;
  links: LinkEntry[];
  // Deleted links are retained (metadata only) so they can be restored within the window.
  trash?: LinkTrashEntry[];
}

/** Empty links index (project has no links yet). */
export function emptyLinks(): LinkIndex {
  return { id: "links", kind: "links", schemaVersion: 1, revision: 0, links: [], trash: [] };
}

/** Reads the links index; returns an empty index when none exists. */
export async function getLinks(): Promise<LinkIndex> {
  try {
    const doc = await getDocument(staticCollection(), "links");
    return (doc as unknown as LinkIndex) || emptyLinks();
  } catch (error) {
    logDebug("links index unreadable; using empty links.", error);
    return emptyLinks();
  }
}

/** Writes the links index, incrementing `revision`. */
export async function saveLinks(index: LinkIndex): Promise<void> {
  const next: LinkIndex = {
    ...index,
    id: "links",
    kind: "links",
    schemaVersion: 1,
    revision: (index.revision || 0) + 1
  };
  await putDocument(staticCollection(), next as unknown as Record<string, unknown>);
}

/** Case-insensitive slug reservation across live and trashed links. */
function linkSlugInUse(index: LinkIndex, slug: string): boolean {
  const needle = (slug || "").toLowerCase();
  return [...(index.links || []), ...(index.trash || []).map((entry) => entry.link)].some(
    (link) => link.slug.toLowerCase() === needle
  );
}

/** Creates a link; throws when its slug (live or trashed) is already taken. */
export async function addLink(
  title: string,
  slug: string,
  url: string,
  comment = "",
  dynamic?: DynamicSpec,
  area?: string
): Promise<LinkIndex> {
  const index = await getLinks();
  index.links = index.links || [];
  if (linkSlugInUse(index, slug)) {
    throw new Error(`The slug '${slug}' is already in use (including links in the trash).`);
  }
  index.links.push({
    linkId: newPageId(),
    slug,
    title,
    url,
    comment,
    order: index.links.length,
    enabled: true,
    hidden: false,
    updatedUtc: "",
    updatedBy: "",
    ...(dynamic ? { dynamic } : {}),
    ...(area ? { area } : {})
  });
  await saveLinks(index);
  return index;
}

/** Applies a partial update to one link. */
export async function updateLink(linkId: string, patch: Partial<LinkEntry>): Promise<LinkIndex> {
  const index = await getLinks();
  const link = (index.links || []).find((candidate) => candidate.linkId === linkId);
  if (link) {
    Object.assign(link, patch);
  }
  await saveLinks(index);
  return index;
}

/** Moves a link to the trash (metadata retained so it can be restored). */
export async function removeLink(linkId: string): Promise<LinkIndex> {
  const index = await getLinks();
  const link = (index.links || []).find((candidate) => candidate.linkId === linkId);
  if (!link) {
    return index;
  }
  index.links = (index.links || []).filter((candidate) => candidate.linkId !== linkId);
  index.trash = index.trash || [];
  const user = SDK.getUser();
  index.trash.push({
    trashId: newPageId(),
    deletedUtc: new Date().toISOString(),
    deletedBy: user ? user.displayName : "",
    link
  });
  await saveLinks(index);
  return index;
}

/** Restores a trashed link. */
export async function restoreLink(trashId: string): Promise<LinkIndex> {
  const index = await getLinks();
  const entry = (index.trash || []).find((candidate) => candidate.trashId === trashId);
  if (!entry) {
    return index;
  }
  index.trash = (index.trash || []).filter((candidate) => candidate.trashId !== trashId);
  index.links = index.links || [];
  entry.link.order = index.links.length;
  index.links.push(entry.link);
  await saveLinks(index);
  return index;
}

/** Permanently deletes one trashed link. */
export async function purgeLink(trashId: string): Promise<LinkIndex> {
  const index = await getLinks();
  if (!(index.trash || []).some((candidate) => candidate.trashId === trashId)) {
    return index;
  }
  index.trash = (index.trash || []).filter((candidate) => candidate.trashId !== trashId);
  await saveLinks(index);
  return index;
}

/** Permanently deletes trashed links older than `days` (default 5). */
export async function purgeExpiredLinks(days = 5): Promise<LinkIndex> {
  const index = await getLinks();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const expired = (index.trash || []).filter((entry) => Date.parse(entry.deletedUtc) < cutoff);
  if (expired.length === 0) {
    return index;
  }
  index.trash = (index.trash || []).filter((entry) => !expired.includes(entry));
  await saveLinks(index);
  return index;
}

// ---- Repository visibility (hide from the public Repos hub) ---------------------------------

const REPO_VISIBILITY_ID = "repos";

export interface RepoVisibility {
  id: "repos";
  kind: "repos";
  schemaVersion: number;
  revision: number;
  hiddenRepoIds: string[];
}

/** Reads the ids of repositories hidden from the public Repos hub. */
export async function getHiddenRepos(): Promise<string[]> {
  try {
    const doc = await getDocument(staticCollection(), REPO_VISIBILITY_ID);
    return ((doc as unknown as RepoVisibility) || { hiddenRepoIds: [] }).hiddenRepoIds || [];
  } catch (error) {
    logDebug("repository visibility unreadable.", error);
    return [];
  }
}

/** Hides or shows one repository in the public Repos hub. */
export async function setRepoHidden(repoId: string, hidden: boolean): Promise<void> {
  const existing = await getDocument(staticCollection(), REPO_VISIBILITY_ID).catch(() => null);
  const current: RepoVisibility =
    (existing as unknown as RepoVisibility) ||
    { id: "repos", kind: "repos", schemaVersion: 1, revision: 0, hiddenRepoIds: [] };
  const ids = new Set(current.hiddenRepoIds || []);
  if (hidden) {
    ids.add(repoId);
  } else {
    ids.delete(repoId);
  }
  const next: RepoVisibility = {
    ...current,
    id: "repos",
    kind: "repos",
    schemaVersion: 1,
    revision: (current.revision || 0) + 1,
    hiddenRepoIds: [...ids]
  };
  await putDocument(staticCollection(), next as unknown as Record<string, unknown>);
}

export interface ProjectInfo {
  id: string;
  name: string;
}

export interface ProjectStats {
  pages: number;
  links: number;
  pipelines: number;
  openPrs: number;
  repos: number;
  totalBytes: number;
  updatedUtc: string;
}

/**
 * Reads a project's page statistics (count, total size, latest update) for the organization
 * overview. Rationale: this makes the project list useful even though enablement is now
 * organization-wide.
 */
export async function getProjectStats(targetProjectId: string): Promise<ProjectStats> {
  const empty: ProjectStats = {
    pages: 0,
    links: 0,
    pipelines: 0,
    openPrs: 0,
    repos: 0,
    totalBytes: 0,
    updatedUtc: ""
  };
  try {
    const doc = await getDocument(`static-${targetProjectId}`, "index");
    const base = doc
      ? projectStats(doc as unknown as PageIndex)
      : { pages: 0, totalBytes: 0, updatedUtc: "" };

    // Links live in a separate document in the same collection.
    let links = 0;
    try {
      const linksDoc = await getDocument(`static-${targetProjectId}`, "links");
      links = ((linksDoc as unknown as LinkIndex) || { links: [] }).links?.length || 0;
    } catch (error) {
      logDebug("links unreadable for stats.", { targetProjectId, error });
    }

    // Repository and open-PR counts need a Git call per project (best-effort; never fail the row).
    let repos = 0;
    try {
      repos = await countProjectRepositories(targetProjectId);
    } catch (error) {
      logDebug("repository count unavailable.", { targetProjectId, error });
    }
    let openPrs = 0;
    try {
      openPrs = await countOpenPullRequests(targetProjectId);
    } catch (error) {
      logDebug("pull request count unavailable.", { targetProjectId, error });
    }
    let pipelines = 0;
    try {
      pipelines = await countPipelines(targetProjectId);
    } catch (error) {
      logDebug("pipeline count unavailable.", { targetProjectId, error });
    }

    return { ...base, links, pipelines, openPrs, repos };
  } catch (error) {
    logDebug("failed to read project stats.", { targetProjectId, error });
    return empty;
  }
}

/** Lists all projects in the organization (org-level admin page). */
export async function listProjects(): Promise<ProjectInfo[]> {
  const organization = organizationName();
  if (!organization) {
    throw new Error("Cannot list projects: the organization could not be resolved.");
  }
  const token = await SDK.getAccessToken();
  const url = `https://dev.azure.com/${organization}/_apis/projects?api-version=7.1&stateFilter=WellFormed&$top=1000`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`Failed to list projects: ${response.status} ${describeError(await response.text())}`);
  }
  const data = (await response.json()) as { value?: ProjectInfo[] };
  return data.value || [];
}
