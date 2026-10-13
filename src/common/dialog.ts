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
