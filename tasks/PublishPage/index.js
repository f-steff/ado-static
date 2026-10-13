// PublishPage task (Node 20).
//
// Rationale: this is the only supported writer of page content. Pipeline-produced HTML is
// gzipped, base64-encoded, chunked below the Extension Data per-document limit, and stored
// as content documents; the page index is then updated with size/comment/updated metadata.
// It is dependency-free (no task-lib) so the shipped task folder stays tiny.
//
// Error handling: every failure is reported with an actionable hint (token/permission,
// missing input, reserved/trashed slug, document size, concurrency) so a pipeline author can
// fix it without reading the source.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

// The service rejects a stored document above ~5 MiB (see docs/04); keep a small safety margin.
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
// Slugs mirror the extension's validation (docs/02 FR-URL-4) so a task run cannot create an
// unusable page that the admin UI would then refuse to manage.
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_SLUGS = ["pages"];

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

/** Emits a logged error (with an optional hint) and fails the task. */
function fail(message, hint) {
    console.error(`##vso[task.logissue type=error]${message}`);
    if (hint) {
        console.error(`##vso[task.logissue type=error]hint: ${hint}`);
    }
    process.exit(1);
}

/**
 * Maps a failed HTTP status to an actionable hint.
 * Rationale: extmgmt answers 500 (TF400898) rather than 404 when the {publisher}/{extension} data
 * scope does not exist, which in practice almost always means the inputs name an edition that is
 * not installed (e.g. 'static' while only 'static-dev' is installed); say so instead of failing
 * with an opaque internal error.
 */
function hintFor(status, text) {
    if (status === 401 || status === 403) {
        return "The token was rejected. Enable 'Allow scripts to access the OAuth token' on the pipeline and confirm the Static extension is installed and shared with this organization.";
    }
    if (status === 404) {
        return "The Static data collection was not found. Confirm the publisher/extension inputs name an installed edition ('static' for stable, 'static-dev' for dev) for this organization.";
    }
    if (status >= 500 && /MaximumDocumentSize|too large/i.test(text || "")) {
        return "A stored document exceeded the service limit. Lower the 'chunkSizeKb' input (e.g. 1024).";
    }
    if (status >= 500 && /TF400898|Internal Error/i.test(text || "")) {
        return "Azure DevOps returned an internal error while reading the extension data. This usually means the publisher/extension inputs do not match an installed edition ('static' for stable, 'static-dev' for dev); confirm the extension is installed for this organization.";
    }
    if (/version does not match/i.test(text || "")) {
        return "Concurrent update to the same page. Re-run the pipeline; the task retries automatically.";
    }
    if (status === 0) {
        return "Network failure reaching Azure DevOps. Check the agent's connectivity.";
    }
    return "";
}

/** Validates a page slug against the extension's rules, failing with guidance. */
function validateSlug(slug) {
    if (!SLUG_PATTERN.test(slug)) {
        fail(
            `Invalid page slug '${slug}'.`,
            "Use lowercase letters/numbers separated by single hyphens (e.g. 'my-report')."
        );
    }
    if (RESERVED_SLUGS.includes(slug)) {
        fail(`The page slug '${slug}' is reserved.`, "Choose a different slug.");
    }
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
    } catch (_error) {
        fail(
            `Invalid organizationUrl: '${url}'.`,
            "Use the full collection URL, e.g. https://dev.azure.com/{org} (the default $(System.CollectionUri))."
        );
        return "";
    }
}

/** Parses a JSON response, failing with an auth/format hint when the body is not JSON. */
async function readJson(response, url) {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.indexOf("application/json") < 0) {
        const text = await response.text().catch(() => "");
        fail(
            `GET ${url} returned a non-JSON response (status ${response.status}).`,
            hintFor(response.status >= 400 ? response.status : 401, text) ||
                "The endpoint returned a sign-in page, which usually means the access token is missing, expired, or lacks permission."
        );
    }
    try {
        return await response.json();
    } catch (error) {
        fail(
            `GET ${url} returned invalid JSON.`,
            "Check the access token and the publisher/extension ids."
        );
    }
}

/** GETs a JSON document; returns null for 404 (absence is a valid state here). */
async function getJson(url, headers) {
    let response;
    try {
        response = await fetch(url, { headers });
    } catch (error) {
        fail(`GET ${url} failed: ${error && error.message ? error.message : error}`, hintFor(0));
    }
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        const text = await response.text();
        fail(`GET ${url} -> ${response.status} ${text}`, hintFor(response.status, text));
    }
    return readJson(response, url);
}

/**
 * PUTs a JSON document, preserving the current `__etag` when updating an existing one.
 * Rationale: the service rejects updates whose body lacks the current version
 * (HTTP 400 "document version does not match"). We read the existing document, carry its
 * `__etag`, and retry once on a race.
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
        fail(`PUT ${url} failed: ${error && error.message ? error.message : error}`, hintFor(0));
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
    return response.json().catch(() => null);
}

/** DELETEs a document, tolerating 404 (used to trim obsolete chunks). */
async function deleteDoc(url, headers) {
    let response;
    try {
        response = await fetch(url, { method: "DELETE", headers });
    } catch (error) {
        fail(`DELETE ${url} failed: ${error && error.message ? error.message : error}`, hintFor(0));
    }
    if (!response.ok && response.status !== 404) {
        fail(`DELETE ${url} -> ${response.status}`, hintFor(response.status, ""));
    }
}

main().catch((error) => {
    fail(
        `PublishPage failed: ${error && error.message ? error.message : String(error)}`,
        "See the errors above for the specific cause."
    );
});

/** Task entry point. */
async function main() {
    const page = input("page", false);
    const sourcePath = input("sourcePath", true);
    const comment = input("comment", false);
    const tabName = input("tabName", false);
    const orgUrl = input("organizationUrl", true);
    const token = input("accessToken", true);
    const publisher = input("publisher", true, "f-steff");
    const extension = input("extension", true, "static");
    const chunkBytes = parseInt(input("chunkSizeKb", false, "3072"), 10) * 1024;
    const createIfMissing = (input("createIfMissing", false, "true") + "").toLowerCase() !== "false";

    // The task publishes two independent things: a page (enabled by `page`) and a build tab
    // (enabled by `tabName`). Set at least one; with both, both are published.
    if (!page && !tabName) {
        fail(
            "Nothing to publish: set 'page' (publish a page) and/or 'tabName' (publish a build tab).",
            "Set at least one of the two enablers."
        );
    }
    // Validate the slug early so a bad name fails before any write.
    if (page) {
        validateSlug(page);
    }

    // The source file is required for both outputs (page content and build attachment).
    const filePath = path.resolve(sourcePath);
    if (!fs.existsSync(filePath)) {
        fail(
            `Content file not found: ${filePath}`,
            "Check the 'sourcePath' input; it must point at a file the build produced (e.g. $(Build.ArtifactStagingDirectory)/page/index.html)."
        );
    }

    // The project id scopes the collection (mirrors the web extension's `pages-{projectId}`).
    const projectId = process.env.SYSTEM_TEAMPROJECTID || "";
    if (!projectId) {
        fail(
            "SYSTEM_TEAMPROJECTID is not set; cannot resolve the project collection.",
            "Run the task inside a pipeline (this variable is provided by the agent)."
        );
    }

    const organization = organizationFromUrl(orgUrl);
    const collection = `static-${projectId}`;
    const base = `https://extmgmt.dev.azure.com/${organization}/_apis/ExtensionManagement/InstalledExtensions/${publisher}/${extension}/Data/Scopes/Default/Current/Collections/${collection}/Documents`;
    const api = "api-version=3.1-preview.1";
    const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
    };

    // Publish the page only when the `page` enabler is set.
    if (page) {
        // Read and compress the source; sizes are reported on the decoded bytes.
        const original = fs.readFileSync(filePath);
        if (original.length === 0) {
            console.warn("##vso[task.logissue type=warning]The content file is empty; the page will have no content.");
        }
        const gzipped = zlib.gzipSync(original);
        const sha256 = crypto.createHash("sha256").update(original).digest("hex");

        // Chunk the compressed bytes so each stored document stays under the size limit.
        const chunks = [];
        for (let offset = 0; offset < gzipped.length; offset += chunkBytes) {
            chunks.push(gzipped.subarray(offset, offset + chunkBytes).toString("base64"));
        }
        if (chunks.length === 0) {
            chunks.push("");
        }
        // Fail early with a clear hint instead of a server 500 after partial writes.
        for (let i = 0; i < chunks.length; i += 1) {
            if (Buffer.byteLength(chunks[i], "utf8") + 512 > MAX_DOCUMENT_BYTES) {
                fail(
                    `Chunk ${i} would exceed the per-document limit (${chunks[i].length} base64 bytes).`,
                    "Lower the 'chunkSizeKb' input (e.g. 1024)."
                );
            }
        }

        const index = (await getJson(`${base}/index?${api}`, headers)) || emptyIndex();

        // Find the page by slug, or create an empty one when allowed.
        let pageMeta = (index.pages || []).find(
            (candidate) => candidate.slug.toLowerCase() === page.toLowerCase()
        );
        // A trashed page still reserves its slug (docs/02 FR-ADM-11); never silently duplicate it.
        const trashed = (index.trash || []).find(
            (entry) => entry && entry.page && entry.page.slug.toLowerCase() === page.toLowerCase()
        );
        if (!pageMeta && trashed) {
            fail(
                `Page '${page}' is in the trash and its slug is reserved.`,
                "Restore it, or delete it permanently, in Project settings -> Pages -> Trash; then re-run."
            );
        }
        if (!pageMeta) {
            if (!createIfMissing) {
                fail(
                    `Page '${page}' does not exist and 'createIfMissing' is false.`,
                    "Create it in Project settings -> Pages, or set createIfMissing to true."
                );
            }
            pageMeta = {
                pageId: crypto.randomUUID(),
                name: page,
                slug: page,
                order: (index.pages || []).length,
                enabled: true,
                hidden: false,
                comment: "",
                sizeBytes: 0,
                contentVersion: 0,
                updatedUtc: "",
                updatedBy: ""
            };
            index.pages = index.pages || [];
            index.pages.push(pageMeta);
        }
        const pageId = pageMeta.pageId;

        // Capture the previous meta so obsolete chunks can be removed after a shrink.
        const previousMeta = await getJson(`${base}/content-meta-${pageId}?${api}`, headers);

        // Order matters: content chunks first, then meta, then the index. A reader never sees
        // meta that points at missing chunks (see docs/04).
        for (let i = 0; i < chunks.length; i += 1) {
            await putJson(`${base}/content-${pageId}-${i}?${api}`, headers, {
                id: `content-${pageId}-${i}`,
                kind: "content",
                schemaVersion: 1,
                pageId,
                index: i,
                data: chunks[i]
            });
        }

        await putJson(`${base}/content-meta-${pageId}?${api}`, headers, {
            id: `content-meta-${pageId}`,
            kind: "content-meta",
            schemaVersion: 1,
            pageId,
            encoding: "gzip+base64",
            bytes: original.length,
            chunks: chunks.length,
            sha256,
            updatedUtc: new Date().toISOString()
        });

        if (previousMeta && previousMeta.chunks > chunks.length) {
            for (let i = chunks.length; i < previousMeta.chunks; i += 1) {
                await deleteDoc(`${base}/content-${pageId}-${i}?${api}`, headers);
            }
        }

        // Update the page metadata last, so the visible size/comment/updated reflect the content.
        pageMeta.sizeBytes = original.length;
        if (comment) {
            pageMeta.comment = comment;
        }
        pageMeta.contentVersion = (pageMeta.contentVersion || 0) + 1;
        pageMeta.updatedUtc = new Date().toISOString();
        pageMeta.updatedBy = process.env.BUILD_BUILDNUMBER
            ? `Build: ${process.env.BUILD_BUILDNUMBER}`
            : "pipeline";

        index.id = "index";
        index.kind = "index";
        index.schemaVersion = 1;
        index.revision = (index.revision || 0) + 1;
        await putJson(`${base}/index?${api}`, headers, index);

        console.log(
            `Published page '${page}' (${original.length} bytes, ${chunks.length} chunk(s)).`
        );
    }

    // Publish the build tab only when the `tabName` enabler is set. The attachment type is
    // distinct from the Html Reports extension, so the two never show each other's reports.
    if (tabName) {
        emitAttachment("static-page-html", attachmentName(tabName, filePath), filePath);
        console.log(`Attached '${tabName}' to the build for the Static page tab.`);
    }
}

/** Emits the Azure Pipelines add-attachment logging command (values are %-escaped). */
function emitAttachment(type, name, file) {
    const escape = (value) =>
        String(value)
            .replace(/%/g, "%25")
            .replace(/\r/g, "%0D")
            .replace(/\n/g, "%0A")
            .replace(/]/g, "%5D")
            .replace(/;/g, "%3B");
    console.log(`##vso[task.addattachment type=${escape(type)};name=${escape(name)};]${file}`);
}

/** Builds the attachment name "<tab>~<job>~<stage>~<attempt>~<file>" the tab UI understands. */
function attachmentName(tabName, file) {
    const dashify = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const job = dashify(process.env.AGENT_JOBNAME);
    const stage = dashify(process.env.SYSTEM_STAGEDISPLAYNAME) || "__default";
    const attempt = process.env.SYSTEM_STAGEATTEMPT || "1";
    const base = path.basename(file);
    return `${tabName}~${job}~${stage}~${attempt}~${base}`;
}

/** Shape of an index when the project has no pages yet. */
function emptyIndex() {
    return { id: "index", kind: "index", schemaVersion: 1, revision: 0, pages: [], trash: [] };
}
