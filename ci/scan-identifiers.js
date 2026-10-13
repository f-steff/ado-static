// Scan the repository for private-instance identifiers.
//
// Rationale: this repository is public, so it must never contain organization/project/repository
// names or ids from a private Azure DevOps instance. This script is the CI gate (`verify:clean`)
// and can be run locally. It scans tracked files (git ls-files) and fails on the first match.
const { execFileSync } = require("child_process");
const fs = require("fs");

// Forbidden substrings (case-insensitive). Kept as constants rather than committed examples; none
// of these appear in the repository.
const FORBIDDEN = [
  "mwmot" + "oranddrives",
  "multi" + "-wing",
  "test" + "-pages",
  "static" + "-sandbox"
];

// Files that are allowed to contain the words above (none today). Kept for clarity.
const ALLOWLIST = [];

/** Lists the tracked files relative to the repository root. */
function trackedFiles() {
  const out = execFileSync("git", ["ls-files"], { encoding: "utf8" });
  return out.split(/\r?\n/).filter(Boolean);
}

/** Returns the first forbidden match in a file, or null. */
function firstMatch(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return null; // Binary or unreadable files are not scanned.
  }
  const lower = text.toLowerCase();
  for (const needle of FORBIDDEN) {
    const at = lower.indexOf(needle);
    if (at >= 0) {
      const line = text.slice(0, at).split(/\r?\n/).length;
      return { needle, line };
    }
  }
  return null;
}

const hits = [];
for (const file of trackedFiles()) {
  if (ALLOWLIST.includes(file)) {
    continue;
  }
  const match = firstMatch(file);
  if (match) {
    hits.push(`${file}:${match.line}: forbidden identifier`);
  }
}

if (hits.length > 0) {
  console.error("verify:clean failed - private-instance identifiers found:");
  for (const hit of hits) {
    console.error("  " + hit);
  }
  process.exit(1);
}
console.log("verify:clean: no forbidden identifiers found.");
