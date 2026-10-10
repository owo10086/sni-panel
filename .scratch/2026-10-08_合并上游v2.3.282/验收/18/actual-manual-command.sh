cd /private/tmp/forwardx-282-ticket18/deployment
docker compose --env-file .env -p forwardx pull forwardx
docker compose --env-file .env -p forwardx up -d --remove-orphans forwardx
CURRENT_IMAGE_ID="$(docker inspect --format '{{.Image}}' forwardx-panel)"
docker image ls --no-trunc --format '{{.Repository}} {{.Tag}} {{.ID}}' 127.0.0.1:15518/sni-panel \
  | awk -v current="$CURRENT_IMAGE_ID" '$1 == "127.0.0.1:15518/sni-panel" && $2 != "<none>" && $3 != current { print $1 ":" $2 }' \
  | xargs -r docker image rm
