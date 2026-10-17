/**
 * Minimal logging facade.
 *
 * Rationale: extension code runs inside the ADO host where the console is noisy; a single
 * prefix and a dev/prod verbosity switch make extension output easy to find and quiet in
 * production. `__DEV__` is injected by esbuild (see scripts/build.js).
 */

declare const __DEV__: boolean;

const PREFIX = "[pages-ext]";

/**
 * Decides whether a level should be emitted. Warnings/errors are always on; debug/info are
 * on only in development builds (or when `__DEV__` is undefined, e.g. a local harness).
 */
function enabled(level: "debug" | "info" | "warn" | "error"): boolean {
  if (level === "warn" || level === "error") {
    return true;
  }
  return typeof __DEV__ !== "undefined" ? __DEV__ : true;
}

export function logDebug(message: string, data?: unknown): void {
  if (enabled("debug")) {
    console.debug(PREFIX, message, data ?? "");
  }
}

export function logInfo(message: string, data?: unknown): void {
  if (enabled("info")) {
    console.info(PREFIX, message, data ?? "");
  }
}

export function logWarn(message: string, data?: unknown): void {
  if (enabled("warn")) {
    console.warn(PREFIX, message, data ?? "");
  }
}

export function logError(message: string, data?: unknown): void {
  if (enabled("error")) {
    console.error(PREFIX, message, data ?? "");
  }
}

/**
 * Extracts a human-readable message from an unknown thrown value.
 * Rationale: the Extension Data SDK rejects with plain objects (e.g.
 * `{ name: "AccessCheckException", message: "..." }`), which `String(error)` renders as
 * "[object Object]"  -  useless in the UI.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || "Unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    const candidate = error as {
      message?: unknown;
      name?: unknown;
      status?: unknown;
      responseText?: unknown;
    };
    if (typeof candidate.message === "string" && candidate.message) {
      return candidate.name ? `${candidate.name}: ${candidate.message}` : candidate.message;
    }
    // The REST client rejects with a TFS.WebApi.Exception that has no `message` of its own: the
    // server's text lives in `responseText` as a JSON document (for example TF400813 "not a member
    // of the AAD directory"). That text is the only actionable part, so prefer it over a JSON dump.
    if (typeof candidate.responseText === "string" && candidate.responseText.trim()) {
      const fromResponse = messageFromJson(candidate.responseText);
      if (fromResponse) {
        return candidate.name ? `${candidate.name}: ${fromResponse}` : fromResponse;
      }
      return candidate.responseText.trim().slice(0, 400);
    }
    // No message anywhere: the exception name and the HTTP status still say more than
    // "[object Object]", which is what the page and the host banner used to show.
    const parts: string[] = [];
    if (typeof candidate.name === "string" && candidate.name) {
      parts.push(candidate.name);
    }
    if (typeof candidate.status === "number") {
      parts.push(`HTTP ${candidate.status}`);
    }
    if (parts.length > 0) {
      return parts.join(" ");
    }
    try {
      return JSON.stringify(error);
    } catch {
      // Fall through to String().
    }
  }
  return String(error);
}

/** The `message` of a JSON document, or "" when the text is not one. */
function messageFromJson(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    return typeof parsed.message === "string" ? parsed.message.trim() : "";
  } catch {
    return "";
  }
}
