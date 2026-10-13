// Organization backup: export every project's Static data as one ZIP archive, and import it back.
//
// Rationale: extension data is scoped per extension id, so the stable and dev editions keep
// separate stores; one portable archive is how an organization is copied between them (for example
// to seed the dev edition before a release) and doubles as a backup. The archive holds one JSON
// document whose `projects` list mirrors the per-project collections, so every shape (pages,
// content chunks, links, trash, repository visibility) survives untouched.

import { ZipEntry, readZip, writeZip } from "./zip";

/** One stored document, as returned by the extension data service. */
export type StoredDocument = Record<string, unknown>;

/** One project's collection, as it travels inside a backup. */
export interface ProjectBundle {
  projectId: string;
  projectName: string;
  documents: StoredDocument[];
}

/** Recorded for reference: where a backup came from (never used for authorization). */
export interface BundleSource {
  publisher: string;
  extension: string;
  organization: string;
}

/** A portable snapshot of an organization's Static data. */
export interface ExportBundle {
  format: "static-export";
  schemaVersion: number;
  exportedUtc: string;
  source: BundleSource;
  projects: ProjectBundle[];
}

export const EXPORT_FORMAT = "static-export";
// 2 = organization-wide, shipped inside a ZIP archive (see BACKUP_ENTRY_NAME).
export const EXPORT_SCHEMA_VERSION = 2;
export const BACKUP_ENTRY_NAME = "static-backup.json";

/**
 * Builds a bundle from the projects' documents.
 * Rationale: `__etag` is a per-installation concurrency token; carrying it into another project or
 * edition would make the first write fail with "document version does not match", so it is dropped.
 */
export function buildBundle(
  projects: ProjectBundle[],
  source: BundleSource,
  now = new Date()
): ExportBundle {
  return {
    format: EXPORT_FORMAT,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedUtc: now.toISOString(),
    source: { ...source },
    projects: projects.map((project) => ({
      projectId: project.projectId,
      projectName: project.projectName,
      documents: (project.documents || []).map((document) => withoutEtag(document))
    }))
  };
}

/** Returns a copy of a document without the installation-specific `__etag` field. */
export function withoutEtag(document: StoredDocument): StoredDocument {
  const copy: StoredDocument = { ...document };
  delete copy.__etag;
  return copy;
}

/** Parsing outcome: the bundle, or a message the UI can show as-is. */
export type ParseResult = { ok: true; bundle: ExportBundle } | { ok: false; error: string };

/** Validates and parses a bundle. Never throws, so the caller can show a precise message. */
export function parseBundle(text: string): ParseResult {
  const trimmed = (text || "").trim();
  if (!trimmed) {
    return { ok: false, error: "The backup is empty." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "The backup's JSON could not be read." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "The file is not a Static backup." };
  }
  const candidate = parsed as Partial<ExportBundle>;
  if (candidate.format !== EXPORT_FORMAT) {
    return { ok: false, error: `Not a Static backup (expected format "${EXPORT_FORMAT}").` };
  }
  if (!Array.isArray(candidate.projects)) {
    return { ok: false, error: "The backup has no projects list." };
  }
  const projects: ProjectBundle[] = [];
  for (const entry of candidate.projects) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: "A project entry in the backup is not an object." };
    }
    const project = entry as Partial<ProjectBundle>;
    if (typeof project.projectId !== "string" || project.projectId.length === 0) {
      return { ok: false, error: "A project entry in the backup has no projectId." };
    }
    if (!Array.isArray(project.documents)) {
      return { ok: false, error: `Project ${project.projectId} has no documents list.` };
    }
    const documents: StoredDocument[] = [];
    for (const document of project.documents) {
      if (!document || typeof document !== "object" || Array.isArray(document)) {
        return {
          ok: false,
          error: `Project ${project.projectId} has a document that is not an object.`
        };
      }
      const stored = document as StoredDocument;
      if (typeof stored.id !== "string" || stored.id.length === 0) {
        return { ok: false, error: `Project ${project.projectId} has a document without a string id.` };
      }
      documents.push(withoutEtag(stored));
    }
    projects.push({
      projectId: project.projectId,
      projectName: typeof project.projectName === "string" ? project.projectName : "",
      documents
    });
  }
  const source = (candidate.source || {}) as Partial<BundleSource>;
  return {
    ok: true,
    bundle: {
      format: EXPORT_FORMAT,
      schemaVersion:
        typeof candidate.schemaVersion === "number" ? candidate.schemaVersion : EXPORT_SCHEMA_VERSION,
      exportedUtc: typeof candidate.exportedUtc === "string" ? candidate.exportedUtc : "",
      source: {
        publisher: source.publisher || "",
        extension: source.extension || "",
        organization: source.organization || ""
      },
      projects
    }
  };
}

/** Serializes a bundle into a ZIP archive (a single JSON entry). */
export function encodeBundle(bundle: ExportBundle, now = new Date()): Uint8Array {
  const json = JSON.stringify(bundle, null, 2);
  const entries: ZipEntry[] = [{ name: BACKUP_ENTRY_NAME, data: new TextEncoder().encode(json) }];
  return writeZip(entries, now);
}

/** Parses a ZIP archive produced by `encodeBundle`; returns a message when it is not one. */
export async function decodeBundle(bytes: Uint8Array): Promise<ParseResult> {
  let entries: Map<string, Uint8Array>;
  try {
    entries = await readZip(bytes);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "The file is not a valid ZIP archive."
    };
  }
  const entry = entries.get(BACKUP_ENTRY_NAME);
  if (!entry) {
    return { ok: false, error: `This ZIP does not contain ${BACKUP_ENTRY_NAME} (not a Static backup).` };
  }
  return parseBundle(new TextDecoder().decode(entry));
}

/** A short, filesystem-safe file name (e.g. `static-backup-contoso-2026-10-13.zip`). */
export function backupFileName(organization: string, now = new Date()): string {
  const slug = slugifyName(organization) || "organization";
  return `static-backup-${slug}-${now.toISOString().slice(0, 10)}.zip`;
}

/** Lowercases a name and reduces it to `[a-z0-9-]` so it is safe in a file name. */
function slugifyName(value: string): string {
  return (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
