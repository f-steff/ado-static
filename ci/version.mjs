// Compute and apply the next extension version for an edition, from git tags.
//
// Rationale: the Marketplace requires versions to increase monotonically, and every published version
// must be tagged. Both editions share ONE tag sequence, which is what makes them comparable:
//   - a release (`main`) publishes BOTH editions at `0.<minor + 1>.0`;
//   - a `develop` merge publishes the dev edition at `0.<minor>.<revision + 1>`.
// So a dev version reads as "the current release plus N development merges" (0.1.0 -> 0.1.1 -> 0.2.0).
// Usage: `node ci/version.mjs <dev|stable> [--write|--write-all] [--version <x.y.z>]`.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The next version for an edition, given every release tag ({ minor, revision }; major stays 0).
 * Pure, so the release rules can be unit-tested without git:
 *   - stable: the next minor, revision 0 (based on the highest revision-0 tag);
 *   - dev: the current minor, next revision.
 */
export function nextVersion(edition, tags) {
  const stableMinors = tags.filter((t) => t.revision === 0).map((t) => t.minor);
  const baseMinor = stableMinors.length > 0 ? Math.max(...stableMinors) : 0;
  if (edition === "stable") {
    return `0.${baseMinor + 1}.0`;
  }
  const revisions = tags.filter((t) => t.minor === baseMinor && t.revision > 0).map((t) => t.revision);
  const nextRevision = revisions.length > 0 ? Math.max(...revisions) + 1 : 1;
  return `0.${baseMinor}.${nextRevision}`;
}

/** Parses `git tag -l` output into release tags; anything that is not `vX.Y.Z` is ignored. */
export function parseTags(output) {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((tag) => {
      const match = tag.match(/^v\d+\.(\d+)\.(\d+)$/);
      return match ? { minor: Number(match[1]), revision: Number(match[2]) } : null;
    })
    .filter(Boolean);
}

/** Reads the repository's release tags. */
function readTags() {
  return parseTags(execFileSync("git", ["tag", "-l", "v*"], { encoding: "utf8" }));
}

/** Writes the version into one edition's override manifest and into package.json. */
function writeVersion(edition, version) {
  const overrideFile = path.join(rootDir, "ado-manifests", `azure-devops-extension-${edition}.json`);
  const override = JSON.parse(fs.readFileSync(overrideFile, "utf8"));
  override.version = version;
  fs.writeFileSync(overrideFile, JSON.stringify(override, null, 4) + "\n");
  const pkgFile = path.join(rootDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  pkg.version = version;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
}

// Only act as a CLI: importing the pure helpers (unit tests) must not touch git or the filesystem.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const edition = process.argv[2];
  if (edition !== "dev" && edition !== "stable") {
    console.error("Usage: node ci/version.mjs <dev|stable> [--write|--write-all] [--version <x.y.z>]");
    process.exit(1);
  }

  // `--version` exists for one-off/manual publishes (e.g. aligning the dev edition with a release that
  // predates the automatic dual publish). The Marketplace still enforces monotonicity, so a version
  // that is too low fails there rather than silently breaking the sequence.
  const versionIndex = process.argv.indexOf("--version");
  const explicit = versionIndex >= 0 ? process.argv[versionIndex + 1] : "";
  if (versionIndex >= 0 && !/^\d+\.\d+\.\d+$/.test(explicit || "")) {
    console.error("--version requires a version like 0.1.0");
    process.exit(1);
  }

  const version = explicit || nextVersion(edition, readTags());
  if (process.argv.includes("--write-all")) {
    // A release publishes the dev edition at the same version, so both overrides carry it.
    writeVersion("dev", version);
    writeVersion("stable", version);
  } else if (process.argv.includes("--write")) {
    writeVersion(edition, version);
  }

  // Emitted for the workflow ($GITHUB_OUTPUT) and for local use.
  console.log(`version=${version}`);
  console.log(`tag=v${version}`);
}
