import {
  applyGithubAccelerator,
  panelUpdateGithubAccelerator,
  type GithubAcceleratorSettings,
} from "@shared/githubAccelerator";
import { REPO_RELEASES_URL } from "@shared/repo";

export const PANEL_UPGRADE_REFRESH_DELAY_SECONDS = 8;
export const PANEL_UPGRADE_REFRESH_DELAY_MS = PANEL_UPGRADE_REFRESH_DELAY_SECONDS * 1000;

export type DockerUpgradeMethod = "script" | "manual";

export const DOCKER_COMPOSE_UPGRADE_COMMAND = String.raw`cd /opt/forwardx-docker
docker compose --env-file .env -p forwardx pull forwardx
docker compose --env-file .env -p forwardx up -d --remove-orphans forwardx
CURRENT_IMAGE_ID="$(docker inspect --format '{{.Image}}' forwardx-panel)"
docker image ls --no-trunc --format '{{.Repository}} {{.Tag}} {{.ID}}' ghcr.io/owo10086/sni-panel \
  | awk -v current="$CURRENT_IMAGE_ID" '$1 == "ghcr.io/owo10086/sni-panel" && $2 != "<none>" && $3 != current { print $1 ":" $2 }' \
  | xargs -r docker image rm`;

export function getDockerUpgradeCommand(method: DockerUpgradeMethod, scriptCommand: string) {
  return method === "manual" ? DOCKER_COMPOSE_UPGRADE_COMMAND : scriptCommand;
}

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
