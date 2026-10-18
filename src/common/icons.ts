// Inline SVG icons for the link row actions.
//
// Rationale: the ADO host injects no stylesheet (and no icon font) into extension iframes, so the
// icons ship as markup that inherits `currentColor` and needs no extra request or image file.

/** Pencil: edit a link. */
export const ICON_EDIT =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M12.1 1.4l2.5 2.5-1.7 1.7-2.5-2.5 1.7-1.7zM9.4 4.1l2.5 2.5-7 7-3 .5.5-3 7-7z"/></svg>';

/** Bin: delete a private link. */
export const ICON_DELETE =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M6 1h4v1h3.5v2h-11V2H6V1zM3.5 5h9l-.8 9.1c0 .5-.4.9-.9.9H5.2c-.5 0-.9-.4-.9-.9L3.5 5z"/></svg>';

/** Arrow out of a tray: offer the link to the project. */
export const ICON_SHARE =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M8 1l4.5 4.5-1.4 1.4L9 4.8V11H7V4.8L4.9 6.9 3.5 5.5 8 1zM3 10h2v3h6v-3h2v4c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1v-4z"/></svg>';

/** Plus: add a private link. */
export const ICON_ADD =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M7 2h2v5h5v2H9v5H7V9H2V7h5V2z"/></svg>';

/** Circled i: opens the explanation of the bookmarklet. */
export const ICON_INFO =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
  '<circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
  '<path fill="currentColor" d="M7.2 6.6h1.6v5H7.2zM7.2 4.2h1.6v1.5H7.2z"/></svg>';

/** Circled exclamation: a proposed link is waiting for a decision. */
export const ICON_WARNING =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">' +
  '<circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
  '<path fill="currentColor" d="M7.25 4.3h1.5v4.8h-1.5zM7.25 10.3h1.5v1.5h-1.5z"/></svg>';
