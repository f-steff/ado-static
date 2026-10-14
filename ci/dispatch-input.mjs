// Read a workflow_dispatch input without ever letting its value reach the log.
//
// Rationale: a dispatch input is not secret, and the runner prints a step's `env:` block BEFORE the
// step runs - so passing the value through `env:` (or through the script text) reveals it once, or, as
// a job-level variable, once per earlier step. The event payload file is only a PATH, so a script can
// read the value from it and hand it on without printing anything:
//
//   node ci/dispatch-input.mjs <input> mask            -> the `::add-mask::` workflow command
//   node ci/dispatch-input.mjs <input> export <VAR>    -> `export VAR='value'`, for `eval`
//
// The mask keeps tfx's own output ("Sharing extension with ...", the "Shared with" list) redacted; the
// export keeps the value inside the shell, so the runner never sees it either.
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/** Reads a dispatch input from an event payload; empty string when it is absent. */
export function dispatchInput(payload, name) {
  const inputs = payload && typeof payload === "object" ? payload.inputs : null;
  const value = inputs && typeof inputs === "object" ? inputs[name] : undefined;
  return typeof value === "string" ? value : "";
}

/** Quotes a value for POSIX sh: single quotes, with embedded quotes escaped. */
export function shellQuote(value) {
  return `'${String(value).split("'").join(`'\\''`)}'`;
}

/** CLI entry point. */
function main() {
  const [name, mode, variable] = process.argv.slice(2);
  if (!name || (mode !== "mask" && mode !== "export")) {
    console.error("Usage: node ci/dispatch-input.mjs <input> <mask|export <VAR>>");
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8"));
  const value = dispatchInput(payload, name);
  if (!value) {
    console.error(`No '${name}' input was provided for this run.`);
    process.exit(1);
  }
  console.log(mode === "mask" ? `::add-mask::${value}` : `export ${variable}=${shellQuote(value)}`);
}

// Only run as a CLI: importing the helpers (unit tests) must not read the environment or stdin.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
