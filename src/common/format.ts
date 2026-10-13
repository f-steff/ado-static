/**
 * Formatting helpers shared by the hub and admin UIs.
 */

// IEC (1024-based) units. Rationale: sizes are displayed 1024-based per decision D12.
const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

/**
 * Formats a byte count using 1024-based (IEC) units.
 * Whole bytes use "B" (no decimal); larger values use one decimal (e.g. "4.5 MiB").
 * Rationale: raw byte counts are exact and small; scaled units are easier to scan.
 */
export function formatBytes(bytes: number | undefined | null): string {
  const value = Number(bytes);
  // Guard against missing/negative values (treat as empty) so the UI never shows "NaN".
  if (!isFinite(value) || value <= 0) {
    return "0 B";
  }
  let scaled = value;
  let unit = 0;
  // Divide down to the largest unit that keeps the value >= 1.
  while (scaled >= 1024 && unit < UNITS.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${scaled.toFixed(1)} ${UNITS[unit]}`;
}

/**
 * Like `formatBytes` but without decimals (e.g. "5 MiB").
 * Rationale: compact tables (organization statistics) read better without ".0".
 */
export function formatBytesWhole(bytes: number | undefined | null): string {
  const value = Number(bytes);
  if (!isFinite(value) || value <= 0) {
    return "0 B";
  }
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < UNITS.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${Math.round(scaled)} ${UNITS[unit]}`;
}

/**
 * Formats an ISO timestamp as a coarse relative age (e.g. "3 d ago").
 * Rationale: repo statistics read best as "how recent", and exact timestamps are noisy.
 * `nowMs` is injectable so the output is unit-testable and deterministic.
 */
export function formatRelativeTime(iso: string, nowMs = Date.now()): string {
  if (!iso) {
    return "never";
  }
  const then = Date.parse(iso);
  if (!isFinite(then)) {
    return "unknown";
  }
  // Clamp future timestamps (clock skew) to "just now" rather than a negative age.
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 30) {
    return `${days} d ago`;
  }
  const months = Math.round(days / 30);
  if (months < 12) {
    return `${months} mo ago`;
  }
  return `${Math.round(months / 12)} y ago`;
}
