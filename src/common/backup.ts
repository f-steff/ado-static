// Export/import of a project's Static data.
//
// Rationale: extension data is scoped per extension id, so the stable and dev editions keep
// separate stores; a portable JSON bundle lets a project's pages, links and settings be moved
// between them (for example to seed the dev edition before a release) and doubles as a backup.
// The bundle is a thin wrapper around the raw collection documents, so every document shape is
// preserved without the importer having to understand each one.

/** One stored document, as returned by the extension data service. */
export type StoredDocument = Record<string, unknown>;

/** Recorded for reference: where a bundle came from (never used for authorization). */
export interface BundleSource {
  publisher: string;
  extension: string;
  projectId: string;
  projectName: string;
}

/** A portable snapshot of one project's Static collection. */
export interface ExportBundle {
  format: "static-export";
  schemaVersion: number;
  exportedUtc: string;
  source: BundleSource;
  documents: StoredDocument[];
}

export const EXPORT_FORMAT = "static-export";
export const EXPORT_SCHEMA_VERSION = 1;

/**
 * Builds a bundle from the collection's documents.
 * Rationale: `__etag` is a per-installation concurrency token; carrying it into another project or
 * edition would make the first write fail with "document version does not match", so it is dropped.
 */
export function buildBundle(
  documents: StoredDocument[],
  source: BundleSource,
  now = new Date()
): ExportBundle {
  return {
    format: EXPORT_FORMAT,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedUtc: now.toISOString(),
    source: { ...source },
    documents: documents.map((document) => withoutEtag(document))
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
    return { ok: false, error: "Nothing to import: paste the export JSON or choose a file." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "That is not valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "The JSON is not a Static export bundle." };
  }
  const candidate = parsed as Partial<ExportBundle>;
  if (candidate.format !== EXPORT_FORMAT) {
    return { ok: false, error: `Not a Static export bundle (expected format "${EXPORT_FORMAT}").` };
  }
  if (!Array.isArray(candidate.documents)) {
    return { ok: false, error: "The bundle has no documents array." };
  }
  const documents: StoredDocument[] = [];
  for (const entry of candidate.documents) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: "A document in the bundle is not an object." };
    }
    const document = entry as StoredDocument;
    if (typeof document.id !== "string" || document.id.length === 0) {
      return { ok: false, error: "A document in the bundle has no string id." };
    }
    documents.push(withoutEtag(document));
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
        projectId: source.projectId || "",
        projectName: source.projectName || ""
      },
      documents
    }
  };
}

/** A short, filesystem-safe file name for an export (e.g. `static-my-project-2026-10-13.json`). */
export function bundleFileName(projectName: string, now = new Date()): string {
  const slug =
    (projectName || "project")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  return `static-${slug}-${now.toISOString().slice(0, 10)}.json`;
}
