import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function scenario(name: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-notification-safety-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "server/notificationSafety.fixture.ts", name], {
      cwd: process.cwd(), encoding: "utf8", timeout: 45_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "panel.db"),
        FORWARDX_SEAMLESS_MIGRATION_STATE_PATH: path.join(directory, "migration.json"), FORWARDX_LOG_DIR: path.join(directory, "logs"),
        TELEGRAM_BOT_TOKEN: "", DISCORD_BOT_TOKEN: "", JWT_SECRET: "notification-test-secret-32-characters" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test("both notification providers pause for database failures and independent migration protection", () => scenario("protection"));
test("Telegram binding codes cannot bind disabled accounts or be consumed twice", () => scenario("binding"));
test("Telegram one-time login requires the active provider and rejects reused, expired and disabled codes", () => scenario("login"));
test("Telegram group messages and group buttons cannot disclose accounts or consume binding codes", () => scenario("private"));
test("Telegram concurrent starts and immediate restart keep one poller and discard old responses", () => scenario("lifecycle"));
test("Telegram stops fetching updates when slow handlers fill the bounded queue", () => scenario("queue"));
test("Telegram queued account commands recheck database protection before binding", () => scenario("queued-protection"));
