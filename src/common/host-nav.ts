import * as SDK from "azure-devops-extension-sdk";

/**
 * Azure DevOps host navigation service access.
 *
 * Rationale: extension content runs in a cross-origin iframe, so a plain link would navigate
 * the iframe (or be blocked). Cross-page links (repo, settings) must ask the host to navigate.
 */

const NAV_SERVICE_ID = "ms.vss-features.host-navigation-service";

export interface HostNavigationService {
  getQueryParams(): Promise<Record<string, string>>;
  setQueryParams(parameters: Record<string, string>): void;
  getHash(): Promise<string>;
  setHash(hash: string): void;
  replaceHash(hash: string): void;
  onHashChanged(callback: (hash: string) => void): void;
  navigate(url: string): void;
  openNewWindow(url: string, features: string): void;
  reload(): void;
  setDocumentTitle(title: string): void;
}

let cached: HostNavigationService | null = null;

/** Resolves and caches the host navigation service (one call per page). */
export async function getHostNavigation(): Promise<HostNavigationService> {
  if (!cached) {
    cached = (await SDK.getService(NAV_SERVICE_ID)) as HostNavigationService;
  }
  return cached;
}

/** Navigates the Azure DevOps host (top page) to a URL. */
export async function hostNavigate(url: string): Promise<void> {
  const nav = await getHostNavigation();
  nav.navigate(url);
}
