// PublishLink task (Node 20).
//
// Rationale: a pipeline can publish a "fixed" link (a stored URL, e.g. a report or artifact
// hosted outside this project) the same way it publishes a page. The link lives in the project's
// `links` document in the same Extension Data collection the web extension reads, so it appears
// in the Links hub immediately. It is dependency-free (no task-lib) so the shipped task stays
// tiny, and every failure is reported with an actionable hint.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Slugs mirror the extension's validation (docs/02 FR-URL-4) so a task run cannot create a link
// the admin UI would then refuse to manage.
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
    if (status >= 500 && /TF400898|Internal Error/i.test(text || "")) {
        return "Azure DevOps returned an internal error while reading the extension data. This usually means the publisher/extension inputs do not match an installed edition ('static' for stable, 'static-dev' for dev); confirm the extension is installed for this organization.";
    }
    if (/version does not match/i.test(text || "")) {
        return "Concurrent update to the same link. Re-run the pipeline; the task retries automatically.";
    }
    if (status === 0) {
        return "Network failure reaching Azure DevOps. Check the agent's connectivity.";
    }
    return "";
}

/** Validates a link slug against the extension's rules, failing with guidance. */
function validateSlug(slug) {
    if (!SLUG_PATTERN.test(slug)) {
        fail(
            `Invalid link slug '${slug}'.`,
            "Use lowercase letters/numbers separated by single hyphens (e.g. 'latest-report')."
        );
    }
    if (RESERVED_SLUGS.includes(slug)) {
        fail(`The slug '${slug}' is reserved.`, "Choose a different slug.");
    }
}

/** Validates the stored URL: an absolute http(s) URL (it need not be in-project). */
function validateUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            fail(`Invalid URL '${url}'.`, "Only http(s) URLs are allowed.");
        }
    } catch (_error) {
        fail(`Invalid URL '${url}'.`, "Provide an absolute URL, e.g. https://host/report.html.");
    }
}

/**
 * Returns the first line of a text file. Rationale: a pipeline may write the URL to a file; the
 * importer must accept every line ending (CRLF, LF, CR) and a file with no trailing newline. A
 * leading UTF-8 BOM is stripped so it cannot corrupt the URL.
 */
function firstLine(filePath) {
    const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    const lines = text.split(/\r\n|\r|\n/);
    return (lines[0] || "").trim();
}

/** Extracts the organization name from a collection/org URL. */
function organizationFromUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.hostname === "dev.azure.com") {
            return parsed.pathname.split("/").filter(Boolean)[0];
        }
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
    } catch (_error) {
        fail(`GET ${url} returned invalid JSON.`, "Check the access token and the publisher/extension ids.");
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

main().catch((error) => {
    fail(
        `PublishLink failed: ${error && error.message ? error.message : String(error)}`,
        "See the errors above for the specific cause."
    );
});

/** Task entry point. */
async function main() {
    const title = input("title", true);
    const slug = input("slug", true);
    const rawUrl = input("url", false);
    const urlFile = input("urlFile", false);
    const comment = input("comment", false);
    const orgUrl = input("organizationUrl", true);
    const token = input("accessToken", true);
    const publisher = input("publisher", true, "f-steff");
    const extension = input("extension", true, "static");
    const createIfMissing = (input("createIfMissing", false, "true") + "").toLowerCase() !== "false";

    validateSlug(slug);
    // The URL comes from the input, or (when that is empty) from the first line of a file.
    let url = rawUrl;
    if (!url && urlFile) {
        const resolved = path.resolve(urlFile);
        if (!fs.existsSync(resolved)) {
            fail(
                `URL file not found: ${resolved}`,
                "Check the 'urlFile' input; it must point at a file the build produced."
            );
        }
        url = firstLine(resolved);
    }
    if (!url) {
        fail(
            "Provide 'url' or 'urlFile' (a file whose first line is the URL).",
            "Set one of the two task inputs."
        );
    }
    validateUrl(url);

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

    const index = (await getJson(`${base}/links?${api}`, headers)) || emptyLinks();

    // Find the link by slug, or create one when allowed.
    let link = (index.links || []).find((candidate) => candidate.slug.toLowerCase() === slug.toLowerCase());
    // A trashed link still reserves its slug (docs/02 FR-ADM-11); never silently duplicate it.
    const trashed = (index.trash || []).find(
        (entry) => entry && entry.link && entry.link.slug.toLowerCase() === slug.toLowerCase()
    );
    if (!link && trashed) {
        fail(
            `Link '${slug}' is in the trash and its slug is reserved.`,
            "Restore it, or delete it permanently, in Project settings -> Trash; then re-run."
        );
    }
    if (!link) {
        if (!createIfMissing) {
            fail(
                `Link '${slug}' does not exist and 'createIfMissing' is false.`,
                "Create it in Project settings -> Links, or set createIfMissing to true."
            );
        }
        link = {
            linkId: crypto.randomUUID(),
            slug,
            title,
            url,
            comment: "",
            order: (index.links || []).length,
            enabled: true,
            hidden: false,
            updatedUtc: "",
            updatedBy: ""
        };
        index.links = index.links || [];
        index.links.push(link);
    }

    // A pipeline-published link is always area "fixed"; remember its origin.
    link.title = title;
    link.url = url;
    link.area = "fixed";
    link.source = "pipeline";
    if (comment) {
        link.comment = comment;
    }
    link.updatedUtc = new Date().toISOString();
    link.updatedBy = process.env.BUILD_BUILDNUMBER ? `Build: ${process.env.BUILD_BUILDNUMBER}` : "pipeline";

    index.id = "links";
    index.kind = "links";
    index.schemaVersion = 1;
    index.revision = (index.revision || 0) + 1;
    await putJson(`${base}/links?${api}`, headers, index);

    console.log(`Published link '${slug}' -> ${url}`);
}

/** Shape of a links index when the project has no links yet. */
function emptyLinks() {
    return { id: "links", kind: "links", schemaVersion: 1, revision: 0, links: [], trash: [] };
}
