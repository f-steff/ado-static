// Pure contributor-tally helpers for the Repos hub.
//
// Rationale: choosing the "main contributor" (most commits) and shortening a name for compact
// display are pure rules; keeping them here makes them unit-testable without the Git API.

/** One contributor's commit count (name kept as first seen for display). */
export interface Contributor {
  name: string;
  commits: number;
}

/**
 * Adds one commit for an author to the tally. The key is case-insensitive so the same person
 * with different casing is not counted twice; the first-seen spelling is kept for display.
 */
export function addContribution(tally: Map<string, Contributor>, name: string): void {
  const display = (name || "").trim();
  if (!display) {
    return;
  }
  const key = display.toLowerCase();
  const existing = tally.get(key);
  if (existing) {
    existing.commits += 1;
  } else {
    tally.set(key, { name: display, commits: 1 });
  }
}

/** The contributor with the most commits; ties break by name so the result is deterministic. */
export function topContributor(tally: Map<string, Contributor>): Contributor | null {
  let best: Contributor | null = null;
  tally.forEach((candidate) => {
    if (
      !best ||
      candidate.commits > best.commits ||
      (candidate.commits === best.commits && candidate.name.localeCompare(best.name) < 0)
    ) {
      best = candidate;
    }
  });
  return best;
}

/** First name for compact display; the full name remains available as a hover tooltip. */
export function firstName(full: string): string {
  const trimmed = (full || "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.split(/\s+/)[0];
}
