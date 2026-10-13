// Compute and apply the next extension version for an edition, from git tags.
//
// Rationale: the Marketplace requires versions to increase monotonically, and every published
// version must be tagged. Tags are the source of truth:
//   - stable tags are `v0.<minor>.0`;
//   - dev tags are `v0.<minor>.<revision>` (revision >= 1).
// Rules: major stays 0; minor bumps (revision resets to 0) on a merge to `main`; revision bumps on
// a merge to `develop`. Usage: `node ci/version.mjs <dev|stable> [--write]`.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const edition = process.argv[2];
const write = process.argv.includes("--write");

if (edition !== "dev" && edition !== "stable") {
  console.error("Usage: node ci/version.mjs <dev|stable> [--write]");
  process.exit(1);
}

/** All release tags as { minor, revision }. */
function readTags() {
  const out = execFileSync("git", ["tag", "-l", "v*"], { encoding: "utf8" });
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((tag) => {
      const match = tag.match(/^v(\d+)\.(\d+)\.(\d+)$/);
      return match ? { minor: Number(match[2]), revision: Number(match[3]) } : null;
    })
    .filter(Boolean);
}

const tags = readTags();
// The highest released minor (stable) is the base; with no stable tag yet the base minor is 0.
const stableMinors = tags.filter((t) => t.revision === 0).map((t) => t.minor);
const baseMinor = stableMinors.length > 0 ? Math.max(...stableMinors) : 0;

let version;
if (edition === "stable") {
  version = `0.${baseMinor + 1}.0`;
} else {
  const revisions = tags.filter((t) => t.minor === baseMinor && t.revision > 0).map((t) => t.revision);
  const nextRevision = revisions.length > 0 ? Math.max(...revisions) + 1 : 1;
  version = `0.${baseMinor}.${nextRevision}`;
}
const tag = `v${version}`;

if (write) {
  // Write the version into the edition override and package.json.
  const overrideFile = path.join(rootDir, "ado-manifests", `azure-devops-extension-${edition}.json`);
  const override = JSON.parse(fs.readFileSync(overrideFile, "utf8"));
  override.version = version;
  fs.writeFileSync(overrideFile, JSON.stringify(override, null, 4) + "\n");
  const pkgFile = path.join(rootDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  pkg.version = version;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
}

// Emit for the workflow ($GITHUB_OUTPUT) and for local use.
console.log(`version=${version}`);
console.log(`tag=${tag}`);
