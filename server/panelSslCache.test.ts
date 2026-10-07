import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("validated TLS cache preserves HTTPS during database outages and remains private", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-tls-cache-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import fs from "node:fs/promises";
    import path from "node:path";
    const runtime = await import("./server/dbRuntime.ts");
    const schema = await import("./server/dbSchema.ts");
    const settings = await import("./server/repositories/settingsRepository.ts");
    const { databaseHealth } = await import("./server/databaseHealthState.ts");
    const ssl = await import("./server/panelSsl.ts");
    const file = path.join(path.dirname(process.env.DATABASE_CONFIG_PATH), "panel-ssl-runtime.json");
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH } });
      await schema.ensureDatabaseSchema();
      const cert = await ssl.generateSelfSignedPanelSslCertificate(["localhost"]);
      await settings.setSettings({ panelSslEnabled: "true", panelSslMode: "pem", panelSslCertPem: await fs.readFile(cert.certPath,"utf8"), panelSslKeyPem: await fs.readFile(cert.keyPath,"utf8") });
      assert.equal((await ssl.loadPanelSslRuntimeConfig()).enabled, true);
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
      databaseHealth.unavailable(Object.assign(new Error("down"), { code: "ECONNREFUSED" }));
      await runtime.closeDatabase();
      assert.equal((await ssl.loadPanelSslRuntimeConfig()).enabled, true);
      await fs.chmod(file, 0o644);
      assert.equal((await ssl.loadPanelSslRuntimeConfig()).enabled, false, "publicly readable private-key cache must be rejected");
      await fs.writeFile(file, "invalid JSON", { mode: 0o600 });
      assert.equal((await ssl.loadPanelSslRuntimeConfig()).enabled, false);
      await fs.rm(file);
      assert.equal((await ssl.loadPanelSslRuntimeConfig()).enabled, false);
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", DATABASE_CONFIG_PATH: path.join(directory,"database.json"), SQLITE_PATH: path.join(directory,"test.db"), FORWARDX_PANEL_SSL_CERT_DIR: path.join(directory,"certs"), FORWARDX_PANEL_SSL_ENABLED: "false", JWT_SECRET: "forwardx-cache-test-secret" }, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
