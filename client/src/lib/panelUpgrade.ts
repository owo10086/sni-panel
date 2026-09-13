import {
  applyGithubAccelerator,
  panelUpdateGithubAccelerator,
  type GithubAcceleratorSettings,
} from "@shared/githubAccelerator";
import { REPO_RELEASES_URL } from "@shared/repo";

export const PANEL_UPGRADE_REFRESH_DELAY_SECONDS = 8;
export const PANEL_UPGRADE_REFRESH_DELAY_MS = PANEL_UPGRADE_REFRESH_DELAY_SECONDS * 1000;

const PANEL_RELEASES_URL = REPO_RELEASES_URL;

export function getPanelChangelogUrl(
  version?: string | null,
  releaseUrl?: string | null,
  githubAccelerator?: GithubAcceleratorSettings | null,
) {
  const accelerator = panelUpdateGithubAccelerator(githubAccelerator);
  if (releaseUrl) return applyGithubAccelerator(releaseUrl, accelerator);
  const normalizedVersion = String(version || "").trim();
  if (!normalizedVersion) return applyGithubAccelerator(PANEL_RELEASES_URL, accelerator);
  const tag = normalizedVersion.startsWith("v") ? normalizedVersion : `v${normalizedVersion}`;
  return applyGithubAccelerator(`${PANEL_RELEASES_URL}/tag/${encodeURIComponent(tag)}`, accelerator);
}
