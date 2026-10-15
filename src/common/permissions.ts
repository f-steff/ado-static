import * as SDK from "azure-devops-extension-sdk";

import { currentProjectId, organizationName } from "./data-service";
import { PermissionState, findActionBit, readPermissionValue } from "./permission-parse";
import { logDebug } from "./log";

/**
 * Permission probes for the surfaces that should only offer an action the user may perform.
 *
 * Rationale: the project-settings page is only reachable by users who may manage the project, but
 * the *hubs* are read by everyone, and a hub that says "add links under Project settings" to a user
 * who cannot open Project settings is simply wrong. The same applies to the link from the project
 * settings page into the organization settings.
 *
 * How: the documented Security REST API evaluates a permission for the *caller*:
 * `GET /_apis/permissions/{namespaceId}/{permissions}?tokens={token}&alwaysAllowAdministrators=true`.
 * The numeric permission is resolved from the namespace definition by action name, so no bitmask is
 * hardcoded here (the payload parsing lives in ./permission-parse, which the unit tests cover).
 *
 * Failure policy: a probe that cannot be evaluated returns `null` ("unknown") and callers keep the
 * previous behaviour of showing the control. Hiding something from a user who does have access is
 * worse than showing something the host will deny anyway - and `alwaysAllowAdministrators=true`
 * keeps administrators, who are the audience of these controls, out of that trap.
 */

/** Project security namespace (docs: "Namespace reference"). */
const NAMESPACE_PROJECT = "52d39943-cb85-4d7f-8fa8-c6baac873819";
/** Collection (organization) security namespace. */
const NAMESPACE_COLLECTION = "3e65f728-f8bc-4ecd-8764-7e378b19bfa7";

export type { PermissionState };

/** Issues an authenticated, JSON GET (the probes are plain REST reads). */
async function getJson(url: string): Promise<unknown> {
  const token = await SDK.getAccessToken();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`GET ${url} -> ${response.status}`);
  }
  return (await response.json()) as unknown;
}

/**
 * Evaluates one permission for the caller.
 * `token` is the security token of the resource; an empty string evaluates the namespace root.
 */
async function hasPermission(
  namespaceId: string,
  actionName: string,
  token: string
): Promise<PermissionState> {
  try {
    const organization = organizationName();
    if (!organization) {
      return null;
    }
    const base = `https://dev.azure.com/${organization}/_apis`;
    // Resolve the action's bit from the namespace definition rather than hardcoding a bitmask.
    const definition = await getJson(`${base}/securitynamespaces/${namespaceId}?api-version=7.1`);
    const bit = findActionBit(definition, actionName);
    if (bit == null) {
      logDebug("permission action not found in namespace.", { namespaceId, actionName });
      return null;
    }
    const tokens = token ? `&tokens=${encodeURIComponent(token)}` : "";
    const evaluated = await getJson(
      `${base}/permissions/${namespaceId}/${bit}?alwaysAllowAdministrators=true${tokens}&api-version=7.1`
    );
    return readPermissionValue(evaluated);
  } catch (error) {
    // An unavailable probe is not a denial: the caller keeps the historical behaviour.
    logDebug("permission probe could not be evaluated.", { namespaceId, actionName, error });
    return null;
  }
}

/**
 * Whether the caller may open this project's settings ("Manage project properties", which project
 * administrators have). Used to word the Links hub hint correctly for members who cannot.
 */
export async function canAccessProjectSettings(): Promise<PermissionState> {
  const projectId = currentProjectId();
  if (!projectId) {
    return null;
  }
  // Project-level tokens are `$PROJECT:vstfs:///Classification/TeamProject/{projectId}`.
  const token = `$PROJECT:vstfs:///Classification/TeamProject/${projectId}`;
  return hasPermission(NAMESPACE_PROJECT, "MANAGE_PROPERTIES", token);
}

/**
 * Whether the caller may open the organization settings (collection administrators have the
 * collection's write permission; ordinary members do not).
 */
export async function canAccessOrgSettings(): Promise<PermissionState> {
  return hasPermission(NAMESPACE_COLLECTION, "GENERIC_WRITE", "");
}
