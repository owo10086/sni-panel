import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

import { DockerUpgradeCommands } from "../components/DockerUpgradeCommands";
import { getDockerUpgradeCommand, getPanelChangelogUrl, PANEL_UPGRADE_REFRESH_KEY, readPanelUpgradeRefresh, startPanelUpgradeRefresh } from "./panelUpgrade";

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

const targetVersion = "v3.3.1";
const targetImage = "ghcr.io/owo10086/sni-panel:v3.3.1";

function manualCommand(version = targetVersion) {
  return getDockerUpgradeCommand("manual", "installer-command-marker", version);
}

function runManualUpgrade(context: TestContext, options: { pullFails?: boolean; runningVersion?: string; image?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-upgrade-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "custom panel directory");
  const bin = path.join(root, "bin");
  fs.mkdirSync(directory);
  fs.mkdirSync(bin);
  const composeFile = path.join(directory, "docker-compose.yml");
  const original = `name: custom-panel
services:
  forwardx:
    image: ${options.image || "ghcr.io/owo10086/sni-panel@sha256:old-version"}
    container_name: forwardx-panel
    ports:
      - "443:3000"
    volumes:
      - ./forwardx-data:/data
  database:
    image: postgres:16
    environment:
      POSTGRES_DB: panel
`;
  fs.writeFileSync(composeFile, original, { mode: 0o600 });
  fs.writeFileSync(path.join(directory, ".env"), "FORWARDX_IMAGE=ghcr.io/owo10086/sni-panel:v3.3.0\n");
  const log = path.join(root, "calls.jsonl");
  fs.writeFileSync(path.join(bin, "docker"), `#!${process.execPath}\n` + String.raw`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PROBE_LOG, JSON.stringify(args) + "\n");
if (args[0] === "inspect") {
  const format = args[args.indexOf("--format") + 1];
  if (format.includes("working_dir")) console.log(process.env.PROBE_DIRECTORY);
  else if (format.includes(".project")) console.log("custom-panel");
  else if (format.includes(".service")) console.log("forwardx");
  else process.exit(90);
} else if (args[0] === "pull") {
  process.exit(process.env.PROBE_PULL_FAILS === "yes" ? 1 : 0);
} else if (args[0] === "compose") {
  if (args[args.indexOf("-p") + 1] !== "custom-panel") process.exit(91);
  const filename = args[args.indexOf("-f") + 1];
  const text = fs.readFileSync(filename, "utf8");
  const block = text.split("  forwardx:\n")[1].split("  database:\n")[0];
  const image = block.match(/^    image: (.+)$/m)?.[1];
  if (args.includes("config")) console.log(image);
  else if (args.includes("up")) {
    if (path.resolve(filename) !== path.join(process.env.PROBE_DIRECTORY, "docker-compose.yml")) process.exit(92);
    if (image !== "ghcr.io/owo10086/sni-panel:v3.3.1") process.exit(93);
  } else process.exit(94);
} else if (args[0] === "exec") {
  console.log(process.env.PROBE_RUNNING_VERSION);
} else process.exit(95);
`, { mode: 0o755 });
  const result = spawnSync("bash", [], {
    input: manualCommand(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PROBE_DIRECTORY: directory,
      PROBE_LOG: log,
      PROBE_PULL_FAILS: options.pullFails ? "yes" : "no",
      PROBE_RUNNING_VERSION: options.runningVersion || "3.3.1",
    },
  });
  assert.equal(result.error, undefined);
  const calls: string[][] = fs.existsSync(log)
    ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    : [];
  return { result, original, directory, composeFile, calls };
}

test("manual upgrade replaces the pinned image in the existing deployment and verifies the running version", (context) => {
  const { result, original, directory, composeFile, calls } = runManualUpgrade(context);
  assert.equal(result.status, 0, result.stderr);
  const expected = original.replace("ghcr.io/owo10086/sni-panel@sha256:old-version", targetImage);
  assert.equal(fs.readFileSync(composeFile, "utf8"), expected);
  assert.equal(fs.statSync(composeFile).mode & 0o777, 0o600);
  const backups = fs.readdirSync(directory).filter((name) => name.startsWith("docker-compose.yml.bak-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(directory, backups[0]), "utf8"), original);
  assert.equal(fs.readFileSync(path.join(directory, ".env"), "utf8"), "FORWARDX_IMAGE=ghcr.io/owo10086/sni-panel:v3.3.0\n");
  assert.deepEqual(calls.find((args) => args[0] === "pull"), ["pull", targetImage]);
  const start = calls.find((args) => args[0] === "compose" && args.includes("up"));
  assert.ok(start?.includes("--no-deps"));
  assert.ok(start?.includes("--force-recreate"));
  assert.equal(start?.at(-1), "forwardx");
  assert.ok(calls.some((args) => args[0] === "exec"));
  assert.match(result.stdout, /3\.3\.1/);
});

test("manual upgrade also replaces an image supplied by an old .env setting", (context) => {
  const { result, composeFile } = runManualUpgrade(context, { image: "${FORWARDX_IMAGE}" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(composeFile, "utf8"), /image: ghcr\.io\/owo10086\/sni-panel:v3\.3\.1/);
});

test("a failed image download leaves the original configuration and running container untouched", (context) => {
  const { result, original, composeFile, calls } = runManualUpgrade(context, { pullFails: true });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(composeFile, "utf8"), original);
  assert.ok(!calls.some((args) => args.includes("up")));
});

test("manual upgrade fails if the recreated container still reports the old version", (context) => {
  const { result } = runManualUpgrade(context, { runningVersion: "3.3.0" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /3\.3\.0/);
});

test("manual command uses the detected target version and rejects missing or unsafe versions", () => {
  assert.match(manualCommand("v3.4.2"), /ghcr\.io\/owo10086\/sni-panel:v3\.4\.2/);
  assert.equal(manualCommand("3.4.2"), manualCommand("v3.4.2"));
  for (const version of ["", "latest", "v3.3.1;touch /tmp/unsafe", "v3.3.1\nwhoami"]) {
    assert.equal(manualCommand(version), "");
  }
});

test("the generated manual command passes Bash syntax validation", () => {
  const result = spawnSync("bash", ["-n"], { input: manualCommand(), encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test("selecting the installer preserves its original command", () => {
  const command = "curl -fsSL 'https://mirror.example.com/install-panel-docker.sh' | sudo bash -s -- upgrade";
  assert.equal(getDockerUpgradeCommand("script", command, targetVersion), command);
});

test("the manual method displays exactly the command that will be copied", () => {
  const markup = renderToStaticMarkup(createElement(DockerUpgradeCommands, {
    scriptCommand: "installer-command-marker",
    targetVersion,
    method: "manual",
    onMethodChange: () => undefined,
  }));
  const displayed = markup.match(/<code[^>]*>([\s\S]*?)<\/code>/)?.[1];
  const escaped = manualCommand().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
  assert.equal(displayed, escaped);
  assert.match(markup, /自动读取当前面板的部署目录/);
  assert.match(markup, /一键脚本/);
  assert.doesNotMatch(markup, /installer-command-marker/);
});

test("missing target versions show a check-update prompt instead of runnable manual commands", () => {
  const markup = renderToStaticMarkup(createElement(DockerUpgradeCommands, {
    scriptCommand: "installer-command-marker",
    method: "manual",
    onMethodChange: () => undefined,
  }));
  assert.match(markup, /请先检查更新/);
  assert.doesNotMatch(markup, /bash &lt;&lt;/);
});

test("renders the installer method without the manual command and explains rewritten files", () => {
  const markup = renderToStaticMarkup(createElement(DockerUpgradeCommands, {
    scriptCommand: "installer-command-marker",
    targetVersion,
    method: "script",
    onMethodChange: () => undefined,
  }));
  assert.match(markup, /installer-command-marker/);
  assert.match(markup, /重新生成部署目录中的 docker-compose\.yml 和 \.env/);
  assert.doesNotMatch(markup, /PANEL_TARGET_VERSION/);
});

function refreshHarness(deadline = 9000, initialNow = 1000) {
  let now = initialNow;
  let refreshed = 0;
  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  const countdown: number[] = [];
  const timers = {
    setInterval: (callback: () => void) => { callbacks.set(++nextId, callback); return nextId; },
    setTimeout: (callback: () => void) => { callbacks.set(++nextId, callback); return nextId; },
    clearInterval: (id: number) => { callbacks.delete(id); },
    clearTimeout: (id: number) => { callbacks.delete(id); },
  } as Pick<Window, "setInterval" | "clearInterval" | "setTimeout" | "clearTimeout">;
  const controller = startPanelUpgradeRefresh(deadline, {
    now: () => now, timers,
    onCountdown: seconds => countdown.push(seconds),
    onRefresh: () => { refreshed++; },
  });
  return { controller, callbacks, countdown, refreshed: () => refreshed, setNow: (value: number) => { now = value; } };
}

test("upgrade countdown uses elapsed wall time instead of counting timer ticks", () => {
  const h = refreshHarness();
  assert.deepEqual(h.countdown, [8]);
  h.setNow(4200);
  h.controller.check();
  assert.deepEqual(h.countdown, [8, 5]);
  assert.equal(h.refreshed(), 0);
  h.setNow(8999);
  h.controller.check();
  assert.equal(h.countdown.at(-1), 1);
  h.setNow(9000);
  h.controller.check();
  assert.equal(h.countdown.at(-1), 0);
  assert.equal(h.refreshed(), 1);
  assert.equal(h.callbacks.size, 0);
});

test("background timer or resume event refreshes once after a throttled/frozen deadline", () => {
  for (const resumeByEvent of [true, false]) {
    const h = refreshHarness();
    const staleCallbacks = [...h.callbacks.values()];
    h.setNow(75000);
    if (resumeByEvent) h.controller.check();
    else staleCallbacks[0]();
    for (const callback of staleCallbacks) callback();
    h.controller.check();
    assert.equal(h.refreshed(), 1);
    assert.deepEqual(h.countdown, [8, 0]);
  }
});

test("unmount cleanup stops callbacks; remount preserves the original deadline", () => {
  const h = refreshHarness();
  const callbacks = [...h.callbacks.values()];
  h.controller.dispose();
  h.setNow(9500);
  for (const callback of callbacks) callback();
  assert.equal(h.refreshed(), 0);
  assert.equal(h.callbacks.size, 0);
  const resumed = refreshHarness(9000, 9500);
  assert.deepEqual(resumed.countdown, [0]);
  assert.equal(resumed.refreshed(), 1);
});

test("refresh session persists both deadlines and completed job identity without accepting corrupt data", () => {
  const storage = (raw: string | null) => ({ getItem: (key: string) => { assert.equal(key, PANEL_UPGRADE_REFRESH_KEY); return raw; } });
  const pending = { jobKey: "upgrade:2.3.285:1000", deadline: 9000 };
  assert.deepEqual(readPanelUpgradeRefresh(storage(JSON.stringify(pending))), { ...pending, completed: false });
  assert.deepEqual(readPanelUpgradeRefresh(storage(JSON.stringify({ ...pending, completed: true }))), { ...pending, completed: true });
  for (const raw of [null, "not json", "{}", "null", '{"jobKey":"x","deadline":"9000"}', '{"jobKey":"","deadline":9000}']) {
    assert.equal(readPanelUpgradeRefresh(storage(raw)), null);
  }
});

test("upgrade status observers allow background polling and the layout handles resume events", () => {
  for (const file of ["client/src/components/DashboardLayout.tsx", "client/src/pages/Settings.tsx"]) {
    const source = readFileSync(file, "utf8");
    const query = source.slice(source.indexOf("trpc.system.upgradeStatus.useQuery"));
    assert.match(query.slice(0, 650), /refetchIntervalInBackground: true/);
  }
  const layout = readFileSync("client/src/components/DashboardLayout.tsx", "utf8");
  for (const event of ["focus", "pageshow", "visibilitychange"]) {
    assert.ok(layout.includes(`addEventListener("${event}", refresh.check)`));
    assert.ok(layout.includes(`removeEventListener("${event}", refresh.check)`));
  }
  assert.doesNotMatch(layout, /setUpgradeRefreshCountdown\(\(value\)/);
});
