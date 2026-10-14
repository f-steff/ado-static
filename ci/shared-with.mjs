// Turn `tfx extension show --json` output into a markdown access list.
//
// Rationale: the Marketplace keeps the list of organizations a private extension is shared with, and
// that list is the only authoritative record (the extension deliberately stores no copy). The tfx
// `show` command returns the extension info, whose `sharedWith` array names them - so the share
// workflow can report the real state instead of only what the run just changed.
//
// Usage: node scripts/tfx.js show dev --json | node ci/shared-with.mjs

import { pathToFileURL } from "node:url";

/**
 * Formats the organizations from an extension-info object as markdown bullets.
 * Pure, so it can be unit-tested; accepts the parsed JSON (or null when unreadable).
 */
export function formatSharedWith(info) {
  if (!info || typeof info !== "object") {
    return "_Could not read the access list from the Marketplace._";
  }
  const shared = Array.isArray(info.sharedWith) ? info.sharedWith : [];
  const names = shared.map((entry) => (entry && entry.name ? String(entry.name) : "")).filter(Boolean);
  if (names.length === 0) {
    return "_Not shared with any organization yet._";
  }
  return names.map((name) => `- \`${name}\``).join("\n");
}

/** Reads stdin and prints the formatted list (CLI entry point). */
async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(input);
  } catch {
    parsed = null;
  }
  console.log(formatSharedWith(parsed));
}

// Only run as a CLI: importing the helper (unit tests) must not consume stdin.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
