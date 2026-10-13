// Build script: bundles the TypeScript entry points with esbuild and copies static assets
// into dist/. Rationale: esbuild is fast and dependency-light; we keep one bundle per UI
// entry point (currently the hub) so the packaged extension stays small.
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

// `--mode=production` toggles minification and disables source maps / dev logging.
const args = process.argv.slice(2);
const isProduction = args.includes("--mode=production");

const rootDir = path.join(__dirname, "..");
const srcDir = path.join(rootDir, "src");
const distDir = path.join(rootDir, "dist");

build()
  .then(() => copyAssets())
  .catch((error) => {
    // Fail loudly: a partially built extension must not be packaged.
    console.error(error);
    process.exit(1);
  });

/**
 * Bundles each UI entry point into dist/<name>/<name>.js.
 * Rationale: `entryNames: "[name]/[name]"` mirrors the source tree so the copied HTML can
 * reference its script with a simple relative path (`./hub.js`).
 */
async function build() {
  await esbuild.build({
    entryPoints: [
      // One bundle per UI entry point: hub, links, repos, project-settings admin, org admin.
      path.join(srcDir, "hub", "hub.ts"),
      path.join(srcDir, "links", "links.ts"),
      path.join(srcDir, "pipelines", "pipelines.ts"),
      path.join(srcDir, "pr", "pr.ts"),
      path.join(srcDir, "repos", "repos.ts"),
      path.join(srcDir, "admin", "admin.ts"),
      path.join(srcDir, "orgadmin", "orgadmin.ts"),
      // Build-results report tab (shows a page attached by a PublishPage run).
      path.join(srcDir, "reporttab", "reporttab.ts")
    ],
    outdir: distDir,
    bundle: true,
    format: "iife",
    target: "es2019",
    entryNames: "[name]/[name]",
    sourcemap: !isProduction,
    minify: isProduction,
    define: {
      // Injected so src/common/log.ts can switch verbosity without a runtime check.
      __DEV__: isProduction ? "false" : "true"
    },
    logLevel: "info"
  });
}

/**
 * Copies non-TS assets (.html/.css) into dist, preserving their relative paths.
 * Rationale: esbuild only handles JS/TS; the HTML shells and stylesheets must ship too.
 */
function copyAssets() {
  const patterns = [".html", ".css"];
  const files = walkFiles(srcDir);

  files
    .filter((file) => patterns.includes(path.extname(file)))
    .forEach((file) => {
      const relativePath = path.relative(srcDir, file);
      const outPath = path.join(distDir, relativePath);
      const outDir = path.dirname(outPath);
      fs.mkdirSync(outDir, { recursive: true });
      fs.copyFileSync(file, outPath);
    });
}

/** Recursively lists files under a directory (assets can live in subfolders). */
function walkFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
    } else {
      files.push(entryPath);
    }
  }
  return files;
}
