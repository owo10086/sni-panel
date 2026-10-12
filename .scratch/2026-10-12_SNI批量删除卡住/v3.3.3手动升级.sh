#!/usr/bin/env bash

bash <<'FORWARDX_UPGRADE'
set -euo pipefail
PANEL_CONTAINER=forwardx-panel
PANEL_TARGET_VERSION='3.3.3'
PANEL_IMAGE='ghcr.io/owo10086/sni-panel:v3.3.3'
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
FORWARDX_UPGRADE
