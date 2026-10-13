// Pure helpers for the case-insensitive substring filters used by the UI lists.
//
// Rationale: the org project list and the repos list must filter identically; sharing one
// function keeps the behaviour consistent and makes it unit-testable.

/** True when `needle` is empty, or `value` contains it (case-insensitive, trimmed). */
export function matchesFilter(value: string, needle: string): boolean {
  const trimmed = (needle || "").trim().toLowerCase();
  return trimmed === "" || (value || "").toLowerCase().includes(trimmed);
}

/** Returns the items whose `name` matches the filter, preserving the input order. */
export function filterByName<T extends { name: string }>(items: T[], needle: string): T[] {
  return items.filter((item) => matchesFilter(item.name, needle));
}
