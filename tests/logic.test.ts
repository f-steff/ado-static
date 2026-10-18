// Unit tests for the pure logic that does not need the Azure DevOps host.
//
// Rationale: these run fast in Node (bundled by scripts/test.js) and catch regressions in
// formatting, slug validation, and the Feature Management URL shape without a browser.
import test from "node:test";
import assert from "node:assert/strict";

import { addContribution, firstName, topContributor } from "../src/common/contributors";
import { checkProjectUrl, describeProjectUrl } from "../src/common/ado-url";
import {
    DYNAMIC_TOKEN,
    LOG_JOB_TOKEN,
    LOG_STAGE_TOKEN,
    applyToken,
    applyTokens,
    detectDynamicPart,
    hasAnyToken,
    hasToken,
    normalizeTokens,
    tokenizeUrl,
} from "../src/common/dynamic-links";
import { filterByName, matchesFilter } from "../src/common/filter";
import { findActionBit, readPermissionValue } from "../src/common/permission-parse";
import { buildViewSpecs, composePath, consumedParams, isFixedArea, targetMatches, viewKeyForValue } from "../src/common/builder-core";
import { buildBundle, backupFileName, decodeBundle, encodeBundle, parseBundle } from "../src/common/backup";
import { crc32, readZip, writeZip } from "../src/common/zip";
import { acceptablePrefillUrl, addLinkBookmarklet, fixedUrlError, isHttpUrl, linkAreaLabel } from "../src/common/link-url";
import { describeError } from "../src/common/log";
import { isValidPullRequestId, pullRequestWebUrl } from "../src/common/pr-url";
import { formatBytes, formatBytesWhole, formatRelativeTime } from "../src/common/format";
import {
    addPageToIndex,
    clearPageInIndex,
    expiredTrashEntries,
    projectStats,
    purgeTrashInIndex,
    removePageFromIndex,
    removeTrashEntries,
    restorePageInIndex,
    slugInUse,
    trashExpiryUtc,
    updatePageInIndex
} from "../src/common/index-logic";
import {
    encodeQuery,
    hubUrl,
    orgSettingsUrl,
    projectSettingsUrl,
    withQueryParam
} from "../src/common/urls";
import { featureStateUrl, slugError, slugify } from "../src/common/validation";
import { byOrderThenTitle, acceptanceError, mergedRows, pendingLabel, proposalFor, promotionFields, reconcile, slugTaken } from "../src/common/private-links";
import type { LinkEntry, LinkIndex, LinkProposal, PageIndex, PageMetadata, TrashEntry } from "../src/common/data-service";

/** Builds a page with sensible defaults so tests can override only what they assert. */
function makePage(overrides: Partial<PageMetadata> = {}): PageMetadata {
    return {
        pageId: "p1",
        name: "Page",
        slug: "page",
        order: 0,
        enabled: true,
        hidden: false,
        comment: "",
        sizeBytes: 0,
        contentVersion: 0,
        updatedUtc: "",
        updatedBy: "",
        ...overrides
    };
}

/** Builds an index from explicit pages/trash (all mutations return copies, so inputs stay safe). */
function makeIndex(pages: PageMetadata[] = [], trash: TrashEntry[] = []): PageIndex {
    return { id: "index", kind: "index", schemaVersion: 1, revision: 0, pages, trash };
}

test("formatBytes uses 1024-based IEC units", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(undefined), "0 B");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1024), "1.0 KiB");
    assert.equal(formatBytes(1536), "1.5 KiB");
    assert.equal(formatBytes(1048576), "1.0 MiB");
    assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MiB");
});

test("slugError accepts valid, unique slugs", () => {
    assert.equal(slugError("my-report", [], false), "");
    assert.equal(slugError("report-2026", ["other"], false), "");
});

test("slugError rejects malformed slugs", () => {
    assert.match(slugError("My Report", [], false), /lowercase/);
    assert.match(slugError("a--b", [], false), /lowercase/);
    assert.match(slugError("-leading", [], false), /lowercase/);
    assert.match(slugError("UPPER", [], false), /lowercase/);
});

test("slugError treats empty as not-yet-valid (no error)", () => {
    assert.equal(slugError("", [], false), "");
    assert.equal(slugError("   ", [], false), "");
});

test("slugError enforces uniqueness unless editing the same page", () => {
    assert.match(slugError("taken", ["taken"], false), /already exists/);
    // Case-insensitive: an existing "Taken" must block a new "taken".
    assert.match(slugError("taken", ["Taken"], false), /already exists/);
    assert.equal(slugError("taken", ["taken"], true), "");
});

test("featureStateUrl uses the correct Feature Management route", () => {
    assert.equal(
        featureStateUrl("contoso", "project-1", "my-publisher.static.pages-feature"),
        "https://dev.azure.com/contoso/_apis/FeatureManagement/FeatureStates/host/project/project-1/my-publisher.static.pages-feature?api-version=7.2-preview.1"
    );
});

test("slugError reserves platform slugs (only for new pages)", () => {
    assert.match(slugError("static", [], false), /reserved/);
    // Editing an existing page whose slug is already reserved must not be blocked.
    assert.equal(slugError("static", [], true), "");
});

test("formatBytes boundaries and guards", () => {
    assert.equal(formatBytes(1023), "1023 B");
    assert.equal(formatBytes(1024), "1.0 KiB");
    assert.equal(formatBytes(1024 * 1024 * 1024), "1.0 GiB");
    assert.equal(formatBytes(1024 * 1024 * 1024 * 1024), "1.0 TiB");
    assert.equal(formatBytes(-5), "0 B");
    assert.equal(formatBytes(Number.NaN), "0 B");
    assert.equal(formatBytes(Number.POSITIVE_INFINITY), "0 B");
});

test("addPageToIndex appends a page with defaults and a unique slug", () => {
    const next = addPageToIndex(makeIndex([makePage({ pageId: "a", slug: "alpha" })]), {
        pageId: "b",
        name: "Beta",
        slug: "beta",
        comment: "first"
    });
    const added = next.pages.find((page) => page.pageId === "b");
    assert.ok(added);
    assert.equal(added!.slug, "beta");
    assert.equal(added!.comment, "first");
    assert.equal(added!.order, 1);
    assert.equal(added!.enabled, true);
    assert.equal(added!.hidden, false);
    assert.equal(added!.sizeBytes, 0);
});

test("addPageToIndex rejects duplicate slugs case-insensitively (live and trashed)", () => {
    assert.throws(
        () => addPageToIndex(makeIndex([makePage({ slug: "taken" })]), { pageId: "b", name: "B", slug: "TAKEN" }),
        /already in use/
    );
    const trashed = makeIndex([], [
        { trashId: "t1", deletedUtc: "2026-01-01T00:00:00.000Z", deletedBy: "x", page: makePage({ slug: "gone" }) }
    ]);
    assert.equal(slugInUse(trashed, "GONE"), true);
    assert.throws(
        () => addPageToIndex(trashed, { pageId: "c", name: "C", slug: "gone" }),
        /already in use/
    );
});

test("mutations never modify the input index (immutability)", () => {
    const original = makeIndex([makePage({ pageId: "a", slug: "alpha" })]);
    const snapshot = JSON.stringify(original);
    addPageToIndex(original, { pageId: "b", name: "B", slug: "beta" });
    updatePageInIndex(original, "a", { name: "Changed" });
    removePageFromIndex(original, "a", { trashId: "t", deletedUtc: "now", deletedBy: "x" });
    assert.equal(JSON.stringify(original), snapshot);
});

test("updatePageInIndex patches only the target page", () => {
    const next = updatePageInIndex(
        makeIndex([makePage({ pageId: "a" }), makePage({ pageId: "b", slug: "second" })]),
        "b",
        { name: "Renamed", comment: "note", enabled: false }
    );
    assert.equal(next.pages[0].name, "Page");
    assert.equal(next.pages[1].name, "Renamed");
    assert.equal(next.pages[1].comment, "note");
    assert.equal(next.pages[1].enabled, false);
});

test("removePageFromIndex moves a page to the trash without deleting content", () => {
    const index = makeIndex([makePage({ pageId: "a", slug: "alpha", sizeBytes: 42 })]);
    const next = removePageFromIndex(index, "a", {
        trashId: "t1",
        deletedUtc: "2026-01-02T03:04:05.000Z",
        deletedBy: "Tester"
    });
    assert.equal(next.pages.length, 0);
    assert.equal(next.trash.length, 1);
    assert.equal(next.trash[0].trashId, "t1");
    assert.equal(next.trash[0].deletedBy, "Tester");
    // The metadata (including size) is retained for restore.
    assert.equal(next.trash[0].page.sizeBytes, 42);
    // Removing an unknown page is a safe no-op.
    assert.equal(removePageFromIndex(next, "missing", { trashId: "x", deletedUtc: "", deletedBy: "" }).trash.length, 1);
});

test("restorePageInIndex returns a page to the end of the live list", () => {
    const index = makeIndex([makePage({ pageId: "a", slug: "alpha", order: 0 })], [
        { trashId: "t1", deletedUtc: "2026-01-01T00:00:00.000Z", deletedBy: "x", page: makePage({ pageId: "b", slug: "beta", order: 9 }) }
    ]);
    const next = restorePageInIndex(index, "t1");
    assert.equal(next.trash.length, 0);
    assert.equal(next.pages.length, 2);
    assert.equal(next.pages[1].pageId, "b");
    assert.equal(next.pages[1].order, 1);
});

test("purgeTrashInIndex returns the pageId to purge", () => {
    const index = makeIndex([], [
        { trashId: "t1", deletedUtc: "2026-01-01T00:00:00.000Z", deletedBy: "x", page: makePage({ pageId: "gone" }) }
    ]);
    const result = purgeTrashInIndex(index, "t1");
    assert.equal(result.pageId, "gone");
    assert.equal(result.index.trash.length, 0);
    assert.equal(purgeTrashInIndex(index, "missing").pageId, "");
});

test("trashExpiryUtc is deletedUtc plus the retention window", () => {
    assert.equal(trashExpiryUtc("2026-01-01T00:00:00.000Z"), "2026-01-06T00:00:00.000Z");
    assert.equal(trashExpiryUtc("2026-01-01T00:00:00.000Z", 1), "2026-01-02T00:00:00.000Z");
    assert.equal(trashExpiryUtc(""), "");
    assert.equal(trashExpiryUtc("not-a-date"), "");
});

test("expiredTrashEntries uses a strict 5-day cutoff", () => {
    const now = Date.parse("2026-06-10T12:00:00.000Z");
    const days = 5;
    const exactly = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
    const expired = new Date(now - days * 24 * 60 * 60 * 1000 - 1000).toISOString();
    const recent = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();
    const index = makeIndex([], [
        { trashId: "t-exact", deletedUtc: exactly, deletedBy: "", page: makePage() },
        { trashId: "t-old", deletedUtc: expired, deletedBy: "", page: makePage() },
        { trashId: "t-new", deletedUtc: recent, deletedBy: "", page: makePage() }
    ]);
    const ids = expiredTrashEntries(index, now, days).map((entry) => entry.trashId);
    assert.deepEqual(ids, ["t-old"]);
});

test("removeTrashEntries removes the given entries and reports pageIds", () => {
    const index = makeIndex([], [
        { trashId: "t1", deletedUtc: "2026-01-01T00:00:00.000Z", deletedBy: "", page: makePage({ pageId: "p1" }) },
        { trashId: "t2", deletedUtc: "2026-01-01T00:00:00.000Z", deletedBy: "", page: makePage({ pageId: "p2" }) }
    ]);
    const result = removeTrashEntries(index, ["t1"]);
    assert.deepEqual(result.pageIds, ["p1"]);
    assert.deepEqual(result.index.trash.map((entry) => entry.trashId), ["t2"]);
});

test("clearPageInIndex resets size, bumps version, clears the update stamp", () => {
    const next = clearPageInIndex(
        makeIndex([makePage({ pageId: "a", sizeBytes: 999, contentVersion: 3, updatedUtc: "2026-01-01", updatedBy: "build" })]),
        "a"
    );
    assert.equal(next.pages[0].sizeBytes, 0);
    assert.equal(next.pages[0].contentVersion, 4);
    assert.equal(next.pages[0].updatedUtc, "");
    assert.equal(next.pages[0].updatedBy, "");
});

test("projectStats counts pages, sums sizes, and picks the latest update", () => {
    const stats = projectStats(
        makeIndex([
            makePage({ sizeBytes: 100, updatedUtc: "2026-01-01T00:00:00.000Z" }),
            makePage({ pageId: "b", slug: "b", sizeBytes: 250, updatedUtc: "2026-03-01T00:00:00.000Z" }),
            makePage({ pageId: "c", slug: "c", sizeBytes: 0, updatedUtc: "" })
        ])
    );
    assert.equal(stats.pages, 3);
    assert.equal(stats.totalBytes, 350);
    assert.equal(stats.updatedUtc, "2026-03-01T00:00:00.000Z");
});

test("encodeQuery serializes and encodes a parameter map", () => {
    assert.equal(encodeQuery({}), "");
    assert.equal(encodeQuery({ page: "my-page" }), "?page=my-page");
    assert.equal(encodeQuery({ a: "1", b: "two words" }), "?a=1&b=two%20words");
});

test("withQueryParam inserts, replaces and removes while preserving others", () => {
    // Insert into a URL with no query.
    assert.equal(withQueryParam("https://host/app", "page", "x"), "https://host/app?page=x");
    // Replace an existing key in place and keep the other parameters.
    assert.equal(
        withQueryParam("https://host/app?a=1&page=old&b=2", "page", "new"),
        "https://host/app?a=1&page=new&b=2"
    );
    // Remove a key (value null) without touching the rest.
    assert.equal(withQueryParam("https://host/app?a=1&page=x", "page", null), "https://host/app?a=1");
    // A fragment is preserved.
    assert.equal(withQueryParam("https://host/app#frag", "page", "x"), "https://host/app?page=x#frag");
});

test("URL builders produce the documented shapes", () => {
    assert.equal(
        hubUrl({ origin: "https://dev.azure.com", organization: "contoso", project: "SampleProject", contribution: "my-publisher.static.pages" }),
        "https://dev.azure.com/contoso/SampleProject/_apps/hub/my-publisher.static.pages"
    );
    assert.equal(
        projectSettingsUrl({ origin: "https://dev.azure.com", organization: "contoso", project: "My Project", contribution: "my-publisher.static.static-admin-hub" }),
        "https://dev.azure.com/contoso/My%20Project/_settings/my-publisher.static.static-admin-hub"
    );
    assert.equal(
        orgSettingsUrl({ origin: "https://dev.azure.com", organization: "contoso", contribution: "my-publisher.static.static-org-admin-hub" }),
        "https://dev.azure.com/contoso/_settings/my-publisher.static.static-org-admin-hub"
    );
});

test("contributor tally picks the main contributor and shortens names", () => {
    const tally = new Map<string, { name: string; commits: number }>();
    addContribution(tally, "Jane Doe");
    addContribution(tally, "Jane Doe");
    addContribution(tally, "jane doe"); // case-insensitive merge
    addContribution(tally, "Bob Smith");
    addContribution(tally, "   ");
    assert.equal(tally.size, 2);
    const top = topContributor(tally);
    assert.ok(top);
    assert.equal(top!.name, "Jane Doe");
    assert.equal(top!.commits, 3);
    // First name for display; the full name stays available as a tooltip.
    assert.equal(firstName("Jane Doe"), "Jane");
    assert.equal(firstName("  Cher  "), "Cher");
    assert.equal(firstName(""), "");
});

test("checkProjectUrl accepts in-project Azure DevOps links and rejects others", () => {
    const org = "contoso";
    const project = "SampleProject";
    // Accepts dev.azure.com links in the same org/project (case-insensitive project).
    assert.equal(
        checkProjectUrl("https://dev.azure.com/contoso/SampleProject/_build/results?buildId=1", org, project).ok,
        true
    );
    assert.equal(checkProjectUrl("https://dev.azure.com/contoso/sampleproject/_git/repo", org, project).ok, true);
    // Rejects external, wrong org, wrong project, non-https, and garbage.
    assert.equal(checkProjectUrl("https://example.com/contoso/SampleProject/x", org, project).ok, false);
    assert.equal(checkProjectUrl("https://dev.azure.com/other/SampleProject/x", org, project).ok, false);
    assert.equal(checkProjectUrl("https://dev.azure.com/contoso/OtherProject/x", org, project).ok, false);
    assert.equal(checkProjectUrl("http://dev.azure.com/contoso/SampleProject/x", org, project).ok, false);
    assert.equal(checkProjectUrl("not a url", org, project).ok, false);
    assert.match(checkProjectUrl("https://dev.azure.com/other/SampleProject/x", org, project).error || "", /organization/);
});

test("formatBytesWhole omits decimals", () => {
    assert.equal(formatBytesWhole(0), "0 B");
    assert.equal(formatBytesWhole(512), "512 B");
    assert.equal(formatBytesWhole(1536), "2 KiB");
    assert.equal(formatBytesWhole(5 * 1024 * 1024), "5 MiB");
    assert.equal(formatBytesWhole(1.6 * 1024 * 1024), "2 MiB");
});

test("slugify produces a valid slug", () => {
    assert.equal(slugify("My Report 2026"), "my-report-2026");
    assert.equal(slugify("  Repo/Name (latest) "), "repo-name-latest");
    assert.equal(slugify("---"), "");
});

test("describeProjectUrl detects the area and ids (incl. an optional team segment)", () => {
    const org = "contoso";
    const project = "SampleProject";
    const build = describeProjectUrl(
        "https://dev.azure.com/contoso/SampleProject/Sample%20Team/_build/results?buildId=4531&view=logs&s=96ac2280&j=12f1170f",
        org,
        project
    );
    assert.equal(build.ok, true);
    assert.equal(build.area, "build");
    assert.equal(build.buildId, "4531");
    assert.equal(build.view, "logs");
    assert.equal(build.jobId, "12f1170f");

    const pr = describeProjectUrl("https://dev.azure.com/contoso/SampleProject/_git/My%20Repo/pullrequest/42", org, project);
    assert.equal(pr.area, "repository");
    assert.equal(pr.repositoryName, "My Repo");
    assert.equal(pr.prId, "42");

    const artifacts = describeProjectUrl(
        "https://dev.azure.com/contoso/SampleProject/_build/results?buildId=4531&view=artifacts&pathAsName=false&type=publishedArtifacts&path=%2Fdrop%2Fbin",
        org,
        project
    );
    assert.equal(artifacts.view, "artifacts");
    assert.equal(artifacts.artifactPath, "/drop/bin");

    const results = describeProjectUrl("https://dev.azure.com/contoso/SampleProject/_build/results?buildId=4531&view=results", org, project);
    assert.equal(results.view, "results");

    const coverage = describeProjectUrl("https://dev.azure.com/contoso/SampleProject/_build/results?buildId=4531&view=codecoverage-tab", org, project);
    assert.equal(coverage.view, "codecoverage-tab");

    // A build log link with a job and a task (the parameters must round-trip losslessly).
    const logs = describeProjectUrl(
        "https://dev.azure.com/contoso/SampleProject/_build/results?buildId=4531&view=logs&j=12f1170f&t=7e5a6d17",
        org,
        project
    );
    assert.equal(logs.view, "logs");
    assert.equal(logs.jobId, "12f1170f");
    assert.equal(logs.taskId, "7e5a6d17");
    assert.deepEqual(logs.params, [
        ["buildId", "4531"],
        ["view", "logs"],
        ["j", "12f1170f"],
        ["t", "7e5a6d17"],
    ]);
    // Reconstructing from the parsed parameters reproduces the query exactly.
    const rebuilt = "/_build/results?" + logs.params.map(([k, v]) => `${k}=${v}`).join("&");
    assert.equal(rebuilt, "/_build/results?buildId=4531&view=logs&j=12f1170f&t=7e5a6d17");

    const commit = describeProjectUrl("https://dev.azure.com/contoso/SampleProject/_git/MyRepo/commit/abc123def456", org, project);
    assert.equal(commit.area, "repository");
    assert.equal(commit.commit, "abc123def456");

    // Out-of-project URLs are rejected.
    assert.equal(describeProjectUrl("https://example.com/x", org, project).ok, false);
});

test("dynamic link tokens: detect, tokenize and apply", () => {
    const buildUrl = "https://dev.azure.com/contoso/SampleProject/_build/results?buildId=4531&view=results";
    const prUrl = "https://dev.azure.com/contoso/SampleProject/_git/repo/pullrequest/42";
    const commitUrl = "https://dev.azure.com/contoso/SampleProject/_git/repo/commit/0123456789abcdef0123456789abcdef01234567";

    // Detection.
    assert.deepEqual(detectDynamicPart(buildUrl), { param: "buildId", value: "4531" });
    assert.deepEqual(detectDynamicPart(prUrl), { param: "pullRequestId", value: "42" });
    assert.equal(detectDynamicPart(commitUrl)?.param, "commit");

    // Tokenize then apply round-trips to the original value.
    const buildToken = tokenizeUrl(buildUrl, detectDynamicPart(buildUrl)!);
    assert.equal(hasToken(buildToken), true);
    assert.equal(buildToken.indexOf(DYNAMIC_TOKEN) >= 0, true);
    assert.equal(applyToken(buildToken, "9999"), buildUrl.replace("4531", "9999"));

    const prToken = tokenizeUrl(prUrl, detectDynamicPart(prUrl)!);
    assert.equal(applyToken(prToken, "77"), prUrl.replace("42", "77"));

    // No dynamic part -> nothing detected.
    assert.equal(detectDynamicPart("https://dev.azure.com/contoso/SampleProject/_build?definitionId=3"), null);
});

test("describeProjectUrl handles every in-project URL shape", () => {
    const org = "contoso";
    const project = "SampleProject";
    const d = (p: string) => describeProjectUrl(`https://dev.azure.com/${org}/${project}${p}`, org, project);

    // Repository shapes.
    assert.equal(d("/_git/MyRepo").area, "repository");
    assert.equal(d("/_git/MyRepo").repositoryName, "MyRepo");
    assert.equal(d("/_git/MyRepo?path=/dir/file&version=GBmain&line=10").params.length, 3);
    assert.equal(d("/_git/MyRepo/pullrequests?_a=active").repositoryName, "MyRepo");
    assert.equal(d("/_git/MyRepo/pullrequest/42").prId, "42");
    assert.equal(d("/_git/MyRepo/commit/abc123def456").commit, "abc123def456");
    assert.equal(d("/_git/MyRepo/branches").repositoryName, "MyRepo");
    assert.equal(d("/_git/MyRepo/tags").repositoryName, "MyRepo");

    // Build shapes (definition list, results, coverage, artifacts + path, logs + stage/job/task).
    assert.equal(d("/_build?definitionId=5").area, "build");
    assert.equal(d("/_build/results?buildId=4531&view=results").view, "results");
    assert.equal(d("/_build/results?buildId=4531&view=codecoverage-tab").view, "codecoverage-tab");
    const art = d("/_build/results?buildId=4531&view=artifacts&pathAsName=false&type=publishedArtifacts&path=%2Fdrop");
    assert.equal(art.view, "artifacts");
    assert.equal(art.artifactPath, "/drop");
    const logs = d("/_build/results?buildId=4531&view=logs&s=stage1&j=job1&t=task1");
    assert.equal(logs.stageId, "stage1");
    assert.equal(logs.jobId, "job1");
    assert.equal(logs.taskId, "task1");
    assert.deepEqual(logs.params, [
        ["buildId", "4531"],
        ["view", "logs"],
        ["s", "stage1"],
        ["j", "job1"],
        ["t", "task1"],
    ]);

    // Extension-contributed view ids and an optional team segment are both tolerated.
    assert.equal(d("/_build/results?buildId=1&view=blakyaks.build-html-reports-tab").view, "blakyaks.build-html-reports-tab");
    assert.equal(d("/Some%20Team/_build/results?buildId=1&view=results").area, "build");

    // The real-world log link (with a team segment, a stage, a job and a task): every parameter
    // must survive so the reconstruction is lossless.
    const real = describeProjectUrl(
        "https://dev.azure.com/contoso/SampleProject/Sample%20Team/_build/results?buildId=4531&view=logs&s=11111111-1111-1111-1111-111111111111&j=22222222-2222-2222-2222-222222222222&t=33333333-3333-3333-3333-333333333333",
        "contoso",
        "SampleProject"
    );
    assert.equal(real.area, "build");
    assert.equal(real.buildId, "4531");
    assert.equal(real.view, "logs");
    assert.equal(real.stageId, "11111111-1111-1111-1111-111111111111");
    assert.equal(real.jobId, "22222222-2222-2222-2222-222222222222");
    assert.equal(real.taskId, "33333333-3333-3333-3333-333333333333");
    assert.deepEqual(real.params, [
        ["buildId", "4531"],
        ["view", "logs"],
        ["s", "11111111-1111-1111-1111-111111111111"],
        ["j", "22222222-2222-2222-2222-222222222222"],
        ["t", "33333333-3333-3333-3333-333333333333"],
    ]);
});

test("checkProjectUrl accepts the project GUID as well as its name", () => {
    const org = "contoso";
    const project = "SampleProject";
    const projectId = "99999999-9999-9999-9999-999999999999";
    assert.equal(checkProjectUrl(`https://dev.azure.com/${org}/${project}/_wiki/wikis/x`, org, project, projectId).ok, true);
    assert.equal(checkProjectUrl(`https://dev.azure.com/${org}/${projectId}/_wiki/wikis/x`, org, project, projectId).ok, true);
    // Without the id, a GUID segment is not accepted (it could be another project).
    assert.equal(checkProjectUrl(`https://dev.azure.com/${org}/${projectId}/_wiki/wikis/x`, org, project).ok, false);
    // describeProjectUrl keeps the whole path after the project segment and all parameters.
    const info = describeProjectUrl(`https://dev.azure.com/${org}/${projectId}/_wiki/wikis/abc?pagePath=%2FHome`, org, project, projectId);
    assert.equal(info.ok, true);
    assert.deepEqual(info.params, [["pagePath", "/Home"]]);
});

test("viewKeyForValue maps known ADO view ids and leaves unknown ones empty", () => {
    assert.equal(viewKeyForValue("results"), "results");
    assert.equal(viewKeyForValue("codecoverage-tab"), "coverage");
    assert.equal(viewKeyForValue("artifacts"), "artifacts");
    assert.equal(viewKeyForValue("logs"), "logs");
    assert.equal(viewKeyForValue("blakyaks.build-html-reports-tab"), "");
});

test("the pipeline builder chain composes a lossless deep-link URL", () => {
    // Area -> Pipeline (grouping) -> Fixed build -> build number -> Logs -> Stage -> Job -> Task.
    const chain = [
        { key: "area:build", label: "Pipeline", url: "" },
        { key: "pipe:47", label: "status-page", url: "" },
        { key: "mode:fixed", label: "Fixed build", url: "" },
        { key: "build:4531", label: "Build 4531", url: "/_build/results?buildId=4531", terminal: true },
        { key: "view:logs", label: "Logs", url: "&view=logs", terminal: true },
        { key: "stage:96ac", label: "Stage: Build", url: "&s=96ac", terminal: true },
        { key: "job:12f1", label: "Job: Build", url: "&j=12f1", terminal: true },
        { key: "task:7e5a", label: "Task: Run", url: "&t=7e5a", terminal: true },
    ];
    const result = composePath("https://dev.azure.com/contoso/SampleProject", chain);
    assert.equal(result.terminal, true);
    assert.equal(
        result.url,
        "https://dev.azure.com/contoso/SampleProject/_build/results?buildId=4531&view=logs&s=96ac&j=12f1&t=7e5a"
    );
});

test("the pipeline builder chain tokenizes a dynamic latest-succeeded build", () => {
    const chain = [
        { key: "area:build", label: "Pipeline", url: "" },
        { key: "pipe:47", label: "status-page", url: "" },
        {
            key: "mode:latest-succeeded",
            label: "Latest succeeded build",
            url: "/_build/results?buildId=" + DYNAMIC_TOKEN,
            terminal: true,
            dynamic: { kind: "build", buildMode: "latest-succeeded", definitionId: 47 },
        },
        { key: "view:results", label: "Results (summary)", url: "&view=results", terminal: true },
    ];
    const result = composePath("https://dev.azure.com/contoso/SampleProject", chain);
    assert.equal(result.url.indexOf(DYNAMIC_TOKEN) >= 0, true);
    assert.deepEqual(result.dynamic, {
        kind: "build",
        buildMode: "latest-succeeded",
        definitionId: 47,
    });
});

test("build view specs list Results, Coverage, Artifacts and Logs", () => {
    const specs = buildViewSpecs();
    assert.deepEqual(specs.map((spec) => spec.key), [
        "view:results",
        "view:coverage",
        "view:artifacts",
        "view:logs",
    ]);
    assert.equal(specs.find((spec) => spec.key === "view:artifacts")?.url.indexOf("view=artifacts") >= 0, true);
    assert.equal(specs.find((spec) => spec.key === "view:logs")?.url, "&view=logs");
});

test("fixedUrlError accepts any http(s) URL and rejects the rest", () => {
    assert.equal(fixedUrlError("https://example.com/report"), "");
    assert.equal(fixedUrlError("http://host/x"), "");
    assert.equal(fixedUrlError(""), "Enter the URL for the fixed link.");
    assert.equal(fixedUrlError("not a url"), "That is not a valid URL.");
    assert.equal(fixedUrlError("javascript:alert(1)"), "Only http(s) URLs are allowed.");
    assert.equal(isHttpUrl("https://example.com"), true);
    assert.equal(isHttpUrl("ftp://example.com"), false);
});

test("isFixedArea detects the Fixed area option", () => {
    assert.equal(isFixedArea([{ key: "area:fixed", label: "Fixed (any URL)" }]), true);
    assert.equal(isFixedArea([{ key: "area:build", label: "Pipeline" }]), false);
    assert.equal(isFixedArea([]), false);
});

test("pullRequestWebUrl builds the org/project/repo URL from a global lookup result", () => {
    // The project id from the API response is used as the project segment (always present).
    const url = pullRequestWebUrl("contoso", {
        pullRequestId: 377,
        repository: { name: "my-repo", project: { id: "99999999-9999-9999-9999-999999999999", name: "SampleProject" } },
    });
    assert.equal(
        url,
        "https://dev.azure.com/contoso/99999999-9999-9999-9999-999999999999/_git/my-repo/pullrequest/377"
    );
    // Falls back to the project name when no id is present.
    assert.equal(
        pullRequestWebUrl("contoso", { pullRequestId: 5, repository: { name: "repo", project: { name: "SampleProject" } } }),
        "https://dev.azure.com/contoso/SampleProject/_git/repo/pullrequest/5"
    );
});

test("isValidPullRequestId accepts positive integers only", () => {
    assert.equal(isValidPullRequestId("377"), true);
    assert.equal(isValidPullRequestId(" 413 "), true);
    assert.equal(isValidPullRequestId("0"), false);
    assert.equal(isValidPullRequestId("abc"), false);
    assert.equal(isValidPullRequestId("12a"), false);
    assert.equal(isValidPullRequestId(""), false);
});

test("linkAreaLabel returns a short area for each link shape", () => {
    assert.equal(linkAreaLabel("https://dev.azure.com/contoso/SampleProject/_git/MyRepo"), "Repo");
    assert.equal(linkAreaLabel("https://dev.azure.com/contoso/SampleProject/_git/MyRepo/pullrequest/42"), "PR");
    assert.equal(linkAreaLabel("https://dev.azure.com/contoso/SampleProject/_build/results?buildId=1"), "Pipeline");
    assert.equal(linkAreaLabel("https://dev.azure.com/contoso/SampleProject/_build?definitionId=1"), "Pipeline");
    assert.equal(linkAreaLabel("https://dev.azure.com/contoso/SampleProject/_artifacts/feed/MyFeed"), "Artifact");
    assert.equal(linkAreaLabel("https://example.com/report.html", "fixed"), "Fixed");
    // An in-project URL we do not model is stored as Fixed.
    assert.equal(linkAreaLabel("https://dev.azure.com/contoso/SampleProject/_settings/x"), "Fixed");
});

test("hasAnyToken detects dynamic and log placeholders", () => {
    assert.equal(hasAnyToken("https://x/_build/results?buildId={{dyn}}"), true);
    assert.equal(hasAnyToken("https://x/_build/results?s={{stage}}"), true);
    assert.equal(hasAnyToken("https://x/_build/results?j={{job}}"), true);
    assert.equal(hasAnyToken("https://x/_build/results?t={{task}}"), true);
    assert.equal(hasAnyToken("https://x/_build/results?buildId=1"), false);
});

test("applyTokens resolves dynamic and log placeholders, dropping missing ones", () => {
    const url = "/_build/results?buildId={{dyn}}&view=logs&s={{stage}}&j={{job}}&t={{task}}";
    assert.equal(
        applyTokens(url, { "{{dyn}}": "9999", "{{stage}}": "s1", "{{job}}": "j1", "{{task}}": "t1" }),
        "/_build/results?buildId=9999&view=logs&s=s1&j=j1&t=t1"
    );
    // A task missing in the resolved build drops only its own parameter (no dangling "&t={{task}}").
    assert.equal(
        applyTokens(url, { "{{dyn}}": "9999", "{{stage}}": "s1", "{{job}}": "j1", "{{task}}": null }),
        "/_build/results?buildId=9999&view=logs&s=s1&j=j1"
    );
});

test("composePath merges a build mode with a name-based log target", () => {
    const chain = [
        {
            key: "mode:latest-succeeded",
            label: "Latest succeeded build",
            url: "/_build/results?buildId=" + DYNAMIC_TOKEN,
            terminal: true,
            dynamic: { kind: "build", buildMode: "latest-succeeded", definitionId: 47 },
        },
        {
            key: "target:logs:x",
            label: "Logs: x / y",
            url: "&view=logs&s=" + LOG_STAGE_TOKEN + "&j=" + LOG_JOB_TOKEN,
            terminal: true,
            names: { stage: "x", job: "y" },
            dynamic: { kind: "build", logTarget: { view: "logs", stage: "x", job: "y" } },
        },
    ];
    const result = composePath("https://dev.azure.com/contoso/SampleProject", chain);
    assert.equal(result.dynamic?.buildMode, "latest-succeeded");
    assert.equal(result.dynamic?.definitionId, 47);
    assert.deepEqual(result.dynamic?.logTarget, { view: "logs", stage: "x", job: "y" });
    assert.equal(result.url.indexOf(LOG_STAGE_TOKEN) >= 0, true);
});

test("normalizeTokens restores percent-encoded placeholders", () => {
    assert.equal(
        normalizeTokens("/x?buildId=%7B%7Bdyn%7D%7D&s=%7B%7Bstage%7D%7D&j=%7B%7Bjob%7D%7D&t=%7B%7Btask%7D%7D"),
        "/x?buildId={{dyn}}&s={{stage}}&j={{job}}&t={{task}}"
    );
    assert.equal(normalizeTokens("plain"), "plain");
});

test("targetMatches matches logs by name and views by view (id-free)", () => {
    const logTarget = {
        key: "target:logs:__default / Job / Publish CSB report",
        label: "Logs: __default / Job / Publish CSB report",
        url: "&view=logs&s={{stage}}&j={{job}}&t={{task}}",
        terminal: true,
        names: { stage: "__default", job: "Job", task: "Publish CSB report" },
    };
    const artifacts = { key: "view:artifacts", label: "View: Artifacts", url: "&view=artifacts&pathAsName=false&type=publishedArtifacts", terminal: true };

    // Matches by resolved names.
    assert.equal(targetMatches(logTarget, "logs", { stage: "__default", job: "Job", task: "Publish CSB report" }), true);
    // A different task name does not match.
    assert.equal(targetMatches(logTarget, "logs", { stage: "__default", job: "Job", task: "Other" }), false);
    // A view target is matched only when no names are involved.
    assert.equal(targetMatches(artifacts, "artifacts", {}), true);
    assert.equal(targetMatches(artifacts, "artifacts", { stage: "x" }), false);
    // The whole-build log view must not match a specific stage/job paste.
    assert.equal(targetMatches({ key: "view:logs", label: "View: Logs", url: "&view=logs", terminal: true }, "logs", { job: "Job" }), false);
});

test("consumedParams lists the query parameters a target encodes", () => {
    assert.deepEqual([...consumedParams("&view=logs&s={{stage}}&j={{job}}")], ["view", "s", "j"]);
    assert.deepEqual(
        [...consumedParams("&view=artifacts&pathAsName=false&type=publishedArtifacts")],
        ["view", "pathAsName", "type"]
    );
    assert.deepEqual([...consumedParams("")], []);
});

test("buildBundle groups documents per project and drops per-installation etags", () => {
    const source = { publisher: "f-steff", extension: "static", organization: "contoso" };
    const original = { id: "index", kind: "index", revision: 3, __etag: "abc" };
    const bundle = buildBundle(
        [{ projectId: "p1", projectName: "SampleProject", documents: [original] }],
        source,
        new Date("2026-10-13T10:00:00Z")
    );
    assert.equal(bundle.format, "static-export");
    assert.equal(bundle.schemaVersion, 2);
    assert.equal(bundle.exportedUtc, "2026-10-13T10:00:00.000Z");
    assert.deepEqual(bundle.source, source);
    assert.equal(bundle.projects.length, 1);
    assert.equal("__etag" in bundle.projects[0].documents[0], false);
    // The input document is copied, never mutated.
    assert.equal(original.__etag, "abc");
});

test("encodeBundle/decodeBundle round-trip through a ZIP", async () => {
    const bundle = buildBundle(
        [{ projectId: "p1", projectName: "SampleProject", documents: [{ id: "index", __etag: "x" }] }],
        { publisher: "f-steff", extension: "static-dev", organization: "contoso" },
        new Date("2026-10-13T10:00:00Z")
    );
    const bytes = encodeBundle(bundle);
    assert.equal(bytes[0], 0x50); // "P" of the local file header signature
    const parsed = await decodeBundle(bytes);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
        assert.equal(parsed.bundle.source.organization, "contoso");
        assert.equal(parsed.bundle.projects[0].projectName, "SampleProject");
        assert.equal("__etag" in parsed.bundle.projects[0].documents[0], false);
    }
});

test("decodeBundle rejects a file that is not a Static backup", async () => {
    assert.equal((await decodeBundle(new TextEncoder().encode("hello"))).ok, false);
    const zip = writeZip([{ name: "other.json", data: new TextEncoder().encode("{}") }]);
    assert.equal((await decodeBundle(zip)).ok, false);
});

test("parseBundle rejects malformed or foreign input", () => {
    assert.equal(parseBundle("").ok, false);
    assert.equal(parseBundle("not json").ok, false);
    assert.equal(parseBundle("[]").ok, false);
    assert.equal(parseBundle(JSON.stringify({ format: "other", projects: [] })).ok, false);
    assert.equal(parseBundle(JSON.stringify({ format: "static-export" })).ok, false);
    assert.equal(parseBundle(JSON.stringify({ format: "static-export", projects: [{}] })).ok, false);
    assert.equal(
        parseBundle(
            JSON.stringify({
                format: "static-export",
                projects: [{ projectId: "p1", documents: [{ kind: "index" }] }]
            })
        ).ok,
        false
    );
});

test("writeZip/readZip round-trip entries and compute CRCs", async () => {
    assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
    const entries = [
        { name: "static-backup.json", data: new TextEncoder().encode('{"a":1}') },
        { name: "empty.bin", data: new Uint8Array(0) }
    ];
    const zip = writeZip(entries, new Date("2026-10-13T10:00:00Z"));
    const read = await readZip(zip);
    assert.deepEqual([...read.keys()], ["static-backup.json", "empty.bin"]);
    const backup = read.get("static-backup.json");
    const empty = read.get("empty.bin");
    assert.ok(backup);
    assert.ok(empty);
    assert.equal(new TextDecoder().decode(backup), '{"a":1}');
    assert.equal(empty.length, 0);
});

test("backupFileName is a safe, dated file name", () => {
    const now = new Date("2026-10-13T10:00:00Z");
    assert.equal(backupFileName("Contoso Ltd!", now), "static-backup-contoso-ltd-2026-10-13.zip");
    assert.equal(backupFileName("", now), "static-backup-organization-2026-10-13.zip");
});

test("matchesFilter and filterByName are case-insensitive substring matches", () => {
    assert.equal(matchesFilter("Anything", ""), true);
    assert.equal(matchesFilter("My Report", "report"), true);
    assert.equal(matchesFilter("My Report", "  REPORT "), true);
    assert.equal(matchesFilter("My Report", "zzz"), false);
    const items = [{ name: "Zeta" }, { name: "alpha" }, { name: "Beta" }];
    assert.deepEqual(filterByName(items, "a").map((i) => i.name), ["Zeta", "alpha", "Beta"]);
    assert.deepEqual(filterByName(items, "beta").map((i) => i.name), ["Beta"]);
});

test("formatRelativeTime formats coarse all-time ages", () => {
    const now = Date.parse("2026-06-10T12:00:00.000Z");
    const ago = (ms: number) => new Date(now - ms).toISOString();
    assert.equal(formatRelativeTime("", now), "never");
    assert.equal(formatRelativeTime(ago(10 * 1000), now), "just now");
    assert.equal(formatRelativeTime(ago(5 * 60 * 1000), now), "5 min ago");
    assert.equal(formatRelativeTime(ago(3 * 60 * 60 * 1000), now), "3 h ago");
    assert.equal(formatRelativeTime(ago(4 * 24 * 60 * 60 * 1000), now), "4 d ago");
    assert.equal(formatRelativeTime(ago(60 * 24 * 60 * 60 * 1000), now), "2 mo ago");
    // A future timestamp (clock skew) is clamped rather than shown as negative.
    assert.equal(formatRelativeTime(new Date(now + 60000).toISOString(), now), "just now");
});

// ---- Permission probes (PR: permission-aware visibility) ------------------------------------

test("readPermissionValue reads every response shape the Security API returns", () => {
    // Azure DevOps wraps the array in `{ count, value }`; the reference documents a bare array.
    assert.equal(readPermissionValue({ count: 1, value: [true] }), true);
    assert.equal(readPermissionValue({ count: 1, value: [false] }), false);
    assert.equal(readPermissionValue([true]), true);
    assert.equal(readPermissionValue(true), true);
    // Anything unexpected is "unknown" (null) rather than a wrong answer.
    assert.equal(readPermissionValue({ value: [] }), null);
    assert.equal(readPermissionValue({ value: ["yes"] }), null);
    assert.equal(readPermissionValue(undefined), null);
    assert.equal(readPermissionValue(null), null);
    assert.equal(readPermissionValue("true"), null);
});

test("findActionBit locates a namespace action by name, case-insensitively", () => {
    const definition = {
        actions: [
            { name: "GenericRead", bit: 1, displayName: "View" },
            { name: "MANAGE_PROPERTIES", bit: 16 }
        ]
    };
    assert.equal(findActionBit(definition, "manage_properties"), 16);
    assert.equal(findActionBit(definition, "GenericRead"), 1);
    assert.equal(findActionBit(definition, "delete"), null);
    // A malformed definition must not throw; the probe then reports "unknown".
    assert.equal(findActionBit(null, "x"), null);
    assert.equal(findActionBit({}, "x"), null);
    assert.equal(findActionBit({ actions: [{ name: "x" }] }, "x"), null);
    assert.equal(findActionBit({ actions: "nope" }, "x"), null);
});

// ---- Private links and proposals (PR: private links + proposals) ---------------------------

/** Builds a link entry with defaults so tests only state what they assert. */
function makeLink(overrides: Partial<LinkEntry> = {}): LinkEntry {
    return {
        linkId: "l1", slug: "a-link", title: "A link", url: "https://dev.azure.com/contoso/SampleProject",
        comment: "", order: 0, enabled: true, hidden: false, updatedUtc: "", updatedBy: "",
        ...overrides
    };
}

const ORG = "contoso";
const PROJECT = "SampleProject";
const PROJECT_ID = "00001111-aaaa-2222-bbbb-3333cccc4444";
const IN_PROJECT = `https://dev.azure.com/${ORG}/${PROJECT}/_git/repo`;
const OUT_OF_PROJECT = "https://dev.azure.com/contoso/OtherProject/_git/repo";

test("slugTaken reserves project links (live and trashed) as well as my own", () => {
    const project = makeIndex([]) as unknown as LinkIndex;
    const live = makeLink({ slug: "project-link" });
    const trashed = makeLink({ linkId: "l2", slug: "trashed-link" });
    const index: LinkIndex = {
        id: "links", kind: "links", schemaVersion: 1, revision: 0,
        links: [live], trash: [{ trashId: "t1", deletedUtc: "", deletedBy: "", link: trashed }]
    };
    const mine = [makeLink({ linkId: "p1", slug: "my-link" })];

    assert.equal(slugTaken(index, mine, "project-link"), true);
    // Case-insensitive, and trashed entries still reserve their slug.
    assert.equal(slugTaken(index, mine, "PROJECT-Link"), true);
    assert.equal(slugTaken(index, mine, "trashed-link"), true);
    assert.equal(slugTaken(index, mine, "my-link"), true);
    assert.equal(slugTaken(index, mine, "free"), false);
    // An empty slug is the caller's business (the slug validator reports it).
    assert.equal(slugTaken(index, mine, "   "), false);
    // Editing a link keeps its own slug available.
    assert.equal(slugTaken(index, mine, "my-link", "my-link"), false);
    // A project link is missing while the private store still loads: only its own links count.
    assert.equal(slugTaken(null, mine, "my-link"), true);
    assert.equal(slugTaken(project, mine, "free"), false);
});

test("proposalFor freezes a snapshot and records the owner", () => {
    const link = makeLink({
        linkId: "p1", slug: "my-report", title: "My report", comment: "why",
        url: "https://dev.azure.com/contoso/SampleProject/_build/results?buildId=42",
        area: "build", dynamic: { kind: "build", buildMode: "fixed" }
    });
    const proposal = proposalFor(link, { id: "u1", name: "Sam" }, "prop1", new Date("2026-10-15T09:00:00Z"));

    assert.equal(proposal.proposalId, "prop1");
    assert.equal(proposal.privateLinkId, "p1");
    assert.equal(proposal.state, "open");
    assert.equal(proposal.slug, "my-report");
    assert.equal(proposal.title, "My report");
    assert.equal(proposal.comment, "why");
    assert.equal(proposal.proposedById, "u1");
    assert.equal(proposal.proposedByName, "Sam");
    assert.equal(proposal.proposedUtc, "2026-10-15T09:00:00.000Z");
    assert.deepEqual(proposal.dynamic, { kind: "build", buildMode: "fixed" });
    assert.equal(proposal.area, "build");
    // Optional fields are omitted rather than stored as undefined.
    const plain = proposalFor(makeLink(), { id: "u1", name: "Sam" }, "prop2");
    assert.equal("dynamic" in plain, false);
    assert.equal("area" in plain, false);
});

test("promotionFields hands the link to the project and credits the proposer", () => {
    const proposal = proposalFor(
        makeLink({ slug: "my-report", title: "My report", area: "fixed", dynamic: { kind: "build", buildMode: "latest" } }),
        { id: "u1", name: "Sam" },
        "prop1"
    );
    const fields = promotionFields(proposal, "Ada", new Date("2026-10-15T10:00:00Z"));
    assert.equal(fields.slug, "my-report");
    assert.equal(fields.title, "My report");
    assert.equal(fields.proposedBy, "Sam");
    assert.equal(fields.enabled, true);
    assert.equal(fields.hidden, false);
    assert.equal(fields.updatedBy, "Ada");
    assert.equal(fields.updatedUtc, "2026-10-15T10:00:00.000Z");
    assert.deepEqual(fields.dynamic, { kind: "build", buildMode: "latest" });
});

test("acceptanceError re-checks the slug and the URL shape", () => {
    const open = proposalFor(makeLink({ slug: "my-report", url: IN_PROJECT, area: undefined }), { id: "u1", name: "Sam" }, "prop1");
    assert.equal(acceptanceError(open, null, ORG, PROJECT, PROJECT_ID), "");
    // A project link took the slug in the meantime.
    const taken: LinkIndex = {
        id: "links", kind: "links", schemaVersion: 1, revision: 0,
        links: [makeLink({ slug: "MY-REPORT" })], trash: []
    };
    assert.match(acceptanceError(open, taken, ORG, PROJECT, PROJECT_ID), /already used/);
    // A fixed proposal may point anywhere http(s).
    const fixed = { ...open, area: "fixed", url: "https://example.com/report" };
    assert.equal(acceptanceError(fixed, null, ORG, PROJECT, PROJECT_ID), "");
    assert.notEqual(acceptanceError({ ...fixed, url: "javascript:alert(1)" }, null, ORG, PROJECT, PROJECT_ID), "");
    // An in-project proposal must still address this project.
    assert.notEqual(acceptanceError({ ...open, url: OUT_OF_PROJECT }, null, ORG, PROJECT, PROJECT_ID), "");
    assert.notEqual(acceptanceError({ ...open, url: "" }, null, ORG, PROJECT, PROJECT_ID), "");
});

test("reconcile keeps open proposals, promotes accepted ones and returns rejected ones", () => {
    const now = new Date("2026-10-15T12:00:00Z");
    const openLink = makeLink({ linkId: "p-open", slug: "open", proposal: { proposalId: "prop-open", proposedUtc: "x" } });
    const accepted = makeLink({ linkId: "p-acc", slug: "acc", proposal: { proposalId: "prop-acc", proposedUtc: "x" } });
    const rejected = makeLink({ linkId: "p-rej", slug: "rej", proposal: { proposalId: "prop-rej", proposedUtc: "x" } });
    const plain = makeLink({ linkId: "p-plain", slug: "plain" });
    const stale = makeLink({ linkId: "p-stale", slug: "stale", proposal: { proposalId: "prop-gone", proposedUtc: "x" } });

    const proposals: LinkProposal[] = [
        { proposalId: "prop-open", privateLinkId: "p-open", slug: "open", title: "t", url: "", comment: "", proposedById: "u1", proposedByName: "Sam", proposedUtc: "x", state: "open" },
        { proposalId: "prop-acc", privateLinkId: "p-acc", slug: "acc", title: "t", url: "", comment: "", proposedById: "u1", proposedByName: "Sam", proposedUtc: "x", state: "accepted", decidedUtc: "2026-10-15T11:00:00Z", decidedBy: "Ada" },
        { proposalId: "prop-rej", privateLinkId: "p-rej", slug: "rej", title: "t", url: "", comment: "", proposedById: "u1", proposedByName: "Sam", proposedUtc: "x", state: "rejected", decidedUtc: "2026-10-15T11:30:00Z", decidedBy: "Ada" },
        // Somebody else's proposal must not be touched or withdrawn.
        { proposalId: "prop-other", privateLinkId: "p-other", slug: "other", title: "t", url: "", comment: "", proposedById: "u2", proposedByName: "Kim", proposedUtc: "x", state: "open" }
    ];

    const plan = reconcile([openLink, accepted, rejected, plain, stale], proposals, "u1", now);
    const slugs = plan.links.map((link) => link.slug).sort();
    assert.deepEqual(slugs, ["open", "plain", "rej", "stale"]);
    // Promotion removes the private original; the decided records go with it (a record that does not
    // exist is nothing to remove - that is the "already applied on another device" case).
    assert.deepEqual(plan.removeLinkIds, ["p-acc"]);
    assert.deepEqual(plan.removeProposalIds.sort(), ["prop-acc", "prop-rej"]);
    assert.equal(plan.changed, true);
    // Rejected keeps the link with a marker, and the marker is dropped once the record is decided.
    const keptRejected = plan.links.find((link) => link.slug === "rej")!;
    assert.equal(keptRejected.rejectedUtc, "2026-10-15T11:30:00Z");
    assert.equal("proposal" in keptRejected, false);
    // A missing record means the decision was already applied (another device): forget the marker.
    const keptStale = plan.links.find((link) => link.slug === "stale")!;
    assert.equal("proposal" in keptStale, false);
    // An untouched link keeps its proposal reference.
    const keptOpen = plan.links.find((link) => link.slug === "open")!;
    assert.equal(keptOpen.proposal!.proposalId, "prop-open");
    // A still-open proposal belongs to somebody else and survives even without a private link here.
    assert.equal(plan.removeProposalIds.includes("prop-other"), false);
});

test("reconcile reports no change when nothing is proposed", () => {
    const plan = reconcile([makeLink({ linkId: "p1" })], [], "u1");
    assert.equal(plan.changed, false);
    assert.deepEqual(plan.removeLinkIds, []);
    assert.deepEqual(plan.removeProposalIds, []);
    assert.equal(plan.links.length, 1);
});

test("byOrderThenTitle sorts private links by order, then title", () => {
    const items = [makeLink({ slug: "c", title: "Charlie", order: 2 }), makeLink({ slug: "b", title: "Bravo", order: 0 }), makeLink({ slug: "a", title: "Alpha", order: 0 })];
    assert.deepEqual(items.slice().sort(byOrderThenTitle).map((link) => link.slug), ["a", "b", "c"]);
});

// ---- Merged Links hub list (one table with a Status column) ---------------------------------

test("mergedRows merges project and private links, hides hidden ones and sorts by title", () => {
    const project: LinkIndex = {
        id: "links", kind: "links", schemaVersion: 1, revision: 0,
        links: [
            makeLink({ linkId: "a", slug: "build-log", title: "Build log", comment: "latest run" }),
            makeLink({ linkId: "b", slug: "hidden-one", title: "Hidden one", hidden: true }),
            makeLink({ linkId: "c", slug: "docs", title: "Documentation" })
        ],
        trash: []
    };
    const mine = [
        makeLink({ linkId: "p1", slug: "my-report", title: "My report", comment: "mine" }),
        makeLink({ linkId: "p2", slug: "pending-one", title: "Pending one", proposal: { proposalId: "x", proposedUtc: "t" } })
    ];
    const rows = mergedRows(project, mine, "");

    // Alphabetical by title, both groups mixed; a hidden project link is not listed.
    assert.deepEqual(rows.map((row) => row.link.title), ["Build log", "Documentation", "My report", "Pending one"]);
    assert.deepEqual(rows.map((row) => row.status), ["project", "project", "private", "pending"]);
    // Only the user's own links carry actions.
    assert.deepEqual(rows.map((row) => row.mine), [false, false, true, true]);
});

test("mergedRows filters on title, slug and comment, case-insensitively", () => {
    const project: LinkIndex = {
        id: "links", kind: "links", schemaVersion: 1, revision: 0,
        links: [
            makeLink({ linkId: "a", slug: "build-log", title: "Build log", comment: "latest run" }),
            makeLink({ linkId: "c", slug: "docs", title: "Documentation" })
        ],
        trash: []
    };
    const mine = [makeLink({ linkId: "p1", slug: "my-report", title: "My report", comment: "nightly numbers" })];

    assert.deepEqual(mergedRows(project, mine, "BUILD").map((row) => row.link.slug), ["build-log"]);
    assert.deepEqual(mergedRows(project, mine, "docs").map((row) => row.link.slug), ["docs"]);
    // A match in the comment counts too.
    assert.deepEqual(mergedRows(project, mine, "nightly").map((row) => row.link.slug), ["my-report"]);
    // No match, and the empty filter returns everything.
    assert.deepEqual(mergedRows(project, mine, "zzz"), []);
    assert.equal(mergedRows(project, mine, "   ").length, 3);
    // A rejected private link is simply private again.
    const rejected = [makeLink({ linkId: "p2", slug: "nope", title: "Nope", rejectedUtc: "t" })];
    assert.deepEqual(mergedRows(null, rejected, "").map((row) => row.status), ["private"]);
    // No data at all is not an error.
    assert.deepEqual(mergedRows(null, [], ""), []);
});

// Regression (B10): the Security REST API wraps the namespace definition, and looking only at the top
// level made every permission probe answer "unknown" - which fail-safely left every permission-aware
// control visible, so the feature was inert without ever failing a test.
test("findActionBit unwraps the namespace definition the REST API returns", () => {
    const wrapped = {
        count: 1,
        value: [{ namespaceId: "52d39943-cb85-4d7f-8fa8-c6baac873819", name: "Project", actions: [{ name: "GENERIC_READ", bit: 1 }, { name: "MANAGE_PROPERTIES", bit: 16 }] }]
    };
    assert.equal(findActionBit(wrapped, "MANAGE_PROPERTIES"), 16);
    assert.equal(findActionBit(wrapped, "generic_read"), 1);
    assert.equal(findActionBit(wrapped, "missing"), null);
    // Empty or malformed wrappers stay "unknown" rather than guessing.
    assert.equal(findActionBit({ count: 0, value: [] }, "MANAGE_PROPERTIES"), null);
    assert.equal(findActionBit({ count: 1, value: [null] }, "MANAGE_PROPERTIES"), null);
    assert.equal(findActionBit({ count: 1, value: [{ name: "Project" }] }, "MANAGE_PROPERTIES"), null);
    assert.equal(findActionBit({ count: 1, value: "nope" }, "MANAGE_PROPERTIES"), null);
});

// ---- Link form pre-fill from the address bar (bookmarklet) ---------------------------------

test("acceptablePrefillUrl accepts only absolute http(s) URLs within the length cap", () => {
    assert.equal(acceptablePrefillUrl("https://dev.azure.com/contoso/SampleProject/_build/results?buildId=1"), "https://dev.azure.com/contoso/SampleProject/_build/results?buildId=1");
    assert.equal(acceptablePrefillUrl("  http://example.com/report  "), "http://example.com/report");
    // Anything that is not a plain http(s) URL is ignored, so a crafted query cannot inject a target.
    assert.equal(acceptablePrefillUrl("javascript:alert(1)"), "");
    assert.equal(acceptablePrefillUrl("data:text/html,<script>alert(1)</script>"), "");
    assert.equal(acceptablePrefillUrl("file:///c:/secret.txt"), "");
    assert.equal(acceptablePrefillUrl("not a url"), "");
    assert.equal(acceptablePrefillUrl(""), "");
    assert.equal(acceptablePrefillUrl("   "), "");
    // Defensive: the value arrives from a query string, so it may be a non-string.
    assert.equal(acceptablePrefillUrl(undefined), "");
    assert.equal(acceptablePrefillUrl(null), "");
    assert.equal(acceptablePrefillUrl(["https://example.com"]), "");
    assert.equal(acceptablePrefillUrl(42), "");
    // A pathological length is refused rather than echoed into the form.
    assert.equal(acceptablePrefillUrl("https://example.com/" + "a".repeat(2100)), "");
});

// ---- The About tab's add-to-Static bookmarklet (FR-ADM-13) ---------------------------------

test("addLinkBookmarklet builds a self-contained bookmarklet for the installed edition", () => {
    const stable = addLinkBookmarklet("f-steff", "static");
    assert.ok(stable.startsWith("javascript:("));
    // The Links hub owns the private-link form, which is what the bookmarklet must open.
    assert.ok(stable.includes("/_apps/hub/f-steff.static.static-links-hub?url="));
    // The development edition differs only by its extension id, which is why the id is a parameter.
    assert.ok(addLinkBookmarklet("f-steff", "static-dev").includes("/_apps/hub/f-steff.static-dev.static-links-hub?url="));
    // Defensive: an unavailable SDK context falls back to the released ids.
    assert.equal(addLinkBookmarklet("", ""), stable);
    // Pinned so the code block in docs/07 cannot drift from what the extension generates.
    assert.equal(
        stable,
        "javascript:(()=>{const s=location.pathname.split('/').filter(Boolean);const a=/\\.visualstudio\\.com$/.test(location.host);const d=location.host==='dev.azure.com';const o=a?location.host.split('.')[0]:s[0];const p=a?s[0]:(d?s[1]:undefined);const t=p&&p[0]!=='_'?{o:o,p:p}:null;if(!t)return;location.href='https://dev.azure.com/'+t.o+'/'+t.p+'/_apps/hub/f-steff.static.static-links-hub?url='+encodeURIComponent(location.href)})()"
    );
});

test("addLinkBookmarklet hands the current page URL to the Links hub", () => {
    // Run the bookmarklet body with a fake `location`, exactly as a browser would on that page.
    const run = (href: string, pathname: string, host: string, current: string) => {
        const fake = { pathname, host, href: current };
        new Function("location", href.slice("javascript:".length))(fake);
        return fake.href;
    };
    const hub = "https://dev.azure.com/contoso/SampleProject/_apps/hub/f-steff.static.static-links-hub?url=";
    const page = "https://dev.azure.com/contoso/SampleProject/_build/results?buildId=42&view=logs";
    assert.equal(
        run(addLinkBookmarklet("f-steff", "static"), "/contoso/SampleProject/_build/results", "dev.azure.com", page),
        hub + encodeURIComponent(page)
    );
    // Path segments are already encoded, so a project name with a space must not be encoded twice.
    const spaced = "https://dev.azure.com/contoso/My%20Project/_build";
    assert.equal(
        run(addLinkBookmarklet("f-steff", "static"), "/contoso/My%20Project/_build", "dev.azure.com", spaced),
        "https://dev.azure.com/contoso/My%20Project/_apps/hub/f-steff.static.static-links-hub?url=" + encodeURIComponent(spaced)
    );
    // On the legacy host the organization is in the host name, so the first segment is the project.
    const legacy = "https://contoso.visualstudio.com/SampleProject/_build";
    assert.equal(
        run(addLinkBookmarklet("f-steff", "static"), "/SampleProject/_build", "contoso.visualstudio.com", legacy),
        hub + encodeURIComponent(legacy)
    );
    // Outside a project (the organization home) there is nothing to add, so the page is left alone.
    const home = "https://dev.azure.com/contoso/";
    assert.equal(run(addLinkBookmarklet("f-steff", "static"), "/contoso/", "dev.azure.com", home), home);
    // Without a pinned project, an external page has no project either, so it is left alone too.
    const external = "https://example.com/report";
    assert.equal(run(addLinkBookmarklet("f-steff", "static"), "/report", "example.com", external), external);
    // An organization page ('_' segment) is not a project, so it must not be mistaken for one.
    const orgPage = "https://dev.azure.com/contoso/_settings";
    assert.equal(run(addLinkBookmarklet("f-steff", "static"), "/contoso/_settings", "dev.azure.com", orgPage), orgPage);
});

test("addLinkBookmarklet pins a fallback project so a fixed link lands in the right project", () => {
    const href = addLinkBookmarklet("f-steff", "static", { org: "contoso", project: "SampleProject" });
    // The pinned ids are embedded, encoded once.
    assert.ok(href.includes('{o:"contoso",p:"SampleProject"}'));
    const run = (pathname: string, host: string, current: string) => {
        const fake = { pathname, host, href: current };
        new Function("location", href.slice("javascript:".length))(fake);
        return fake.href;
    };
    const hub = "https://dev.azure.com/contoso/SampleProject/_apps/hub/f-steff.static.static-links-hub?url=";
    // A fixed link: the page is external and has no project, so the pinned project is used.
    const external = "https://example.com/reports/coverage.html";
    assert.equal(run("/reports/coverage.html", "example.com", external), hub + encodeURIComponent(external));
    // A page inside another project keeps that project.
    const other = "https://dev.azure.com/contoso/OtherProject/_build/results";
    assert.equal(
        run("/contoso/OtherProject/_build/results", "dev.azure.com", other),
        "https://dev.azure.com/contoso/OtherProject/_apps/hub/f-steff.static.static-links-hub?url=" + encodeURIComponent(other)
    );
    // An organization page ('_' segment) is not a project, so the pinned one is used.
    const orgPage = "https://dev.azure.com/contoso/_settings";
    assert.equal(run("/contoso/_settings", "dev.azure.com", orgPage), hub + encodeURIComponent(orgPage));
    // A project name with a space is encoded once (a space becomes %20, not %2520).
    assert.ok(addLinkBookmarklet("f-steff", "static", { org: "contoso", project: "My Project" }).includes('{o:"contoso",p:"My%20Project"}'));
});

// ---- Error reporting (B11) ------------------------------------------------------------------

test("pendingLabel reports the number of proposals waiting for a decision", () => {
    assert.equal(pendingLabel(1), "1 pending");
    assert.equal(pendingLabel(2), "2 pending");
    assert.equal(pendingLabel(0), "0 pending");
});

test("describeError turns non-Error rejections into something readable", () => {
    assert.equal(describeError(new Error("plain failure")), "plain failure");
    assert.equal(describeError("a string"), "a string");
    // The Extension Data SDK's shape.
    assert.equal(describeError({ name: "AccessCheckException", message: "denied" }), "AccessCheckException: denied");
    // The REST client's TFS.WebApi.Exception: it has no `message`, only a JSON `responseText`.
    assert.equal(
        describeError({ name: "TFS.WebApi.Exception", status: 401, responseText: JSON.stringify({ message: "TF400813: no access" }) }),
        "TFS.WebApi.Exception: TF400813: no access"
    );
    // Without a parsable body, the name and the status still beat "[object Object]".
    assert.equal(describeError({ name: "TFS.WebApi.Exception", status: 401 }), "TFS.WebApi.Exception HTTP 401");
    // A non-JSON body is surfaced as-is (bounded).
    assert.equal(describeError({ responseText: "Bad gateway" }), "Bad gateway");
    // Anything at all still prints.
    assert.equal(describeError(42), "42");
    assert.equal(describeError(null), "null");
});
