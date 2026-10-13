// Backup bundle shape for the StaticAdmin task.
//
// Rationale: the task and the organization settings UI must agree on the archive's contents, so this
// mirrors src/common/backup.ts exactly (format / schemaVersion / source / projects). The two cannot
// share code because the task is plain Node and the UI is bundled for the browser, so keep the two
// in step whenever the shape changes.

const FORMAT = "static-export";
// 2 = organization-wide, shipped inside a ZIP under ENTRY_NAME.
const SCHEMA_VERSION = 2;
const ENTRY_NAME = "static-backup.json";

/** Returns a copy of a document without the installation-specific `__etag` field. */
function withoutEtag(document) {
    const copy = { ...document };
    delete copy.__etag;
    return copy;
}

/**
 * Builds a bundle from the projects' documents.
 * Rationale: `__etag` is a per-installation concurrency token; carrying it into another project or
 * edition would make the first write fail with "document version does not match", so it is dropped.
 */
function buildBundle(projects, source, now = new Date()) {
    return {
        format: FORMAT,
        schemaVersion: SCHEMA_VERSION,
        exportedUtc: now.toISOString(),
        source: { ...source },
        projects: projects.map((project) => ({
            projectId: project.projectId,
            projectName: project.projectName,
            documents: (project.documents || []).map((document) => withoutEtag(document))
        }))
    };
}

/** Validates and parses a bundle; returns `{ ok: true, bundle }` or `{ ok: false, error }`. */
function parseBundle(text) {
    const trimmed = (text || "").trim();
    if (!trimmed) {
        return { ok: false, error: "The backup is empty." };
    }
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    } catch (_error) {
        return { ok: false, error: "The backup's JSON could not be read." };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "The file is not a Static backup." };
    }
    if (parsed.format !== FORMAT) {
        return { ok: false, error: `Not a Static backup (expected format "${FORMAT}").` };
    }
    if (!Array.isArray(parsed.projects)) {
        return { ok: false, error: "The backup has no projects list." };
    }
    const projects = [];
    for (const entry of parsed.projects) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return { ok: false, error: "A project entry in the backup is not an object." };
        }
        if (typeof entry.projectId !== "string" || entry.projectId.length === 0) {
            return { ok: false, error: "A project entry in the backup has no projectId." };
        }
        if (!Array.isArray(entry.documents)) {
            return { ok: false, error: `Project ${entry.projectId} has no documents list.` };
        }
        const documents = [];
        for (const document of entry.documents) {
            if (!document || typeof document !== "object" || Array.isArray(document)) {
                return { ok: false, error: `Project ${entry.projectId} has a document that is not an object.` };
            }
            if (typeof document.id !== "string" || document.id.length === 0) {
                return { ok: false, error: `Project ${entry.projectId} has a document without a string id.` };
            }
            documents.push(withoutEtag(document));
        }
        projects.push({
            projectId: entry.projectId,
            projectName: typeof entry.projectName === "string" ? entry.projectName : "",
            documents
        });
    }
    const source = parsed.source || {};
    return {
        ok: true,
        bundle: {
            format: FORMAT,
            schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : SCHEMA_VERSION,
            exportedUtc: typeof parsed.exportedUtc === "string" ? parsed.exportedUtc : "",
            source: {
                publisher: source.publisher || "",
                extension: source.extension || "",
                organization: source.organization || ""
            },
            projects
        }
    };
}

module.exports = { ENTRY_NAME, FORMAT, SCHEMA_VERSION, buildBundle, parseBundle, withoutEtag };
