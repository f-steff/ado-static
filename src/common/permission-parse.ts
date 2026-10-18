// Pure parsing of the Security REST payloads used by the permission probes.
//
// Rationale: this is the part worth testing (response shapes differ between the documented array
// form and the `{ count, value }` wrapper Azure DevOps actually returns), and keeping it free of the
// SDK lets the unit tests cover it without a browser.

/** The result of a permission probe: granted, denied, or "could not be evaluated". */
export type PermissionState = true | false | null;

/** Reads the boolean out of a Security REST response (the API wraps arrays in `{count, value}`). */
export function readPermissionValue(payload: unknown): PermissionState {
  if (typeof payload === "boolean") {
    return payload;
  }
  if (Array.isArray(payload)) {
    const first = payload[0];
    return typeof first === "boolean" ? first : null;
  }
  if (payload && typeof payload === "object") {
    const values = (payload as { value?: unknown }).value;
    if (Array.isArray(values) && typeof values[0] === "boolean") {
      return values[0] as boolean;
    }
  }
  return null;
}

/**
 * Finds the bit of a named action in a security-namespace definition (case-insensitive).
 *
 * Rationale for the unwrapping: the REST API returns the definition as `{ count, value: [ { ... } ] }`,
 * while the bare object form is what the unit tests and older versions use. Looking only at the top
 * level silently answered "unknown" for every probe (B10), which fail-safely left every
 * permission-aware control visible.
 */
export function findActionBit(namespace: unknown, actionName: string): number | null {
  if (!namespace || typeof namespace !== "object") {
    return null;
  }
  const wrapper = namespace as { value?: unknown; actions?: unknown };
  const definition = Array.isArray(wrapper.value) ? wrapper.value[0] : namespace;
  if (!definition || typeof definition !== "object") {
    return null;
  }
  const actions = (definition as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) {
    return null;
  }
  const wanted = actionName.trim().toUpperCase();
  for (const action of actions) {
    if (!action || typeof action !== "object") {
      continue;
    }
    const name = (action as { name?: unknown }).name;
    const bit = (action as { bit?: unknown }).bit;
    if (typeof name === "string" && name.toUpperCase() === wanted && typeof bit === "number") {
      return bit;
    }
  }
  return null;
}
