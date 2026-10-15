// The link editor: form + cascading URL builder, shared by the project settings and the Links hub.
//
// Rationale: both surfaces edit exactly the same thing (a link with a title, a slug, a URL, an
// optional comment and an optional dynamic target), so the form, the builder and the validation live
// here once instead of drifting apart in two bundles. The draft state is module scope on purpose: a
// page re-renders by rebuilding its DOM, so keeping the draft outside the elements is what stops a
// re-render (or a tab switch) from losing what was typed.

import { currentProjectId, currentProjectName, organizationName } from "./data-service";
import { projectBaseUrl } from "./extension-urls";
import { BuilderOption, buildTargets, composePath, rootOptions } from "./link-builder";
import { consumedParams, isFixedArea, targetMatches } from "./builder-core";
import {
  DynamicSpec,
  LOG_JOB_TOKEN,
  LOG_STAGE_TOKEN,
  LOG_TASK_TOKEN,
  hasAnyToken,
  hasToken,
  normalizeTokens
} from "./dynamic-links";
import { checkProjectUrl, describeProjectUrl } from "./ado-url";
import { fixedUrlError, isHttpUrl } from "./link-url";
import { getBuildInfo, getBuildTimeline } from "./build-service";
import { slugError as validateSlug } from "./validation";
import { el, textField } from "./dom";
import { logDebug } from "./log";

/** What the editor edits. */
export interface LinkDraft {
  title: string;
  slug: string;
  url: string;
  comment: string;
  dynamic?: DynamicSpec;
  /** "fixed" when the link may point outside the project (the builder's Fixed area). */
  area?: string;
}

export interface LinkEditorOptions {
  /**
   * Slugs already in use that this link must not collide with, excluding the link being edited.
   * Evaluated on each validation so the caller can hand in fresh state (the hub checks project links
   * too, because a project link wins when both are addressed by the same bookmark).
   */
  takenSlugs: () => string[];
  /** Guidance shown while the form is valid (replaces the built-in note). */
  hint?: string;
  /** Primary button label: add mode, then edit mode. */
  addLabel: string;
  saveLabel: string;
  /** Called with a valid draft when the primary button is pressed. */
  onSave: (draft: LinkDraft) => void | Promise<void>;
  /** Called when the secondary button is pressed (Clear in add mode, Cancel in edit mode). */
  onCancel?: () => void;
  /** Called whenever the draft changes (the caller may re-render its own summary). */
  onChange?: () => void;
}

export interface LinkEditor {
  /** Builds the form (call it from your render; the draft state survives). */
  buildForm(): HTMLElement;
  /** Fills the editor. `editing` locks the slug and switches the buttons to edit mode. */
  setDraft(draft: Partial<LinkDraft>, editing: boolean): void;
  /** Applies only the given fields, keeping the rest (used by the Create shortcuts). */
  patch(values: Partial<LinkDraft>): void;
  /** Parses the current URL (or `overrideUrl`) as if it had just been pasted. */
  parse(overrideUrl?: string): void;
  /** Clears everything back to add mode. */
  reset(): void;
  /** The current draft, trimmed the way a save would store it. */
  draft(): LinkDraft;
}

// ---- draft state (module scope: survives a re-render) -----------------------------------------

let draftTitle = "";
let draftSlug = "";
let draftUrl = "";
let draftComment = "";
let draftDynamic: DynamicSpec | undefined;
// True while an existing link is being edited (locks the slug, changes the button labels).
let editing = false;
// Cascading builder state. Kept for the whole page so the tree of selections (and every branch you
// have visited) survives a re-render.
let builderChosen: BuilderOption[] = [];
let builderLevels: BuilderOption[][] = [rootOptions()];
let builderSelected: string[] = [];
let builderContainer: HTMLElement | null = null;
// The URL input (updated by the builder).
let urlInput: HTMLInputElement | null = null;
// Re-runs validation (so builder/paste changes update the primary button).
let formRefresh: (() => void) | null = null;
// Last builder note (informational, or an error such as a missing permission).
let builderError = "";
// Guards overlapping paste runs (a paste fires both a paste and a change event).
let pasteGeneration = 0;
// The last URL that was parsed; skipping an identical value avoids a second, jumpy re-parse.
let lastParsedUrl = "";
// Loaded options per parent path (avoids re-fetching when you go back).
const builderCache = new Map<string, BuilderOption[]>();
// Remembered child selection per parent path (restores a branch when you return to it).
const builderMemory = new Map<string, string>();
// Soft memory: the last chosen option key per level, independent of the parent path (matches the
// closest target by name when an earlier level changes).
const builderLevelMemory: string[] = [];
// The last log target chosen; log targets are stored by NAME, so this exact option can be carried
// forward unchanged when the pipeline/build/mode changes.
let builderLastLogTarget: BuilderOption | null = null;
// The options of the editor currently on screen (one editor per page).
let editorOptions: LinkEditorOptions | null = null;

/** The project base URL a link must stay inside (unless its area is Fixed). */
function linkBase(): string {
  return projectBaseUrl();
}

/** Slug validation against the caller's reserved slugs (project links and the user's own). */
function slugProblem(): string {
  const taken = editorOptions ? editorOptions.takenSlugs() : [];
  // `false` for allowExisting: the caller excludes the link being edited from `taken`, so the check
  // still applies to a renamed slug (and reserved slugs stay reserved in both modes).
  return validateSlug(draftSlug, taken, false, "link");
}

/** URL validation: required, and either a tokenized builder URL or a valid in-project URL. */
function urlProblem(): string {
  const url = draftUrl.trim();
  // A fixed link is any absolute http(s) URL (it need not be in-project).
  if (isFixedArea(builderChosen)) {
    return fixedUrlError(url);
  }
  if (!url) {
    return "Choose options (or paste a URL) to build a link.";
  }
  if (hasToken(url)) {
    const base = linkBase();
    return url.startsWith(base + "/") ? "" : `The link must be inside this project (${base}).`;
  }
  const check = checkProjectUrl(url, organizationName(), currentProjectName(), currentProjectId());
  return check.ok ? "" : check.error || "Invalid URL.";
}

/** Dynamic validation: the chosen path must be valid and the token present. */
function dynamicProblem(): string {
  if (builderChosen.length > 0) {
    const result = composePath(linkBase(), builderChosen);
    if (!result.terminal) {
      return "Pick a valid link target (an option marked [valid]).";
    }
  }
  if (draftDynamic && !hasAnyToken(draftUrl)) {
    return "The link is missing its placeholder ({{dyn}} or a log target).";
  }
  return "";
}

/** True when the draft may be submitted. */
function valid(): boolean {
  return (
    draftTitle.trim().length > 0 &&
    draftSlug.trim().length > 0 &&
    !slugProblem() &&
    !urlProblem() &&
    !dynamicProblem()
  );
}

/** Path key for the parent of a level (used for the builder cache/memory). */
function builderParentKey(level: number): string {
  return builderChosen
    .slice(0, level)
    .map((option) => option.key)
    .join(">");
}

/** Path key including the option at a level (the parent key for the next level). */
function builderPathKey(level: number): string {
  return builderChosen
    .slice(0, level + 1)
    .map((option) => option.key)
    .join(">");
}

/** Renders the builder's level selects (with a filter for long option lists). */
function renderBuilder(): void {
  if (!builderContainer) {
    return;
  }
  builderContainer.innerHTML = "";
  if (builderError) {
    // Informational notes ("Detected a pipeline link") are not errors, so they use the neutral hint
    // style; the form's own validation shows the red hint below the form.
    builderContainer.appendChild(el("p", "hint builder-note", builderError));
  }
  for (let level = 0; level < builderLevels.length; level += 1) {
    const options = builderLevels[level];
    if (!options || options.length === 0) {
      break;
    }
    const row = el("div", "form-row");
    row.appendChild(el("span", "form-label", level === 0 ? "Area" : `Level ${level + 1}`));
    const placeholder = level === 0 ? "(choose an area)" : "(choose)";
    const select = document.createElement("select");
    // Fills the select from the (optionally filtered) option list, keeping the current choice.
    const fill = (needle: string) => {
      const wanted = needle.trim().toLowerCase();
      select.innerHTML = "";
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = placeholder;
      select.appendChild(blank);
      options
        .filter((option) => !wanted || option.label.toLowerCase().indexOf(wanted) >= 0)
        .forEach((option) => {
          const choice = document.createElement("option");
          choice.value = option.key;
          choice.textContent = option.terminal ? `${option.label}  [valid]` : option.label;
          select.appendChild(choice);
        });
      select.value = builderSelected[level] || "";
    };
    fill("");
    select.addEventListener("change", () => void onBuilderChange(level, select.value));
    row.appendChild(select);
    // A filter keeps a long list (e.g. 200 log targets) usable.
    if (options.length > 12) {
      const filterInput = document.createElement("input");
      filterInput.type = "text";
      filterInput.className = "level-filter";
      filterInput.placeholder = `Filter ${options.length} options...`;
      filterInput.addEventListener("input", () => fill(filterInput.value));
      row.appendChild(filterInput);
    }
    builderContainer.appendChild(row);
    if (!builderSelected[level]) {
      break;
    }
  }
}

/** Handles a builder selection: truncate deeper levels, load children, restore memory. */
async function onBuilderChange(level: number, key: string): Promise<void> {
  builderError = "";
  if (!key) {
    builderSelected = builderSelected.slice(0, level);
    builderChosen = builderChosen.slice(0, level);
    builderLevels = builderLevels.slice(0, level + 1);
    builderLevelMemory.length = level;
    applyBuilder();
    return;
  }
  const option = (builderLevels[level] || []).find((candidate) => candidate.key === key);
  if (!option) {
    return;
  }
  const parent = builderParentKey(level);
  builderSelected = builderSelected.slice(0, level);
  builderChosen = builderChosen.slice(0, level);
  builderLevels = builderLevels.slice(0, level + 1);

  builderSelected[level] = key;
  builderChosen[level] = option;
  builderMemory.set(parent, key);
  builderLevelMemory[level] = key;
  // Track the last chosen log target (by name); a plain view choice clears it.
  if (option.names) {
    builderLastLogTarget = option;
  } else if (option.key.indexOf("view:") === 0) {
    builderLastLogTarget = null;
  }

  if (!option.loadChildren) {
    applyBuilder();
    return;
  }
  const childPath = builderPathKey(level);
  let children = builderCache.get(childPath);
  if (!children) {
    try {
      children = await option.loadChildren();
      builderCache.set(childPath, children);
    } catch (error) {
      // A load failure (e.g. a missing permission) must not lose the form; show it in the box.
      children = [];
      builderError = error instanceof Error ? error.message : String(error);
      builderLevels[level + 1] = children;
      applyBuilder();
      return;
    }
  }
  // A dynamic build has no per-build log ids; its targets are name-based, so carry the last log
  // target forward unchanged (it resolves against whatever build is current when opened).
  const lastLog = builderLastLogTarget;
  if (isDynamicBuildMode(option) && lastLog && !children.some((child) => child.key === lastLog.key)) {
    children = [lastLog, ...children];
  }
  builderLevels[level + 1] = children;
  applyBuilder();
  // Restore a previously chosen child at this level, if any (so you can go back to a branch).
  const remembered = builderMemory.get(childPath);
  if (remembered && children.some((child) => child.key === remembered)) {
    await onBuilderChange(level + 1, remembered);
    return;
  }
  // No exact path memory: fall back to the soft per-level memory so changing an earlier level keeps
  // the closest target by name (e.g. the same log target on another build).
  const soft = builderLevelMemory[level + 1];
  if (soft && children.some((child) => child.key === soft)) {
    await onBuilderChange(level + 1, soft);
    return;
  }
  // A dynamic build's log target is offered by name; re-select it so the location is kept.
  if (isDynamicBuildMode(option) && lastLog) {
    const placeholder = children.find((child) => child.key === lastLog.key);
    if (placeholder) {
      await onBuilderChange(level + 1, placeholder.key);
      return;
    }
  }
  renderBuilder();
}

/** True when an option is a dynamic (latest/...) build mode (its children are named targets). */
function isDynamicBuildMode(option: BuilderOption): boolean {
  return Boolean(option.dynamic && option.dynamic.kind === "build" && option.key !== "mode:fixed");
}

/** Applies the builder path to the URL field and the dynamic spec. */
function applyBuilder(): void {
  if (builderChosen.length > 0 && !isFixedArea(builderChosen)) {
    const result = composePath(linkBase(), builderChosen);
    draftUrl = normalizeTokens(result.url);
    draftDynamic = result.dynamic;
    if (urlInput) {
      urlInput.value = draftUrl;
    }
  } else if (isFixedArea(builderChosen)) {
    // A fixed link's URL is typed by the user; the builder contributes nothing.
    draftDynamic = undefined;
    if (urlInput) {
      draftUrl = urlInput.value;
    }
  }
  renderBuilder();
  refresh();
}

/**
 * Handles a pasted in-project URL: pre-selects the matching builder options and either keeps a
 * concrete target fixed or restores the dynamic spec when the URL already contains the token.
 */
function applyPastedUrl(): void {
  const url = draftUrl.trim();
  if (!url) {
    return;
  }
  // Skip re-parsing the same value: a paste fires both paste and change, and a second parse would
  // visibly re-expand the builder levels.
  if (url === lastParsedUrl) {
    return;
  }
  lastParsedUrl = url;
  // Claim the newest generation; an older, slower run will see itself as stale and stop.
  const generation = ++pasteGeneration;
  const info = describeProjectUrl(url, organizationName(), currentProjectName(), currentProjectId());
  if (!info.ok) {
    // Not a valid in-project URL: store it as a fixed link when it is an absolute http(s) URL.
    if (isHttpUrl(url)) {
      applyFixedArea("Not an in-project URL; stored as a fixed link.", generation);
    }
    return; // Otherwise urlProblem shows the reason.
  }
  if (info.area === "repository" && info.repositoryName) {
    draftDynamic = undefined;
    void autoSelectRepo(info.repositoryName, url, info, generation);
  } else if (info.area === "build") {
    draftDynamic = undefined;
    void autoSelectBuild(info, url, generation);
  } else {
    // An in-project URL we do not model (settings, dashboards, wiki, ...): store it as Fixed.
    applyFixedArea("Stored as a fixed in-project link.", generation);
  }
}

/** Resets the builder and selects the Fixed area, keeping the typed URL (unmodelled/out-of-project). */
function applyFixedArea(message: string, generation: number): void {
  draftDynamic = undefined;
  builderChosen = [];
  builderSelected = [];
  builderLevels = [rootOptions()];
  builderCache.clear();
  builderMemory.clear();
  builderLevelMemory.length = 0;
  builderLastLogTarget = null;
  void onBuilderChange(0, "area:fixed").then(() => {
    if (isStalePaste(generation)) {
      return;
    }
    builderError = message;
    renderBuilder();
    refresh();
  });
}

/** True when a paste run has been superseded by a newer one (its mutations must be dropped). */
function isStalePaste(generation: number): boolean {
  return generation !== pasteGeneration;
}

/** Pre-selects the pipeline -> build -> view -> stage/job/task chain from a pasted URL. */
async function autoSelectBuild(
  info: {
    buildId?: string;
    view?: string;
    stageId?: string;
    jobId?: string;
    taskId?: string;
    artifactPath?: string;
    params: Array<[string, string]>;
  },
  pastedUrl: string,
  generation: number
): Promise<void> {
  builderError = "";
  const tokenized = hasToken(pastedUrl);
  const fixedId = !tokenized && info.buildId ? info.buildId : undefined;
  const buildInfo = fixedId ? await getBuildInfo(fixedId) : null;
  if (isStalePaste(generation)) {
    return;
  }
  const definitionId = buildInfo ? buildInfo.definitionId : 0;

  builderChosen = [];
  builderSelected = [];
  builderLevels = [rootOptions()];
  builderCache.clear();
  builderMemory.clear();
  builderLevelMemory.length = 0;
  builderLastLogTarget = null;

  // Level 0: Area = Pipeline.
  await onBuilderChange(0, "area:build");
  if (isStalePaste(generation)) {
    return;
  }

  // Level 1: the pipeline (by definition id).
  if (definitionId) {
    const pipe = (builderLevels[1] || []).find((candidate) => candidate.key === "pipe:" + definitionId);
    if (pipe) {
      await onBuilderChange(1, pipe.key);
      if (isStalePaste(generation)) {
        return;
      }
    }
  }

  // Level 2: build mode (Fixed when we have a concrete build id, else Latest).
  const modeKey = fixedId ? "mode:fixed" : "mode:latest";
  const mode = (builderLevels[2] || []).find((candidate) => candidate.key === modeKey);
  if (mode) {
    await onBuilderChange(2, mode.key);
    if (isStalePaste(generation)) {
      return;
    }
  }

  // Level 3: build number (fixed only); an unknown id is added as "(invalid)".
  if (fixedId) {
    const level = builderChosen.length;
    let buildOption = (builderLevels[level] || []).find((candidate) => candidate.key === "build:" + fixedId);
    if (!buildOption) {
      buildOption = {
        key: "build:" + fixedId,
        label: `Build ${fixedId} (invalid)`,
        url: "/_build/results?buildId=" + fixedId,
        terminal: true,
        loadChildren: async () => buildTargets(Number(fixedId))
      };
      builderLevels[level] = [buildOption, ...(builderLevels[level] || [])];
      builderCache.set(builderPathKey(level - 1), builderLevels[level]);
    }
    await onBuilderChange(level, buildOption.key);
    if (isStalePaste(generation)) {
      return;
    }
  }

  // Target level: match by NAME. Log targets are stored by name, so the pasted ids are resolved to
  // names against the pasted build and matched; anything the target does not consume stays as a
  // fixed level, so the stored URL never truncates the pasted URL.
  const consumed = new Set<string>();
  if (info.view) {
    const level = builderChosen.length;
    const names = await resolvePastedNames(fixedId, info);
    if (isStalePaste(generation)) {
      return;
    }
    let match = (builderLevels[level] || []).find((candidate) =>
      targetMatches(candidate, info.view || "", names)
    );
    if (!match && info.view === "logs" && (names.stage || names.job || names.task)) {
      // No listed target matched (e.g. duplicate names): synthesize a token-based log target so the
      // location still survives later changes.
      match = syntheticLogTarget(names);
      builderLevels[level] = [match, ...(builderLevels[level] || [])];
    }
    if (match) {
      await onBuilderChange(level, match.key);
      if (isStalePaste(generation)) {
        return;
      }
      consumedParams(match.url).forEach((name) => consumed.add(name));
    } else {
      // An unknown/custom view: keep it (and its parameters) as fixed levels.
      appendParamLevel("view", info.view);
      consumed.add("view");
    }
  }

  // Every parameter the target did not consume becomes a fixed level (never truncate).
  for (const [key, value] of info.params || []) {
    if (key === "buildId" || consumed.has(key)) {
      continue;
    }
    appendParamLevel(key, value);
  }

  applyBuilder();
  builderError = "Detected a pipeline link; adjust any level below.";
  renderBuilder();
  refresh();
}

/** Appends a synthetic fixed level for a query parameter (never truncates the URL). */
function appendParamLevel(key: string, value: string, names?: Map<string, string>): void {
  const option = paramOption(key, value, names || new Map<string, string>());
  const level = builderChosen.length;
  builderChosen[level] = option;
  builderSelected[level] = option.key;
  builderLevels[level] = [option];
}

/** Resolves the pasted s/j/t ids to their names using the pasted build's timeline. */
async function resolvePastedNames(
  buildId: string | undefined,
  info: { stageId?: string; jobId?: string; taskId?: string }
): Promise<{ stage?: string; job?: string; task?: string }> {
  const names: { stage?: string; job?: string; task?: string } = {};
  if (!buildId || (!info.stageId && !info.jobId && !info.taskId)) {
    return names;
  }
  try {
    const records = await getBuildTimeline(buildId);
    const byId = new Map(records.map((record) => [record.id, record]));
    const stage = info.stageId ? byId.get(info.stageId) : undefined;
    const job = info.jobId ? byId.get(info.jobId) : undefined;
    const task = info.taskId ? byId.get(info.taskId) : undefined;
    names.stage = stage && stage.name;
    names.job = job && job.name;
    names.task = task && task.name;
  } catch (error) {
    // Without the timeline we match a plain view and keep the raw ids as fixed params.
    logDebug("build timeline unavailable for a pasted log URL.", error);
  }
  return names;
}

/** A token-based log target for a pasted logs URL that had no listed match. */
function syntheticLogTarget(names: { stage?: string; job?: string; task?: string }): BuilderOption {
  const label = [names.stage, names.job, names.task].filter(Boolean).join(" / ");
  return {
    key: "target:logs:" + label,
    label: "Logs: " + label,
    url:
      "&view=logs" +
      (names.stage ? "&s=" + LOG_STAGE_TOKEN : "") +
      (names.job ? "&j=" + LOG_JOB_TOKEN : "") +
      (names.task ? "&t=" + LOG_TASK_TOKEN : ""),
    terminal: true,
    names,
    dynamic: { kind: "build", logTarget: { view: "logs", ...names } }
  };
}

/** A builder option that reproduces one query parameter exactly. */
function paramOption(key: string, value: string, names: Map<string, string>): BuilderOption {
  return {
    key: `param:${key}:${value}`,
    label: paramLabel(key, value, names),
    url: `&${key}=${encodeURIComponent(value)}`,
    terminal: true
  };
}

/** A human label for a query parameter (names a stage/job/task when known). */
function paramLabel(key: string, value: string, names: Map<string, string>): string {
  switch (key) {
    case "view":
      return "View: " + viewLabel(value);
    case "s":
      return "Stage: " + (names.get(value) || `fixed (${value})`);
    case "j":
      return "Job: " + (names.get(value) || `fixed (${value})`);
    case "t":
      return "Task: " + (names.get(value) || `fixed (${value})`);
    case "path":
      return "Path: " + value;
    case "type":
      return "Artifacts type: " + value;
    default:
      return `${key}: ${value}`;
  }
}

/** A friendly name for a build view. */
function viewLabel(view: string): string {
  switch (view) {
    case "results":
      return "Results (summary)";
    case "codecoverage-tab":
      return "Code coverage";
    case "artifacts":
      return "Artifacts";
    case "logs":
      return "Logs";
    default:
      return view || "(default)";
  }
}

/** Pre-selects Area = Repository and the repository; restores the dynamic leaf for a token URL. */
async function autoSelectRepo(
  name: string,
  pastedUrl: string,
  info: { commit?: string; prId?: string },
  generation: number
): Promise<void> {
  builderError = "";
  await onBuilderChange(0, "area:repo");
  if (isStalePaste(generation)) {
    return;
  }
  const repos = builderCache.get("area:repo") || [];
  const repo = repos.find((candidate) => candidate.label.toLowerCase() === name.toLowerCase());
  if (!repo) {
    draftUrl = pastedUrl;
    if (urlInput) {
      urlInput.value = draftUrl;
    }
    builderError = `Repository '${name}' was not found in this project.`;
    renderBuilder();
    refresh();
    return;
  }
  await onBuilderChange(1, repo.key);
  if (isStalePaste(generation)) {
    return;
  }

  if (hasToken(pastedUrl)) {
    // Restore the dynamic leaf: a commit token -> latest commit; a PR token -> newest open PR.
    const children = builderLevels[2] || [];
    const leafKey = info.commit ? "commit:default" : "pr:newest-open";
    const leaf = children.find((candidate) => candidate.key === leafKey);
    if (leaf) {
      await onBuilderChange(2, leaf.key);
    }
    builderError = "Detected a repository link; restored the dynamic target.";
  } else {
    // A concrete target: keep the pasted URL exactly (fixed).
    draftUrl = pastedUrl;
    draftDynamic = undefined;
    if (urlInput) {
      urlInput.value = draftUrl;
    }
    builderError = "";
  }
  if (isStalePaste(generation)) {
    return;
  }
  renderBuilder();
  refresh();
}

/** Re-runs validation and updates the hint, the invalid markers and the primary button. */
function refresh(): void {
  if (formRefresh) {
    formRefresh();
  }
  if (editorOptions && editorOptions.onChange) {
    editorOptions.onChange();
  }
}

/** Builds the form for the current draft. */
function buildForm(): HTMLElement {
  const options = editorOptions;
  const form = el("div", "form");
  const titleField = textField("Title", draftTitle, true, (value) => {
    draftTitle = value;
  });
  const slugField = textField("Slug", draftSlug, true, (value) => {
    draftSlug = value;
  });
  const urlField = textField("URL (optional)", draftUrl, true, (value) => {
    draftUrl = value;
  });
  const commentField = textField("Comment", draftComment, true, (value) => {
    draftComment = value;
  });
  // Slug is immutable when editing so existing bookmarks never break.
  slugField.input.disabled = editing;

  form.appendChild(titleField.row);
  form.appendChild(slugField.row);
  form.appendChild(commentField.row);
  form.appendChild(urlField.row);

  // Cascading builder: Area -> ... until a valid URL exists (several levels may be valid).
  const builder = el("div", "builder");
  builder.appendChild(
    el(
      "p",
      "hint",
      "Build the link below. A link is valid as soon as an option is marked [valid]; several may be valid at once."
    )
  );
  builderContainer = builder;
  urlInput = urlField.input;
  form.appendChild(builder);
  renderBuilder();

  const hint = el("p", "hint");
  form.appendChild(hint);

  const buttons = el("div", "form-buttons");
  const primary = el("button", "primary", editing ? options?.saveLabel || "Save" : options?.addLabel || "Add");
  const secondary = el("button", undefined, editing ? "Cancel" : "Clear");
  buttons.appendChild(primary);
  buttons.appendChild(secondary);
  form.appendChild(buttons);

  // Live validation: title/slug, a valid URL, and a resolvable dynamic part.
  const check = () => {
    const slugIssue = slugProblem();
    const urlIssue = urlProblem();
    const dynamicIssue = dynamicProblem();
    const error = slugIssue || urlIssue || dynamicIssue;
    hint.textContent =
      error ||
      options?.hint ||
      "Add clears only the slug, so you can build several links from the same selections; use Clear to start over.";
    hint.classList.toggle("error", Boolean(error));
    slugField.input.classList.toggle("invalid", Boolean(slugIssue));
    urlField.input.classList.toggle("invalid", Boolean(urlIssue));
    primary.disabled = !valid();
  };

  titleField.input.addEventListener("input", check);
  slugField.input.addEventListener("input", check);
  urlField.input.addEventListener("input", () => {
    // A manually typed URL overrides any builder result.
    draftUrl = urlField.input.value;
    // Keep the dynamic spec while any placeholder is present (dynamic OR log tokens).
    if (!hasAnyToken(draftUrl)) {
      draftDynamic = undefined;
    }
    // A hand edit invalidates the last parse, so the next change re-parses.
    lastParsedUrl = "";
    check();
  });
  // Pasted URLs are parsed and pre-select matching builder options.
  urlField.input.addEventListener("change", () => applyPastedUrl());
  urlField.input.addEventListener("paste", () => window.setTimeout(() => applyPastedUrl(), 0));
  commentField.input.addEventListener("input", check);
  formRefresh = check;
  check();

  primary.addEventListener("click", () => void options?.onSave(currentDraft()));
  secondary.addEventListener("click", () => options?.onCancel?.());
  return form;
}

/** The draft as it should be stored (trimmed). */
function currentDraft(): LinkDraft {
  // Remember a fixed (possibly out-of-project) link so the hubs and settings can label it.
  const area = isFixedArea(builderChosen) ? "fixed" : undefined;
  return {
    title: draftTitle.trim(),
    slug: draftSlug.trim(),
    url: draftUrl.trim(),
    comment: draftComment.trim(),
    ...(draftDynamic ? { dynamic: draftDynamic } : {}),
    ...(area ? { area } : {})
  };
}

/** Clears the builder (levels, memory and cache) without touching the text fields. */
function resetBuilder(): void {
  builderChosen = [];
  builderSelected = [];
  builderLevels = [rootOptions()];
  builderCache.clear();
  builderMemory.clear();
  builderLevelMemory.length = 0;
  builderLastLogTarget = null;
  builderError = "";
  lastParsedUrl = "";
}

/**
 * Creates (or re-binds) the single editor of this page.
 * Rationale: one editor per page is all any surface needs, and the draft state is module scope, so
 * calling this again after a re-render returns an editor that still holds what the user typed.
 */
export function createLinkEditor(options: LinkEditorOptions): LinkEditor {
  editorOptions = options;
  return {
    buildForm,
    setDraft(draft, isEditing) {
      editing = isEditing;
      draftTitle = draft.title || "";
      draftSlug = draft.slug || "";
      draftUrl = draft.url || "";
      draftComment = draft.comment || "";
      draftDynamic = draft.dynamic;
      resetBuilder();
      // The stored URL is already shown; mark it parsed so a blur does not re-parse it.
      lastParsedUrl = draftUrl.trim();
      // A stored fixed (or out-of-project) link needs the Fixed area preselected to validate.
      if (draft.area === "fixed") {
        void onBuilderChange(0, "area:fixed");
      }
    },
    patch(values) {
      if (values.title !== undefined) {
        draftTitle = values.title;
      }
      if (values.slug !== undefined) {
        draftSlug = values.slug;
      }
      if (values.url !== undefined) {
        draftUrl = values.url;
      }
      if (values.comment !== undefined) {
        draftComment = values.comment;
      }
      if (values.area !== undefined) {
        draftDynamic = undefined;
      }
    },
    parse(overrideUrl) {
      if (overrideUrl !== undefined) {
        draftUrl = overrideUrl;
      }
      applyPastedUrl();
    },
    reset() {
      editing = false;
      draftTitle = "";
      draftSlug = "";
      draftUrl = "";
      draftComment = "";
      draftDynamic = undefined;
      resetBuilder();
    },
    draft: currentDraft
  };
}
