// Thin wrapper around tfx-cli.
//
// Rationale: keeps one shared base manifest (contributions/files/scopes) while allowing
// distinct dev/ppe/prod ids and publishers, and it injects the environment-specific feature
// id into the Pages hub group's Feature constraint. The feature id is namespaced by
// publisher + extension id, so it cannot be hard-coded in the shared base manifest.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const binDir = path.join(rootDir, "node_modules", ".bin");
const isWindows = process.platform === "win32";

// Usage: node scripts/tfx.js <create|publish|share|unshare|show> <dev|stable>
const commands = ["create", "publish", "share", "unshare", "show"];
const [command, configName] = process.argv.slice(2);

if (!command || !configName || commands.indexOf(command) < 0) {
  console.error("Usage: node scripts/tfx.js <create|publish|share|unshare|show> <dev|stable>");
  process.exit(1);
}

const baseManifest = path.join(rootDir, "ado-manifests", "azure-devops-extension-base.json");
const overridesFile = path.join(rootDir, "ado-manifests", `azure-devops-extension-${configName}.json`);

// Build the effective manifest (base + overrides) and inject the feature constraint.
const manifestPath = buildEffectiveManifest(configName, baseManifest, overridesFile);

const tfxCmd = resolveTfx(path.join(binDir, isWindows ? "tfx.ps1" : "tfx"));
const args = buildArgs(command, manifestPath);

// Capture output so a known-benign failure can be told apart from a real one, then re-print it so the
// log stays exactly as the reader expects.
const result = spawnSync(...buildSpawnCommand(tfxCmd, args), { encoding: "utf8", shell: false });
if (result.stdout) {
  process.stdout.write(result.stdout);
}
if (result.stderr) {
  process.stderr.write(result.stderr);
}

if (result.error) {
  console.error("Unable to run tfx. Install it with: npm install -g tfx-cli");
  process.exit(1);
}

const status = result.status || 0;
// Rationale: the Marketplace sometimes takes longer than tfx's wait window to validate an upload. The
// publish has already succeeded at that point, so failing here would block the version tag - and
// without the tag the next publish computes the same version and is rejected with "version number
// must increase". Treat the wait timeout as success (the watchdog still reports a real invalid).
if (status !== 0 && /Validation is taking much longer than usual/i.test(`${result.stdout || ""}${result.stderr || ""}`)) {
  console.warn("Marketplace validation is still running; the upload succeeded, so this is not a failure.");
  process.exit(0);
}

// Propagate tfx's exit code so npm reports success/failure correctly.
process.exit(status);

/** Reads JSON with a clear error if the file is missing or malformed. */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Builds the tfx argument list for a command.
 * Rationale: `create`/`publish` consume the merged manifest, whereas `share`/`unshare` address the
 * extension by publisher + id. Organizations come from ADO_SHARE_ORGS / ADO_SHARE_WITH and are
 * passed as REPEATED flags: tfx splits a single value on commas only, so a space-separated list in
 * one quoted argument would be treated as a single (invalid) organization name.
 */
function buildArgs(command, manifestFile) {
  if (command === "share" || command === "unshare") {
    const manifest = readJson(manifestFile);
    const flag = command === "share" ? "--share-with" : "--unshare-with";
    const args = ["extension", command, "--publisher", manifest.publisher, "--extension-id", manifest.id];
    const orgs = orgList(process.env.ADO_SHARE_ORGS);
    if (orgs.length === 0) {
      console.error("Set ADO_SHARE_ORGS to one or more organizations (comma- or space-separated).");
      process.exit(1);
    }
    orgs.forEach((org) => args.push(flag, org));
    return appendToken(args);
  }
  if (command === "show") {
    // `show --json` is how the sharing list is read back: the Marketplace keeps it, and the extension
    // info carries a `sharedWith` array (see ci/shared-with.mjs).
    const manifest = readJson(manifestFile);
    return appendToken([
      "extension",
      "show",
      "--publisher",
      manifest.publisher,
      "--extension-id",
      manifest.id,
      "--json"
    ]);
  }
  const args = ["extension", command === "create" ? "create" : "publish", "--manifests", manifestFile];
  // Publish-only extras come from the environment so no secrets live in the repo.
  if (command === "publish") {
    orgList(process.env.ADO_SHARE_WITH).forEach((org) => args.push("--share-with", org));
  }
  return appendToken(args);
}

/** Splits a comma- or whitespace-separated organization list into trimmed, non-empty names. */
function orgList(value) {
  return (value || "").split(/[\s,]+/).filter(Boolean);
}

/** Appends the Marketplace token when the environment provides one. */
function appendToken(args) {
  const token = process.env.TFS_PAT;
  if (token) {
    args.push("--token", token);
  }
  return args;
}

/** Recursively merges plain objects; arrays and scalars from the override win. */
function deepMerge(base, override) {
  if (Array.isArray(override)) {
    return override.slice();
  }
  if (override && typeof override === "object" && base && typeof base === "object") {
    const out = { ...base };
    for (const key of Object.keys(override)) {
      out[key] = key in base ? deepMerge(base[key], override[key]) : override[key];
    }
    return out;
  }
  return override;
}

/**
 * Merges the base manifest with the chosen override and writes a generated manifest that
 * tfx consumes. Rationale: the base holds shared pieces; the override supplies
 * id/version/publisher for the target environment.
 */
function buildEffectiveManifest(configName, baseFile, overrideFile) {
  const merged = deepMerge(readJson(baseFile), readJson(overrideFile));

  // tfx consumes a single manifest path, so write the merged result to a generated file
  // (git-ignored) at the repository root, so all manifest paths are repo-root-relative.
  const generated = path.join(rootDir, `.generated-${configName}.json`);
  fs.writeFileSync(generated, JSON.stringify(merged, null, 4));
  return generated;
}

/**
 * Prefers a locally installed tfx, then a globally installed one, then the bare name.
 * Rationale: works both for `npm ci` users and global installs.
 */
function resolveTfx(localPath) {
  if (fs.existsSync(localPath)) {
    return localPath;
  }
  const globalPath = getGlobalTfxPath();
  if (globalPath && fs.existsSync(globalPath)) {
    return globalPath;
  }
  return isWindows ? "tfx.ps1" : "tfx";
}

/** Locates the globally installed tfx using npm's configured prefix. */
function getGlobalTfxPath() {
  try {
    const npmPrefix = spawnSync("npm", ["config", "get", "prefix"], {
      encoding: "utf8",
      shell: true
    });
    const prefix = (npmPrefix.stdout || "").trim();
    if (!prefix) {
      return null;
    }
    return isWindows ? path.join(prefix, "tfx.ps1") : path.join(prefix, "bin", "tfx");
  } catch (_error) {
    return null;
  }
}

/** Windows needs tfx.ps1 launched through powershell.exe; other platforms exec directly. */
function buildSpawnCommand(tfxPath, tfxArgs) {
  if (isWindows && tfxPath.toLowerCase().endsWith(".ps1")) {
    return ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tfxPath, ...tfxArgs]];
  }
  return [tfxPath, tfxArgs];
}
