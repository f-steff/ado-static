// Pure logic for private links and the proposal round trip.
//
// Rationale: this is the part of the feature with rules worth testing - who owns which slug, what a
// proposal snapshot contains, and how a decision on the project side is reconciled with the owner's
// private store on their next visit. Keeping it free of storage and of the SDK lets the unit tests
// cover the promotion and rejection paths exactly as the UIs drive them.

import type { LinkEntry, LinkIndex, LinkProposal } from "./data-service";
import { checkProjectUrl } from "./ado-url";
import { fixedUrlError, isHttpUrl } from "./link-url";

/** The identity of the member a private link belongs to. */
export interface LinkOwner {
  id: string;
  name: string;
}

/**
 * Slug availability for the private-link editor.
 * Rationale: a private link is bookmarked as `?page=<slug>`, where **project links win**, so its slug
 * must not collide with a project link (live or trashed) either - otherwise the bookmark would open
 * somebody else's link. `excludeSlug` is the link being edited (its own slug stays available).
 */
export function slugTaken(
  project: LinkIndex | null,
  mine: LinkEntry[],
  slug: string,
  excludeSlug?: string | null
): boolean {
  const needle = (slug || "").trim().toLowerCase();
  if (!needle) {
    return false;
  }
  const skip = (excludeSlug || "").trim().toLowerCase();
  const candidates = [
    ...((project && project.links) || []).map((link) => link.slug),
    ...((project && project.trash) || []).map((entry) => entry.link.slug),
    ...(mine || []).map((link) => link.slug)
  ];
  return candidates.some((candidate) => {
    const value = (candidate || "").trim().toLowerCase();
    return value !== "" && value !== skip && value === needle;
  });
}

/** Builds the proposal snapshot for one private link (what the reviewers see, frozen). */
export function proposalFor(
  link: LinkEntry,
  owner: LinkOwner,
  proposalId: string,
  now = new Date()
): LinkProposal {
  return {
    proposalId,
    privateLinkId: link.linkId,
    slug: link.slug,
    title: link.title,
    url: link.url,
    comment: link.comment || "",
    ...(link.dynamic ? { dynamic: link.dynamic } : {}),
    ...(link.area ? { area: link.area } : {}),
    proposedById: owner.id,
    proposedByName: owner.name,
    proposedUtc: now.toISOString(),
    state: "open"
  };
}

/** The fields a project link inherits when a proposal is accepted (ownership moves to the project). */
export function promotionFields(
  proposal: LinkProposal,
  acceptedBy: string,
  now = new Date()
): Omit<LinkEntry, "linkId" | "order"> {
  return {
    slug: proposal.slug,
    title: proposal.title,
    url: proposal.url,
    comment: proposal.comment || "",
    enabled: true,
    hidden: false,
    updatedUtc: now.toISOString(),
    updatedBy: acceptedBy,
    ...(proposal.dynamic ? { dynamic: proposal.dynamic } : {}),
    ...(proposal.area ? { area: proposal.area } : {}),
    proposedBy: proposal.proposedByName
  };
}

/**
 * Why a proposal cannot be accepted right now, or "" when it can.
 * The reviewers re-check the two things the proposer could not control: that the slug is still free
 * (a project link may have taken it since) and that the URL still has a valid shape.
 */
export function acceptanceError(
  proposal: LinkProposal,
  project: LinkIndex | null,
  organization: string,
  projectName: string,
  projectId: string
): string {
  const taken = ((project && project.links) || []).some(
    (link) => link.slug.trim().toLowerCase() === proposal.slug.trim().toLowerCase()
  );
  if (taken) {
    return `The slug '${proposal.slug}' is already used by a project link. Reject the proposal so its owner can pick another slug.`;
  }
  const url = (proposal.url || "").trim();
  if (proposal.area === "fixed") {
    return fixedUrlError(url);
  }
  if (isHttpUrl(url)) {
    const check = checkProjectUrl(url, organization, projectName, projectId);
    return check.ok ? "" : check.error || "The URL is not a valid in-project URL.";
  }
  return url ? "" : "The proposal has no URL.";
}

/** The outcome of reconciling the owner's private store with the project's proposals. */
export interface ReconcilePlan {
  /** The private links to keep, with the decision markers applied. */
  links: LinkEntry[];
  /** Private links whose proposal was accepted (the project link now owns them). */
  removeLinkIds: string[];
  /** Proposal records that are decided or withdrawn and can go. */
  removeProposalIds: string[];
  /** True when anything must be written back to the private store. */
  changed: boolean;
}

/**
 * Reconciles the owner's private links with the project's proposals.
 *
 * Rationale: the reviewer cannot write to somebody else's user-scoped store, so acceptance does not
 * delete the private original. Instead the decision travels back through the proposal record and the
 * owner's next visit acts on it: an accepted proposal promotes the link (the private copy goes), and a
 * rejected one returns the link to the owner with a marker that says so. Anything already decided and
 * cleaned up on another device is simply forgotten, and a proposal whose private link no longer
 * exists is withdrawn so no reviewer is asked to decide it.
 */
export function reconcile(
  mine: LinkEntry[],
  proposals: LinkProposal[],
  ownerId: string,
  now = new Date()
): ReconcilePlan {
  const byId = new Map((proposals || []).map((proposal) => [proposal.proposalId, proposal]));
  const links: LinkEntry[] = [];
  const removeLinkIds: string[] = [];
  const removeProposalIds: string[] = [];
  let changed = false;

  for (const link of mine || []) {
    const reference = link.proposal;
    if (!reference) {
      links.push(link);
      continue;
    }
    const proposal = byId.get(reference.proposalId);
    if (!proposal) {
      // The record is gone: the decision was already applied here (a different device) or the write
      // never landed. Either way the link is not proposed any more, so drop the marker.
      const rest: LinkEntry = { ...link };
      delete rest.proposal;
      links.push(rest);
      changed = true;
      continue;
    }
    if (proposal.state === "open") {
      links.push(link);
      continue;
    }
    if (proposal.state === "accepted") {
      // Promotion: the project owns the link now, so the private original goes.
      removeLinkIds.push(link.linkId);
      removeProposalIds.push(proposal.proposalId);
      changed = true;
      continue;
    }
    // Rejected: keep the link, tell the owner, and let them share it again after editing.
    const rejected: LinkEntry = { ...link, rejectedUtc: proposal.decidedUtc || now.toISOString() };
    delete rejected.proposal;
    links.push(rejected);
    removeProposalIds.push(proposal.proposalId);
    changed = true;
  }

  // Withdraw proposals whose private link is gone: there is nothing left to accept.
  const surviving = new Set(links.map((link) => link.linkId));
  for (const proposal of proposals || []) {
    if (
      proposal.state === "open" &&
      proposal.proposedById === ownerId &&
      !surviving.has(proposal.privateLinkId) &&
      !removeProposalIds.includes(proposal.proposalId)
    ) {
      removeProposalIds.push(proposal.proposalId);
      changed = true;
    }
  }

  return { links, removeLinkIds, removeProposalIds, changed };
}

/** Sort key for private links: explicit order first, then title (matches the project links table). */
export function byOrderThenTitle(a: LinkEntry, b: LinkEntry): number {
  return (a.order || 0) - (b.order || 0) || a.title.localeCompare(b.title);
}

/** How a row of the merged Links list is owned. */
export type LinkStatus = "project" | "pending" | "private";

/** One row of the merged Links list. */
export interface LinkRow {
  link: LinkEntry;
  status: LinkStatus;
  /** True when the row is one of the signed-in user's own links (only those have actions). */
  mine: boolean;
}

/** True when a link matches the filter in its title, slug or comment (case-insensitive). */
export function linkMatches(link: LinkEntry, filter: string): boolean {
  const needle = (filter || "").trim().toLowerCase();
  if (!needle) {
    return true;
  }
  const haystack = [link.title, link.slug, link.comment]
    .map((value) => (value || "").toLowerCase())
    .join("\n");
  return haystack.includes(needle);
}

/**
 * The Links hub shows one list: the project's links and the signed-in user's private links, merged.
 *
 * Rationale: two tables duplicated every column and pushed the private links (the ones a member can
 * act on) below the fold. One list with a **Status** column says the same thing in half the space,
 * and the filter then searches both at once. A private link that is waiting for a decision reads
 * "pending"; a rejected one is back to "private" (its Share button says it was not accepted).
 * Hidden project links stay omitted, and the order is alphabetical by title in both groups.
 */
export function mergedRows(
  project: LinkIndex | null,
  mine: LinkEntry[],
  filter = ""
): LinkRow[] {
  const rows: LinkRow[] = [];
  for (const link of (project && project.links) || []) {
    // Hidden project links are not part of the hub's list (they are still addressable by slug).
    if (!link.hidden) {
      rows.push({ link, status: "project", mine: false });
    }
  }
  for (const link of mine || []) {
    rows.push({ link, status: link.proposal ? "pending" : "private", mine: true });
  }
  return rows
    .filter((row) => linkMatches(row.link, filter))
    .sort(
      (a, b) =>
        a.link.title.localeCompare(b.link.title, undefined, { sensitivity: "base" }) ||
        a.link.slug.localeCompare(b.link.slug)
    );
}
