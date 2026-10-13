import * as SDK from "azure-devops-extension-sdk";

import { hubUrl, orgSettingsUrl, projectSettingsUrl } from "./urls";

/**
 * Builds the extension's own hub/settings URLs.
 *
 * Rationale: the extension content runs on a CDN origin, so its own address (the ADO hub URL)
 * must be reconstructed from the host/extension context. Centralising this keeps the
 * contribution ids and URL shapes in one place.
 */

// Contribution ids (must match ado-manifests/azure-devops-extension-base.json).
export const HUB_PAGES = "static";
export const HUB_LINKS = "static-links-hub";
export const HUB_PIPELINES = "static-pipelines-hub";
export const HUB_PR = "static-pr-hub";
export const HUB_REPOS = "static-repos-hub";
export const HUB_PROJECT_ADMIN = "static-admin-hub";
export const HUB_ORG_ADMIN = "static-org-admin-hub";

/** Origin of the Azure DevOps host, preferring the referrer so legacy orgs also work. */
function hostOrigin(): string {
  const referrer = document.referrer || "";
  const match = referrer.match(/^(https?:\/\/[^/]+)/);
  return match ? match[1] : "https://dev.azure.com";
}

/** Reads the organization, current project and publisher/extension prefix from the SDK. */
function context(): { origin: string; organization: string; project: string; prefix: string } {
  const host = SDK.getHost();
  const extension = SDK.getExtensionContext();
  const web = SDK.getWebContext();
  return {
    origin: hostOrigin(),
    organization: host ? host.name : "",
    project: web && web.project ? web.project.name : "",
    prefix: extension ? `${extension.publisherId}.${extension.extensionId}` : ""
  };
}

/** URL of one of this extension's hub contributions in the current project. */
export function pagesHubUrl(hubId: string): string {
  const c = context();
  return hubUrl({
    origin: c.origin,
    organization: c.organization,
    project: c.project,
    contribution: `${c.prefix}.${hubId}`
  });
}

/** URL of a project's Pages settings page (for the org overview links). */
export function pagesProjectSettingsUrl(project: string): string {
  const c = context();
  return projectSettingsUrl({
    origin: c.origin,
    organization: c.organization,
    project,
    contribution: `${c.prefix}.${HUB_PROJECT_ADMIN}`
  });
}

/** URL of the organization's Pages settings page (for the project settings back-link). */
export function pagesOrgSettingsUrl(): string {
  const c = context();
  return orgSettingsUrl({
    origin: c.origin,
    organization: c.organization,
    contribution: `${c.prefix}.${HUB_ORG_ADMIN}`
  });
}

/**
 * The running extension version from the host context.
 * Rationale: surfaced in the UI so a tab served a stale cached bundle is obvious at a glance.
 */
export function extensionVersion(): string {
  const extension = SDK.getExtensionContext();
  return extension && extension.version ? extension.version : "unknown";
}
