import * as SDK from "azure-devops-extension-sdk";

/**
 * Page-owned key/value storage for sandboxed content.
 *
 * Rationale: the content frame has an opaque origin, so its own `localStorage`/cookies are
 * unavailable (they raise SecurityError). The extension frame runs on the gallery CDN origin,
 * which is the SAME origin across extension versions, so it can host the values and hand them
 * to the content on load. That lets a page's "save view" survive reloads and content upgrades.
 */

const PREFIX = "static-store";

/** Storage slot for one project page: `static-store:{org}/{projectId}/{slug}`. */
function slot(slug: string): string {
  const host = SDK.getHost();
  const web = SDK.getWebContext();
  const organization = host ? host.name : "";
  const project = web && web.project ? web.project.id : "";
  return `${PREFIX}:${organization}/${project}/${slug}`;
}

/** Reads all saved keys for a page (empty object when nothing is stored or storage is blocked). */
export function readPageStore(slug: string): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(slot(slug));
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    Object.keys(parsed || {}).forEach((key) => {
      out[key] = String(parsed[key]);
    });
    return out;
  } catch (error) {
    // Storage can be blocked by policy; persistence is then unavailable but the URL still works.
    return {};
  }
}

/** Saves (or removes, when `value` is null) one key for a page. */
export function writePageStore(slug: string, key: string, value: string | null): void {
  if (!key) {
    return;
  }
  try {
    const store = readPageStore(slug);
    if (value == null) {
      delete store[key];
    } else {
      store[key] = value;
    }
    window.localStorage.setItem(slot(slug), JSON.stringify(store));
  } catch (error) {
    // Ignore: nothing we can do, and the URL keeps the state for this session.
  }
}

/** Removes every saved key for a page. */
export function clearPageStore(slug: string): void {
  try {
    window.localStorage.removeItem(slot(slug));
  } catch (error) {
    // Ignore.
  }
}
