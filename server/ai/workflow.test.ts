import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import "./ruleCreateWizard.test";

test("real bot workflow survives process restarts, expired approvals, duplicate clicks and partial execution", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-ai-workflow-"));
  try {
    for (const provider of ["discord", "telegram"]) for (const phase of ["start", "supplement", "confirm", "finish", "security", "claim", "uncertain", "panel_start", "panel_finish", "wizard_start", "wizard_finish", "wizard_tunnel", "wizard_permissions", "wizard_settings", "menu_renew", "menu_restart", "english_wizard", "gateway_english_start", "gateway_english_finish", "english_partial_start", "english_partial_resume", "resume_preview", "legacy_stale", "manage_revoked"]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "server/ai/workflow.fixture.ts", phase], {
        cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
        env: { ...process.env, WORKFLOW_PROVIDER: provider, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, `${provider}.db`), FORWARDX_LOG_DIR: path.join(directory, "logs"), JWT_SECRET: "workflow-test-only-32-characters-secret", TELEGRAM_BOT_TOKEN: "", DISCORD_BOT_TOKEN: "" },
      });
      assert.equal(result.status, 0, `${provider}/${phase}: ${result.stderr || result.stdout}`);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
