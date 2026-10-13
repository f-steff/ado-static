// Test runner: bundles the TypeScript tests with esbuild, then runs Node's test runner.
//
// Rationale: the source is TypeScript and Node cannot import it directly; bundling keeps a
// single dependency (esbuild) and lets the pure logic be tested without the ADO host. The
// pipeline tasks are plain CommonJS (no bundler, no dependencies), so they run directly.
const esbuild = require("esbuild");
const { spawnSync } = require("child_process");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const outFile = path.join(rootDir, "dist-test", "logic.test.mjs");

esbuild.buildSync({
    entryPoints: [path.join(rootDir, "tests", "logic.test.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    outfile: outFile
});

const result = spawnSync(
    process.execPath,
    ["--test", outFile, path.join(rootDir, "tests", "tasks.test.js")],
    { stdio: "inherit" }
);
process.exit(result.status || 0);
