import { ICON_DATA, ICON_DATA_URI } from "./icon-data";

// Extension branding helpers.
//
// Rationale: every page heading shows its own hub icon. All UI entries live in
// `dist/<name>/index.html`, so a shared helper builds the heading; the icon is an inlined data
// URI (see icon-data.ts) so it never depends on a network fetch.

/** Path to the packaged 32px group icon (reference; headings use the inlined data URIs). */
export const ICON_URL = "../../images/icon-32.png";

/** Returns the inlined data URI for a hub icon key (cube/links/pages/pipelines/pr/repos). */
export function iconFor(key: string): string {
  return ICON_DATA[key] || ICON_DATA_URI;
}

/** Builds a heading (`h1`/`h2`) with the given icon prepended (defaults to the group cube). */
export function getHeading(
  level: "h1" | "h2",
  text: string,
  iconUri: string = ICON_DATA_URI
): HTMLElement {
  const heading = document.createElement(level);
  const icon = document.createElement("img");
  icon.src = iconUri;
  icon.alt = "";
  icon.className = "heading-icon";
  heading.appendChild(icon);
  heading.appendChild(document.createTextNode(text));
  return heading;
}
