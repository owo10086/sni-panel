import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DockerUpgradeCommands } from "../components/DockerUpgradeCommands";
import { DOCKER_COMPOSE_UPGRADE_COMMAND, getDockerUpgradeCommand, getPanelChangelogUrl } from "./panelUpgrade";

const enabledAccelerator = {
  enabled: true,
  panelUpdateEnabled: true,
  url: "https://mirror.example.com",
};

test("builds a direct changelog URL unless panel update acceleration is fully enabled", () => {
  const directUrl = "https://github.com/owo10086/sni-panel/releases/tag/v2.3.275";

  assert.equal(getPanelChangelogUrl("2.3.275"), directUrl);
  assert.equal(
    getPanelChangelogUrl("2.3.275", null, { ...enabledAccelerator, panelUpdateEnabled: false }),
    directUrl,
  );
  assert.equal(
    getPanelChangelogUrl("2.3.275", null, { ...enabledAccelerator, enabled: false }),
    directUrl,
  );
  assert.equal(
    getPanelChangelogUrl("2.3.275", null, { ...enabledAccelerator, url: "not-a-url" }),
    directUrl,
  );
});

test("accelerates generated and supplied GitHub release URLs", () => {
  const releaseUrl = "https://github.com/owo10086/sni-panel/releases/tag/v2.3.275";
  const acceleratedUrl = `https://mirror.example.com/${releaseUrl}`;

  assert.equal(getPanelChangelogUrl("2.3.275", null, enabledAccelerator), acceleratedUrl);
  assert.equal(getPanelChangelogUrl(null, releaseUrl, enabledAccelerator), acceleratedUrl);
});

test("provides the documented Compose upgrade and old-image cleanup command without markup escapes", () => {
  const documentation = fs.readFileSync("docs/guide/deploy-panel.md", "utf8").replace(/\r\n/g, "\n");
  const upgradeSection = documentation.split("### 6. 手动升级 Docker 面板")[1];
  const documentedCommand = upgradeSection?.match(/```bash\n([\s\S]*?)\n```/)?.[1];

  assert.equal(DOCKER_COMPOSE_UPGRADE_COMMAND, documentedCommand);
  assert.match(DOCKER_COMPOSE_UPGRADE_COMMAND, /--env-file \.env -p forwardx pull forwardx/);
  assert.match(DOCKER_COMPOSE_UPGRADE_COMMAND, /up -d --remove-orphans forwardx/);
  assert.match(DOCKER_COMPOSE_UPGRADE_COMMAND, /CURRENT_IMAGE_ID="\$\(docker inspect/);
  assert.match(DOCKER_COMPOSE_UPGRADE_COMMAND, /\$3 != current/);
  assert.doesNotMatch(DOCKER_COMPOSE_UPGRADE_COMMAND, /&#x20;|\\_|\\\|/);
});

test("the manual Compose upgrade command passes Bash syntax validation without executing Docker", (context) => {
  const result = spawnSync("bash", ["-n"], {
    input: DOCKER_COMPOSE_UPGRADE_COMMAND,
    encoding: "utf8",
  });

  if (result.error && "code" in result.error && result.error.code === "ENOENT") {
    context.skip("Bash is not available");
    return;
  }
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test("selects the same upgrade command for display and copying while preserving the installer command", () => {
  const installerCommand = "curl -fsSL 'https://mirror.example.com/install-panel-docker.sh' | sudo bash -s -- upgrade";

  assert.equal(getDockerUpgradeCommand("script", installerCommand), installerCommand);
  assert.equal(getDockerUpgradeCommand("manual", installerCommand), DOCKER_COMPOSE_UPGRADE_COMMAND);
  assert.equal(getDockerUpgradeCommand("manual", ""), DOCKER_COMPOSE_UPGRADE_COMMAND);
});

test("renders the manual Compose method with both upgrade choices and its configuration notice", () => {
  const markup = renderToStaticMarkup(createElement(DockerUpgradeCommands, {
    scriptCommand: "installer-command-marker",
    method: "manual",
    onMethodChange: () => undefined,
  }));

  assert.match(markup, /一键脚本/);
  assert.match(markup, /手动升级/);
  assert.match(markup, /cd \/opt\/forwardx-docker/);
  assert.match(markup, /CURRENT_IMAGE_ID/);
  assert.match(markup, /先更新 \.env 或 Compose 文件中的镜像版本/);
  assert.doesNotMatch(markup, /installer-command-marker/);
});

test("renders the installer method without the manual command and warns about rewritten files", () => {
  const markup = renderToStaticMarkup(createElement(DockerUpgradeCommands, {
    scriptCommand: "installer-command-marker",
    method: "script",
    onMethodChange: () => undefined,
  }));

  assert.match(markup, /installer-command-marker/);
  assert.match(markup, /重新生成部署目录中的 docker-compose\.yml 和 \.env/);
  assert.doesNotMatch(markup, /CURRENT_IMAGE_ID/);
});
