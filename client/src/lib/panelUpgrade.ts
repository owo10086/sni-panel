import {
  applyGithubAccelerator,
  panelUpdateGithubAccelerator,
  type GithubAcceleratorSettings,
} from "@shared/githubAccelerator";
import { GITHUB_SLUG, REPO_RELEASES_URL } from "@shared/repo";

export const PANEL_UPGRADE_REFRESH_DELAY_SECONDS = 8;
export const PANEL_UPGRADE_REFRESH_DELAY_MS = PANEL_UPGRADE_REFRESH_DELAY_SECONDS * 1000;

export type DockerUpgradeMethod = "script" | "manual";

export function getDockerUpgradeCommand(
  method: DockerUpgradeMethod,
  scriptCommand: string,
  targetVersion?: string | null,
) {
  if (method === "script") return scriptCommand;
  const version = String(targetVersion || "").trim().match(/^v?(\d+\.\d+\.\d+)$/)?.[1];
  if (!version) return "";

  return String.raw`bash <<'FORWARDX_UPGRADE'
set -euo pipefail
PANEL_CONTAINER=forwardx-panel
PANEL_TARGET_VERSION='${version}'
PANEL_IMAGE='ghcr.io/${GITHUB_SLUG}:v${version}'
PANEL_DIR="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$PANEL_CONTAINER")"
PANEL_PROJECT="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$PANEL_CONTAINER")"
PANEL_SERVICE="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$PANEL_CONTAINER")"
if [[ "$PANEL_DIR" != /* || -z "$PANEL_PROJECT" || -z "$PANEL_SERVICE" ]]; then
  echo 'Cannot identify the existing Compose deployment.' >&2
  exit 1
fi
cd -- "$PANEL_DIR"
PANEL_COMPOSE="$PANEL_DIR/docker-compose.yml"
test -f "$PANEL_COMPOSE"
PANEL_NEXT="$(mktemp "$PANEL_COMPOSE.upgrade.XXXXXX")"
trap 'rm -f "$PANEL_NEXT"' EXIT
if ! awk -v service="$PANEL_SERVICE" -v image="$PANEL_IMAGE" '
  /^[^[:space:]#]/ { services = ($0 ~ /^services:[[:space:]]*(#.*)?$/); active = 0 }
  services && /^  [^[:space:]#]/ { active = ($1 == service ":") }
  active && /^    image:/ { $0 = "    image: " image; changed++ }
  { print }
  END { if (changed != 1) exit 1 }
' "$PANEL_COMPOSE" > "$PANEL_NEXT"; then
  echo 'Cannot update the panel image in docker-compose.yml; check the service configuration.' >&2
  exit 1
fi
panel_compose() {
  local file="$1"
  shift
  docker compose --project-directory "$PANEL_DIR" -p "$PANEL_PROJECT" -f "$file" "$@"
}
test "$(panel_compose "$PANEL_NEXT" config --images "$PANEL_SERVICE")" = "$PANEL_IMAGE"
docker pull "$PANEL_IMAGE"
cp -p "$PANEL_COMPOSE" "$PANEL_COMPOSE.bak-$(date +%Y%m%d-%H%M%S)"
cat "$PANEL_NEXT" > "$PANEL_COMPOSE"
panel_compose "$PANEL_COMPOSE" up -d --no-deps --force-recreate "$PANEL_SERVICE"
PANEL_ACTUAL_VERSION="$(docker exec "$PANEL_CONTAINER" node -p 'require("./package.json").version')"
if [ "$PANEL_ACTUAL_VERSION" != "$PANEL_TARGET_VERSION" ]; then
  echo "Version check failed: expected $PANEL_TARGET_VERSION, got $PANEL_ACTUAL_VERSION" >&2
  exit 1
fi
printf 'ForwardX panel version: %s\n' "$PANEL_ACTUAL_VERSION"
FORWARDX_UPGRADE`;
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
