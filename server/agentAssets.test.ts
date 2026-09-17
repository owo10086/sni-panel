import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AGENT_VERSION, APP_VERSION } from "../shared/versions";
import { getMissingBundledAgentAssets, getOrFetchAgentAssetPath } from "./agentAssets";

test("release asset validation accepts the three published amd64 binaries", async (t) => {
  const originalCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "forwardx-release-assets-"));
  const releaseVersion = "9999.0.0";
  const assetDir = path.join(tempDir, "dist", "agent", `v${releaseVersion}`);
  const assets = ["forwardx-agent-linux-amd64", "forwardx-fxp-linux-amd64", "forwardx-runtime-linux-amd64"];

  await fs.mkdir(assetDir, { recursive: true });
  for (const asset of assets) {
    await fs.writeFile(path.join(assetDir, asset), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01]));
  }

  process.chdir(tempDir);
  t.after(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  assert.deepEqual(getMissingBundledAgentAssets(releaseVersion), []);
  assert.deepEqual(getMissingBundledAgentAssets("9999.0.1"), assets);
});

test("panel resolves the bundled amd64 FXP asset", async (t) => {
  const originalCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "forwardx-agent-assets-"));
  const assetDir = path.join(tempDir, "dist", "agent");
  const asset = "forwardx-fxp-linux-amd64";

  await fs.mkdir(assetDir, { recursive: true });
  await fs.writeFile(path.join(assetDir, asset), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01]));

  process.chdir(tempDir);
  t.after(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const expected = await fs.realpath(path.join(assetDir, asset));
  assert.equal(await getOrFetchAgentAssetPath(`v${APP_VERSION}`, asset), expected);
  assert.equal(await getOrFetchAgentAssetPath(AGENT_VERSION, asset), expected);
});

test("panel rejects invalid FXP asset requests before attempting a download", async () => {
  assert.equal(await getOrFetchAgentAssetPath("not-a-version", "forwardx-fxp-linux-amd64"), null);
  assert.equal(await getOrFetchAgentAssetPath(APP_VERSION, "forwardx-fxp-linux-unknown"), null);
  for (const asset of ["forwardx-agent-linux-arm64", "forwardx-fxp-linux-arm64", "forwardx-runtime-linux-arm64"]) {
    assert.equal(await getOrFetchAgentAssetPath(APP_VERSION, asset), null);
  }
});
