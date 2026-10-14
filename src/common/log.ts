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
    return error.message;
  }
  if (error && typeof error === "object") {
    const candidate = error as { message?: unknown; name?: unknown; status?: unknown };
    if (typeof candidate.message === "string" && candidate.message) {
      return candidate.name ? `${candidate.name}: ${candidate.message}` : candidate.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      // Fall through to String().
    }
  }
  return String(error);
}
