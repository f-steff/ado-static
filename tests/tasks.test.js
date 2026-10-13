// Tests for the plain-Node pipeline tasks.
//
// Rationale: the tasks ship as standalone Node folders (no bundler, no dependencies), so they cannot
// be imported from the TypeScript test file. They are plain CommonJS, though, so Node's test runner
// executes them directly - which also proves they run on the agent's Node without esbuild.
const test = require("node:test");
const assert = require("node:assert/strict");

const { crc32, readZip, writeZip } = require("../tasks/StaticAdmin/zip");
const { ENTRY_NAME, buildBundle, parseBundle, withoutEtag } = require("../tasks/StaticAdmin/bundle");

test("task ZIP round-trips entries and computes CRCs", () => {
    assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
    // Long, repetitive data proves the deflate path; the empty entry proves the stored path.
    const data = Buffer.from('{"page":"content"}'.repeat(400), "utf8");
    const zip = writeZip(
        [
            { name: ENTRY_NAME, data },
            { name: "empty.bin", data: Buffer.alloc(0) }
        ],
        new Date("2026-10-13T10:00:00Z")
    );
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    const entries = readZip(zip);
    assert.deepEqual([...entries.keys()], [ENTRY_NAME, "empty.bin"]);
    assert.equal(entries.get(ENTRY_NAME).equals(data), true);
    assert.equal(entries.get("empty.bin").length, 0);
});

test("task ZIP reader accepts a stored entry (as written by the settings UI)", () => {
    // Mirrors src/common/zip.ts: the UI stores entries uncompressed, so the task must read that too.
    const name = Buffer.from("static-backup.json", "utf8");
    const data = Buffer.from("{}", "utf8");
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10); // stored
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);
    name.copy(central, 46);

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(local.length + data.length, 16);

    const entries = readZip(Buffer.concat([local, data, central, end]));
    assert.equal(entries.get("static-backup.json").toString("utf8"), "{}");
});

test("task bundle round-trips, drops etags and rejects foreign input", () => {
    const bundle = buildBundle(
        [{ projectId: "p1", projectName: "SampleProject", documents: [{ id: "index", __etag: "x" }] }],
        { publisher: "f-steff", extension: "static-dev", organization: "contoso" },
        new Date("2026-10-13T10:00:00Z")
    );
    assert.equal(bundle.format, "static-export");
    assert.equal(bundle.schemaVersion, 2);
    assert.equal(bundle.exportedUtc, "2026-10-13T10:00:00.000Z");
    assert.equal("__etag" in bundle.projects[0].documents[0], false);

    const parsed = parseBundle(JSON.stringify(bundle));
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
        assert.equal(parsed.bundle.source.organization, "contoso");
        assert.equal(parsed.bundle.projects[0].projectName, "SampleProject");
        assert.equal("__etag" in parsed.bundle.projects[0].documents[0], false);
    }

    assert.equal(parseBundle("").ok, false);
    assert.equal(parseBundle("not json").ok, false);
    assert.equal(parseBundle(JSON.stringify({ format: "other", projects: [] })).ok, false);
    assert.equal(parseBundle(JSON.stringify({ format: "static-export", projects: [{}] })).ok, false);
    assert.equal(
        parseBundle(
            JSON.stringify({ format: "static-export", projects: [{ projectId: "p1", documents: [{ kind: "x" }] }] })
        ).ok,
        false
    );
});

test("withoutEtag copies rather than mutating", () => {
    const document = { id: "index", __etag: "keep-me" };
    const copy = withoutEtag(document);
    assert.equal("__etag" in copy, false);
    assert.equal(document.__etag, "keep-me");
});

test("every task's 'auto' edition choice prefers the installed edition and warns when both exist", () => {
    // Keeping the three copies identical is deliberate: the helpers are duplicated per task folder
    // (the folders ship independently), so this asserts they share one behaviour.
    ["PublishPage", "PublishLink", "StaticAdmin"].forEach((task) => {
        const { autoEditionChoice } = require(`../tasks/${task}/index.js`);
        assert.deepEqual(autoEditionChoice(false, false), { extension: "", warning: "" });
        assert.equal(autoEditionChoice(true, false).extension, "static");
        assert.equal(autoEditionChoice(true, false).warning, "");
        assert.equal(autoEditionChoice(false, true).extension, "static-dev");
        assert.equal(autoEditionChoice(false, true).warning, "");
        assert.equal(autoEditionChoice(true, true).extension, "static");
        assert.match(autoEditionChoice(true, true).warning, /Both Static editions/);
    });
});
