// In-DOM confirmation dialog.
//
// Rationale: this extension must never use native `window.confirm`/`alert`/`prompt` (they block
// the host and are not themeable), so confirmations are rendered into our own document as a
// small modal overlay and resolved via a Promise.

/** Shows a modal confirmation and resolves true (confirm) or false (cancel/dismiss). */
export function confirmDialog(
  message: string,
  confirmLabel = "OK",
  cancelLabel = "Cancel"
): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";

    const box = document.createElement("div");
    box.className = "dialog";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");

    const text = document.createElement("p");
    text.className = "dialog-message";
    text.textContent = message;

    const buttons = document.createElement("div");
    buttons.className = "dialog-buttons";

    const cancel = document.createElement("button");
    cancel.textContent = cancelLabel;

    const ok = document.createElement("button");
    ok.className = "primary";
    ok.textContent = confirmLabel;

    // Remove the overlay and resolve once, whichever control is used.
    const close = (value: boolean) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(value);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close(false);
      } else if (event.key === "Enter") {
        close(true);
      }
    };

    cancel.addEventListener("click", () => close(false));
    ok.addEventListener("click", () => close(true));
    // Clicking the dimmed backdrop cancels (the safe default for destructive actions).
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        close(false);
      }
    });
    document.addEventListener("keydown", onKey);

    buttons.appendChild(cancel);
    buttons.appendChild(ok);
    box.appendChild(text);
    box.appendChild(buttons);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    ok.focus();
  });
}

/**
 * Shows a modal with a title and caller-built content, and resolves when it is dismissed.
 *
 * Rationale: the bookmarklet instructions need more than a one-line message - a draggable link and a
 * couple of steps - while confirmDialog only asks a question, so the two do not share a builder. Both
 * use the same overlay so they look alike, and this one dismisses on Escape, on the Close button or on
 * a click anywhere outside the panel, which is what a reader expects from an informational popup.
 */
export function infoDialog(
  title: string,
  buildBody: (body: HTMLElement) => void,
  closeLabel = "Close"
): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";

    const box = document.createElement("div");
    box.className = "dialog dialog-info";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");

    const heading = document.createElement("h2");
    heading.className = "dialog-title";
    heading.textContent = title;

    const body = document.createElement("div");
    body.className = "dialog-body";
    buildBody(body);

    const buttons = document.createElement("div");
    buttons.className = "dialog-buttons";
    const closeButton = document.createElement("button");
    closeButton.className = "primary";
    closeButton.type = "button";
    closeButton.textContent = closeLabel;
    buttons.appendChild(closeButton);

    // Remove the overlay and resolve once, whichever way the dialog is dismissed.
    const close = () => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };

    closeButton.addEventListener("click", close);
    // A click on the dimmed backdrop closes the dialog; a click inside the panel must not.
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        close();
      }
    });
    document.addEventListener("keydown", onKey);

    box.appendChild(heading);
    box.appendChild(body);
    box.appendChild(buttons);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    closeButton.focus();
  });
}
