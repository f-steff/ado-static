// Pure URL helpers shared by the Pages UIs.
//
// Rationale: composing Azure DevOps hub/settings URLs and rewriting a single query parameter is
// easy to get subtly wrong (encoding, ordering, preserving unrelated parameters), so the logic
// lives here where it is unit-tested without the ADO host.

/** Serializes a flat parameter map into a query string (empty string when there are no keys). */
export function encodeQuery(params: Record<string, string>): string {
  const parts = Object.keys(params || {})
    .filter((key) => key !== "")
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key] == null ? "" : params[key])}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

/**
 * Inserts, replaces (when `value` is a string) or removes (when `value` is null) one query
 * parameter, preserving every other parameter and its order.
 */
export function withQueryParam(url: string, key: string, value: string | null): string {
  // Keep the fragment untouched; only the query part is rewritten.
  const hashAt = url.indexOf("#");
  const hash = hashAt >= 0 ? url.slice(hashAt) : "";
  const withoutHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const queryAt = withoutHash.indexOf("?");
  const path = queryAt >= 0 ? withoutHash.slice(0, queryAt) : withoutHash;
  const query = queryAt >= 0 ? withoutHash.slice(queryAt + 1) : "";

  // Preserve pairs in order so the resulting URL stays stable and readable.
  const pairs: Array<[string, string]> = [];
  query.split("&").forEach((part) => {
    if (!part) {
      return;
    }
    const eq = part.indexOf("=");
    const rawKey = eq < 0 ? part : part.slice(0, eq);
    const rawValue = eq < 0 ? "" : part.slice(eq + 1);
    pairs.push([decodeURIComponent(rawKey), decodeURIComponent(rawValue)]);
  });

  // Replace the key in place (keeps the URL stable); append it when not already present.
  let found = false;
  const kept: Array<[string, string]> = [];
  pairs.forEach(([pairKey, pairValue]) => {
    if (pairKey === key) {
      found = true;
      if (value != null) {
        kept.push([key, value]);
      }
      return;
    }
    kept.push([pairKey, pairValue]);
  });
  if (!found && value != null) {
    kept.push([key, value]);
  }
  const rebuilt = kept
    .map(([pairKey, pairValue]) => `${encodeURIComponent(pairKey)}=${encodeURIComponent(pairValue)}`)
    .join("&");
  return path + (rebuilt ? `?${rebuilt}` : "") + hash;
}

/** Common inputs for building an Azure DevOps contribution URL. */
export interface ContributionUrlOptions {
  origin: string;
  organization: string;
  project: string;
  contribution: string;
}

/** Hub URL: `{origin}/{org}/{project}/_apps/hub/{contribution}`. */
export function hubUrl(options: ContributionUrlOptions): string {
  return (
    `${options.origin}/${options.organization}/${encodeURIComponent(options.project)}` +
    `/_apps/hub/${options.contribution}`
  );
}

/** Project-settings URL: `{origin}/{org}/{project}/_settings/{contribution}`. */
export function projectSettingsUrl(options: ContributionUrlOptions): string {
  return (
    `${options.origin}/${options.organization}/${encodeURIComponent(options.project)}` +
    `/_settings/${options.contribution}`
  );
}

/** Organization-settings URL: `{origin}/{org}/_settings/{contribution}`. */
export function orgSettingsUrl(options: Omit<ContributionUrlOptions, "project">): string {
  return `${options.origin}/${options.organization}/_settings/${options.contribution}`;
}
