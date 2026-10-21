#!/usr/bin/env bash
set -euo pipefail
root=$(pwd)
# Build exactly once. All fixtures, panel assets and standalone downloads reuse these files.
bash scripts/build-agent-release.sh
export FORWARDX_TEST_GOST_BINARY="$root/dist/agent/forwardx-runtime-linux-amd64"
(cd agent && go test ./... && go vet ./...)
(cd forwardx-fxp && go test ./... && go vet ./...)
for cores in 1 4; do
  (cd forwardx-fxp && GOMAXPROCS="$cores" go test -run '^TestV3PoolSkipsStaleSessions$' -count=1000 -timeout=180s .)
done
(cd forwardx-fxp && go test -race ./...)
(cd agent && go test -race ./...)
(cd forwardx-fxp && FORWARDX_FXP_RELEASE_BINARY="$root/dist/agent/forwardx-fxp-linux-amd64" go test -run '^TestPublishedSniSplitterForwardsClientHelloWithECH$' -count=1 .)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
cp dist/agent/forwardx-fxp-linux-amd64 "$fixture/forwardx-fxp"
(cd agent && CGO_ENABLED=0 go test -c -o "$fixture/agent.test")
docker run --rm --network none --mount "type=bind,src=$fixture,dst=/fixtures,readonly" \
  -e FORWARDX_TEST_FXP_BINARY=/fixtures/forwardx-fxp debian:bookworm-slim \
  /fixtures/agent.test -test.run '^TestFXPRealAdditionsKeepTCPUDPAndProcessIdentity$' -test.v -test.timeout=90s
if [ "$(id -u)" -eq 0 ]; then
  env FORWARDX_TEST_PORT_LIMITS=1 "$fixture/agent.test" -test.run '^TestPortAccessLimitsNetworkNamespace$' -test.v -test.timeout=90s
else
  sudo env FORWARDX_TEST_PORT_LIMITS=1 "$fixture/agent.test" -test.run '^TestPortAccessLimitsNetworkNamespace$' -test.v -test.timeout=90s
fi
