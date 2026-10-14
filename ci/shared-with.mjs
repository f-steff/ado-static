// Summarise `tfx extension show --json` output for the share workflow.
//
// Rationale: the Marketplace keeps the list of organizations a private extension is shared with, and
// that list is the only authoritative record (the extension deliberately stores no copy). The share
// workflow runs in a PUBLIC repository, so its summary must not name them: this reports a count, and
// the names stay on the authenticated publisher page.
//
// Usage: node scripts/tfx.js show dev | node ci/shared-with.mjs

import { pathToFileURL } from "node:url";

/**
 * Parses `tfx extension show` output.
 * Rationale: tfx prints its banner ("TFS Cross Platform Command Line Interface ...") and operation
 * text around the JSON, so a plain `JSON.parse` of stdout fails - the object has to be extracted.
 * Exported for the tests, which pin the banner case.
 */
export function parseExtensionInfo(text) {
  const first = (text || "").indexOf("{");
  const last = (text || "").lastIndexOf("}");
  if (first < 0 || last <= first) {
    return null;
  }
  try {
    return JSON.parse(text.slice(first, last + 1));
  } catch {
    return null;
  }
}

/**
 * Summarises an extension-info object as a count of organizations that have access.
 * Pure, so it can be unit-tested; accepts the parsed JSON (or null when unreadable).
 */
export function summariseSharedWith(info) {
  if (!info || typeof info !== "object") {
    return "_Could not read the access list from the Marketplace._";
  }
  const shared = Array.isArray(info.sharedWith) ? info.sharedWith : [];
  const count = shared.filter((entry) => entry && entry.name).length;
  if (count === 0) {
    return "_No organization currently has access._";
  }
  // Correct verb agreement, and never the names: the summary is public.
  return `**${count}** organization${count === 1 ? "" : "s"} ${count === 1 ? "has" : "have"} access (the names are on the publisher page).`;
}

/** Reads stdin and prints the summary (CLI entry point). */
async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  console.log(summariseSharedWith(parseExtensionInfo(input)));
}

// Only run as a CLI: importing the helper (unit tests) must not consume stdin.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
