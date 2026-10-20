import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("new history cleanup stays bounded and MCP token limits hold across processes", { timeout: 90_000 }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-monitor-retention-"));
  try {
    const config = path.join(directory, "database.json");
    fs.writeFileSync(config, JSON.stringify({ type: "sqlite", sqlite: { path: path.join(directory, "test.db") } }));
    const result = spawnSync(process.execPath, ["--import", "tsx", "server/monitorRetention.fixture.ts"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 85_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_RETENTION_CONFIG: config, FORWARDX_LOG_DIR: path.join(directory, "logs"), JWT_SECRET: "retention-test-secret-only-32-characters", TELEGRAM_BOT_TOKEN: "", DISCORD_BOT_TOKEN: "" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
