// Tiny DOM helpers shared by the extension's UIs.
//
// Rationale: the hubs and the settings pages build their DOM by hand (no framework), so the same few
// helpers are needed in several entry points. Keeping them in one place stops the copies drifting.

/** Creates an element with an optional class and text. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (text != null) {
    element.textContent = text;
  }
  return element;
}

/** Creates a labelled text field; returns both the row (for layout) and the input. */
export function textField(
  label: string,
  value: string,
  enabled: boolean,
  onChange: (value: string) => void
): { row: HTMLElement; input: HTMLInputElement } {
  const row = el("label", "form-row");
  row.appendChild(el("span", "form-label", label));
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.disabled = !enabled;
  input.addEventListener("input", () => onChange(input.value));
  row.appendChild(input);
  return { row, input };
}

/** One inline SVG icon (our own static markup) plus the label a button needs. */
export interface IconButtonOptions {
  icon: string;
  label: string;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
}

/**
 * Creates an icon button with an accessible name.
 * Rationale: the row actions are icons, so the label lives in `title` + `aria-label` (screen readers
 * and hover tooltips) - the icons themselves are decorative and hidden from assistive technology.
 */
export function iconButton(options: IconButtonOptions): HTMLButtonElement {
  const button = el("button", `icon-button ${options.className || ""}`.trim());
  button.type = "button";
  button.title = options.label;
  button.setAttribute("aria-label", options.label);
  button.disabled = Boolean(options.disabled);
  // The icon is markup we ship, never user content, so assigning it as HTML is safe here.
  button.innerHTML = options.icon;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    options.onClick();
  });
  return button;
}
