import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AGENT_VERSION, APP_VERSION } from "../shared/versions";
import { getOrFetchAgentAssetPath } from "./agentAssets";

test("panel resolves bundled FXP assets for both supported architectures", async (t) => {
  const originalCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "forwardx-agent-assets-"));
  const assetDir = path.join(tempDir, "dist", "agent");
  const assets = ["forwardx-fxp-linux-amd64", "forwardx-fxp-linux-arm64"];

  await fs.mkdir(assetDir, { recursive: true });
  for (const asset of assets) {
    await fs.writeFile(path.join(assetDir, asset), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01]));
  }

  process.chdir(tempDir);
  t.after(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  for (const asset of assets) {
    const expected = await fs.realpath(path.join(assetDir, asset));
    assert.equal(await getOrFetchAgentAssetPath(`v${APP_VERSION}`, asset), expected);
    assert.equal(await getOrFetchAgentAssetPath(AGENT_VERSION, asset), expected);
  }
});

test("panel rejects invalid FXP asset requests before attempting a download", async () => {
  assert.equal(await getOrFetchAgentAssetPath("not-a-version", "forwardx-fxp-linux-amd64"), null);
  assert.equal(await getOrFetchAgentAssetPath(APP_VERSION, "forwardx-fxp-linux-unknown"), null);
});
