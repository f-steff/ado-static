// StaticAdmin task (Node 20).
//
// Rationale: one task covers both directions of an organization backup, so a pipeline can move Static
// data between editions (for example seed `static-dev` from `static` before a release, or restore
// after a switch) with no manual step. It writes and reads exactly the archive the organization
// settings UI produces (see src/common/backup.ts), is dependency-free, and can attach the archive as
// a pipeline artifact in the same step.
//
// Error handling: every failure is reported with an actionable hint (token/permission, missing input,
// wrong publisher/extension, unreadable archive) so a pipeline author can fix it from the log.
const fs = require("fs");
const path = require("path");

const { ENTRY_NAME, buildBundle, parseBundle } = require("./bundle");
const { readZip, writeZip } = require("./zip");

const API_VERSION = "3.1-preview.1";

/** Reads a task input from the environment. Azure Pipelines maps inputs to INPUT_<NAME>. */
function input(name, required, fallback) {
    const value = process.env[`INPUT_${name.toUpperCase()}`] || fallback || "";
    if (required && !value) {
        fail(
            `Required input '${name}' is missing or empty.`,
            "Set the task input, or the pipeline variable it references (e.g. $(System.AccessToken))."
        );
    }
    return value;
}

/** Reads a boolean input; Azure Pipelines passes booleans as the strings "true"/"false". */
function boolInput(name, fallback) {
    const value = process.env[`INPUT_${name.toUpperCase()}`];
    if (value === undefined || value === "") {
        return fallback;
    }
    return /^(true|1|yes)$/i.test(value);
}

/** Emits a logged error (with an optional hint) and fails the task. */
function fail(message, hint) {
    console.error(`##vso[task.logissue type=error]${message}`);
    if (hint) {
        console.error(`##vso[task.logissue type=error]hint: ${hint}`);
    }
    process.exit(1);
}

/** Publishes a value as a task output variable so later steps can use it. */
function setVariable(name, value) {
    console.log(`##vso[task.setvariable variable=${name}]${value}`);
}

/**
 * Maps a failed HTTP status to an actionable hint.
 * Rationale: extmgmt answers 500 (TF400898) rather than 404 when the {publisher}/{extension} data
 * scope does not exist, which in practice almost always means the inputs name an edition that is not
 * installed (for example 'static' while only 'static-dev' is installed).
 */
function hintFor(status, text) {
    if (status === 401 || status === 403) {
        return "The token was rejected. Enable 'Allow scripts to access the OAuth token' on the pipeline and confirm the Static extension is installed and shared with this organization.";
    }
    if (status === 404) {
        return "The Static data was not found. Confirm the publisher/extension inputs name an installed edition ('static' for stable, 'static-dev' for dev) for this organization.";
    }
    if (status >= 500 && /TF400898|Internal Error/i.test(text || "")) {
        return "Azure DevOps returned an internal error while reading the extension data. This usually means the publisher/extension inputs do not match an installed edition ('static' for stable, 'static-dev' for dev).";
    }
    if (status === 0) {
        return "Network failure reaching Azure DevOps. Check the agent's connectivity.";
    }
    return "";
}

/** Extracts the organization name from a collection/org URL. */
function organizationFromUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.hostname === "dev.azure.com") {
            return parsed.pathname.split("/").filter(Boolean)[0];
        }
        // Legacy org.visualstudio.com form.
        return parsed.hostname.split(".")[0];
    } catch (error) {
        fail(
            `Invalid organizationUrl: '${url}'.`,
            "Use the full collection URL, e.g. https://dev.azure.com/{org} (the default $(System.CollectionUri))."
        );
        return "";
    }
}

/** GETs a JSON document; returns null for 404 (absence is a valid state). */
async function getJson(url, headers) {
    let response;
    try {
        response = await fetch(url, { headers });
    } catch (error) {
        fail(`GET ${url} failed: ${error && error.message ? error.message : error}`, hintFor(0, ""));
    }
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        const text = await response.text();
        fail(`GET ${url} -> ${response.status} ${text}`, hintFor(response.status, text));
    }
    return response.json();
}

/**
 * PUTs a JSON document, preserving the current `__etag` when replacing an existing one.
 * Rationale: the service rejects an update whose body lacks the current version
 * ("document version does not match"); we read the existing document and carry its `__etag`.
 */
async function putJson(url, headers, body) {
    const payload = { ...body };
    if (payload.__etag === undefined) {
        const existing = await getJson(url, headers);
        if (existing && existing.__etag !== undefined) {
            payload.__etag = existing.__etag;
        }
    }
    let response;
    try {
        response = await fetch(url, { method: "PUT", headers, body: JSON.stringify(payload) });
    } catch (error) {
        fail(`PUT ${url} failed: ${error && error.message ? error.message : error}`, hintFor(0, ""));
    }
    if (response.status === 400) {
        const text = await response.text();
        if (/version does not match/i.test(text)) {
            const existing = await getJson(url, headers);
            if (existing && existing.__etag !== undefined) {
                payload.__etag = existing.__etag;
            }
            response = await fetch(url, { method: "PUT", headers, body: JSON.stringify(payload) });
        } else {
            fail(`PUT ${url} -> 400 ${text}`, hintFor(400, text));
        }
    }
    if (!response.ok) {
        const text = await response.text();
        fail(`PUT ${url} -> ${response.status} ${text}`, hintFor(response.status, text));
    }
}

/** DELETEs a document, tolerating 404. */
async function deleteDocument(url, headers) {
    const response = await fetch(url, { method: "DELETE", headers });
    if (!response.ok && response.status !== 404) {
        const text = await response.text();
        fail(`DELETE ${url} -> ${response.status} ${text}`, hintFor(response.status, text));
    }
}

/** Base REST URL for one project's documents (the collection is per project id). */
function documentsBase(organization, publisher, extension, projectId) {
    return (
        `https://extmgmt.dev.azure.com/${organization}/_apis/ExtensionManagement/InstalledExtensions/` +
        `${publisher}/${extension}/Data/Scopes/Default/Current/Collections/static-${projectId}/Documents`
    );
}

/** Lists the organization's well-formed projects. */
async function listProjects(organization, headers) {
    const url = `https://dev.azure.com/${organization}/_apis/projects?api-version=7.1&stateFilter=WellFormed&$top=1000`;
    const data = await getJson(url, headers);
    return (data && data.value) || [];
}

/** LISTs one project's collection; an empty collection returns 404, treated as "no documents". */
async function listDocuments(base, headers) {
    const response = await fetch(`${base}?api-version=${API_VERSION}`, { headers });
    if (response.status === 404) {
        return [];
    }
    if (!response.ok) {
        const text = await response.text();
        fail(`LIST ${base} -> ${response.status} ${text}`, hintFor(response.status, text));
    }
    const data = await response.json();
    return Array.isArray(data) ? data : [];
}

/** Filters projects by a comma/space-separated list of ids or names (empty = every project). */
function selectProjects(all, filter) {
    const wanted = (filter || "")
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((value) => value.toLowerCase());
    if (wanted.length === 0) {
        return all;
    }
    return all.filter(
        (project) =>
            wanted.indexOf(String(project.id).toLowerCase()) >= 0 ||
            wanted.indexOf(String(project.name).toLowerCase()) >= 0
    );
}

/** Backup: read every selected project's collection and write one ZIP archive. */
async function doBackup(ctx) {
    const all = await listProjects(ctx.organization, ctx.headers);
    const selected = selectProjects(all, ctx.projects);
    if (selected.length === 0) {
        fail(
            "No projects matched the 'projects' input.",
            "Leave 'projects' empty to back up every project, or list project names/ids separated by commas."
        );
    }

    const bundles = [];
    let documents = 0;
    for (const project of selected) {
        const docs = await listDocuments(
            documentsBase(ctx.organization, ctx.publisher, ctx.extension, project.id),
            ctx.headers
        );
        if (docs.length > 0) {
            bundles.push({ projectId: project.id, projectName: project.name, documents: docs });
            documents += docs.length;
        }
        console.log(`Read ${project.name}: ${docs.length} document(s).`);
    }

    const bundle = buildBundle(bundles, {
        publisher: ctx.publisher,
        extension: ctx.extension,
        organization: ctx.organization
    });
    const archive = writeZip([
        { name: ENTRY_NAME, data: Buffer.from(JSON.stringify(bundle, null, 2), "utf8") }
    ]);
    fs.mkdirSync(path.dirname(ctx.backupPath), { recursive: true });
    fs.writeFileSync(ctx.backupPath, archive);
    console.log(
        `Wrote ${archive.length} byte(s) to ${ctx.backupPath} ` +
            `(${bundles.length} project(s), ${documents} document(s)).`
    );
    setVariable("StaticBackupProjects", bundles.length);
    setVariable("StaticBackupDocuments", documents);

    // Attach the archive as a pipeline artifact in the same step, so a separate publish task is not
    // needed; the agent copies the file into a container artifact built from the staging folder.
    if (ctx.artifactName) {
        const artifactPath = ctx.backupPath.split(path.sep).join("/");
        console.log(
            `##vso[artifact.upload containerfolder=${ctx.artifactName};artifactname=${ctx.artifactName}]${artifactPath}`
        );
    }
}

/** Restore: read a ZIP archive and write its documents into the existing projects. */
async function doRestore(ctx) {
    if (!fs.existsSync(ctx.backupPath)) {
        fail(
            `The backup file '${ctx.backupPath}' does not exist.`,
            "Download the artifact first (DownloadPipelineArtifact), or point 'backupPath' at an archive produced by a backup run."
        );
    }

    let entries;
    try {
        entries = readZip(fs.readFileSync(ctx.backupPath));
    } catch (error) {
        fail(
            `Cannot read '${ctx.backupPath}': ${error && error.message ? error.message : error}`,
            "Choose a ZIP produced by a StaticAdmin backup (or by Static settings -> Backup)."
        );
    }
    const entry = entries.get(ENTRY_NAME);
    if (!entry) {
        fail(
            `The archive does not contain ${ENTRY_NAME}.`,
            "Choose a ZIP produced by a StaticAdmin backup (or by Static settings -> Backup)."
        );
    }
    const parsed = parseBundle(entry.toString("utf8"));
    if (!parsed.ok) {
        fail(`The backup is not usable: ${parsed.error}`, "Restore a backup produced by Static.");
    }

    const all = await listProjects(ctx.organization, ctx.headers);
    const byId = new Map(all.map((project) => [project.id, project]));
    const targets = parsed.bundle.projects.filter((project) => byId.has(project.projectId));
    const skipped = parsed.bundle.projects.length - targets.length;
    const documents = targets.reduce((sum, project) => sum + project.documents.length, 0);
    if (targets.length === 0) {
        fail(
            "None of the projects in the backup exist in this organization.",
            "Check that the backup and the 'organizationUrl' belong to the same organization."
        );
    }

    if (ctx.dryRun) {
        console.log(`Dry run: would restore ${targets.length} project(s), ${documents} document(s); no writes were made.`);
        targets.forEach((project) =>
            console.log(`  ${byId.get(project.projectId).name}: ${project.documents.length} document(s)`)
        );
        return;
    }

    for (const project of targets) {
        const name = byId.get(project.projectId).name;
        console.log(`Restoring ${name}...`);
        const base = documentsBase(ctx.organization, ctx.publisher, ctx.extension, project.projectId);
        const existing = await listDocuments(base, ctx.headers);
        const keep = new Set(project.documents.map((document) => String(document.id)));

        for (const document of project.documents) {
            await putJson(`${base}/${document.id}?api-version=${API_VERSION}`, ctx.headers, document);
        }
        // Replace semantics: documents the backup does not contain are removed, so the project ends up
        // exactly like the backup - that is what makes switching editions predictable.
        let removed = 0;
        for (const document of existing) {
            const id = String(document.id || "");
            if (id && !keep.has(id)) {
                await deleteDocument(`${base}/${id}?api-version=${API_VERSION}`, ctx.headers);
                removed += 1;
            }
        }
        console.log(`  wrote ${project.documents.length} document(s), removed ${removed}.`);
    }

    console.log(
        `Restored ${targets.length} project(s), ${documents} document(s).` +
            (skipped > 0 ? ` Skipped ${skipped} project(s) that no longer exist.` : "")
    );
    setVariable("StaticRestoreProjects", targets.length);
}

/** Entry point: dispatch on `mode`. */
async function main() {
    const mode = input("mode", true);
    const organization = organizationFromUrl(input("organizationUrl", true));
    const token = input("accessToken", true);
    const publisher = input("publisher", true, "f-steff");
    const requestedExtension = input("extension", true, "auto");
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    // The edition may be left at 'auto': probe which Marketplace edition is installed so one pipeline
    // works unchanged in a test organization (dev) and in production (stable). The probe needs a
    // project id, and the pipeline's own project is the natural one.
    const extension = await resolveExtension(
        requestedExtension,
        organization,
        publisher,
        process.env.SYSTEM_TEAMPROJECTID || "",
        headers
    );
    const ctx = {
        organization,
        publisher,
        extension,
        headers,
        backupPath: path.resolve(input("backupPath", true)),
        projects: input("projects", false),
        artifactName: input("artifactName", false),
        dryRun: boolInput("dryRun", false)
    };

    if (mode === "backup") {
        await doBackup(ctx);
    } else if (mode === "restore") {
        await doRestore(ctx);
    } else {
        fail(`Unknown mode '${mode}'.`, "Use 'backup' or 'restore'.");
    }
}

// Only run when executed as the task; requiring the file (tests) must not run main.
if (require.main === module) {
    main().catch((error) => {
        fail(`StaticAdmin failed: ${error && error.message ? error.message : error}`);
    });
}

/**
 * Pure choice for the 'auto' edition.
 * Rationale: exactly one installed edition wins; when both are installed the stable edition is used
 * and a warning tells the author to pin the input; when none is installed the caller fails with the
 * install hint. Keeping the decision pure makes it testable without a network probe.
 */
function autoEditionChoice(hasStatic, hasDev) {
    if (hasStatic && hasDev) {
        return {
            extension: "static",
            warning:
                "Both Static editions are installed; using 'static'. Set the 'extension' input to pin one ('static' or 'static-dev')."
        };
    }
    if (hasStatic) {
        return { extension: "static", warning: "" };
    }
    if (hasDev) {
        return { extension: "static-dev", warning: "" };
    }
    return { extension: "", warning: "" };
}

/** True when an edition's data scope exists (an installed but empty collection answers 404). */
async function editionInstalled(organization, publisher, extension, projectId, headers) {
    const url =
        `https://extmgmt.dev.azure.com/${organization}/_apis/ExtensionManagement/InstalledExtensions/` +
        `${publisher}/${extension}/Data/Scopes/Default/Current/Collections/static-${projectId}/Documents?api-version=3.1-preview.1`;
    const response = await fetch(url, { headers });
    if (response.ok || response.status === 404) {
        return true;
    }
    if (response.status === 401 || response.status === 403) {
        fail(`GET ${url} -> ${response.status}`, hintFor(response.status, ""));
    }
    // A missing data scope is reported as a 500 internal error (TF400898) rather than a 404.
    return false;
}

/** Resolves the edition: an explicit input, or 'auto' (whichever edition is installed here). */
async function resolveExtension(explicit, organization, publisher, projectId, headers) {
    const value = (explicit || "").trim();
    if (value && value.toLowerCase() !== "auto") {
        return value;
    }
    if (!projectId) {
        fail(
            "Cannot auto-detect the Static edition without a project id.",
            "Run the task inside a pipeline, or set the 'extension' input explicitly ('static' or 'static-dev')."
        );
    }
    const hasStatic = await editionInstalled(organization, publisher, "static", projectId, headers);
    const hasDev = await editionInstalled(organization, publisher, "static-dev", projectId, headers);
    const choice = autoEditionChoice(hasStatic, hasDev);
    if (!choice.extension) {
        fail(
            `Neither '${publisher}.static' nor '${publisher}.static-dev' is installed for this organization.`,
            "Install the Static extension (Organization settings -> Extensions), or set the 'extension' input."
        );
    }
    if (choice.warning) {
        console.warn(`##vso[task.logissue type=warning]${choice.warning}`);
    }
    console.log(`Using Static edition '${choice.extension}'.`);
    // Exposed so later steps (and the log reader) can see which edition was chosen.
    console.log(`##vso[task.setvariable variable=StaticExtension]${choice.extension}`);
    return choice.extension;
}

module.exports = { autoEditionChoice };
