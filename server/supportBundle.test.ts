import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Never read the developer's database/config when exporting a test support bundle.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-support-bundle-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "panel.db");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");

const { AGENT_TUNNEL_PATHS } = await import("./agentEncryptionMiddleware");
const { createSupportBundleTask, getSupportBundleTask, redactSupportValue } = await import("./supportBundle");
const runtime = await import("./dbRuntime");
const schema = await import("./dbSchema");
before(async () => {
  await runtime.connectDatabase();
  await schema.ensureDatabaseSchema();
});
after(async () => {
  await runtime.closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("Agent support and migration reports are accepted through the encrypted sync tunnel", () => {
  assert.equal(AGENT_TUNNEL_PATHS.has("/api/agent/support-bundle-result"), true);
  assert.equal(AGENT_TUNNEL_PATHS.has("/api/agent/migration-rollback"), true);
});

test("support bundle redaction removes nested credentials", () => {
  const value = redactSupportValue({ token: "abc", nested: { password: "def", message: "token=ghi" } });
  assert.deepEqual(value, { token: "[REDACTED]", nested: { password: "[REDACTED]", message: "token=[REDACTED]" } });
});

test("support bundle completes immediately for offline Agents", async () => {
  const task = createSupportBundleTask([{ id: 9, name: "offline", isOnline: false, agentToken: "hidden" }]);
  const status = await getSupportBundleTask(task.taskId);
  assert.equal(status?.complete, true);
  assert.equal(status?.hosts[0]?.status, "offline");
  assert.ok(status?.download?.content.includes("forwardx-support-bundle-v1"));
  assert.ok(!status?.download?.content.includes("hidden"));
});

test("support download includes retained panel archives and redacts their credentials", async () => {
  const { appendJsonLog, flushJsonLogWrites } = await import("./logFileStore");
  const file = path.join(process.env.FORWARDX_LOG_DIR!, "panel.jsonl");
  const retained = new Date();retained.setHours(0, 0, 0, 0);retained.setDate(retained.getDate() - 2);
  const expired = new Date(retained);expired.setDate(expired.getDate() - 1);
  appendJsonLog(file, { id: "retained", createdAt: retained.toISOString(), level: "warn", message: "retained-diagnostic token=private-test-token" });
  appendJsonLog(file, { id: "expired", createdAt: expired.toISOString(), level: "warn", message: "expired-diagnostic" });
  await flushJsonLogWrites(file);
  const task = createSupportBundleTask([]);
  const status = await getSupportBundleTask(task.taskId);
  assert.equal(status?.complete, true);
  assert.ok(status?.download?.content.includes("retained-diagnostic"));
  assert.ok(!status?.download?.content.includes("expired-diagnostic"));
  assert.ok(!status?.download?.content.includes("private-test-token"));
});
