import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("tunnel API rejects V3 creation and switching while preserving existing V1 and V2", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-tunnel-version-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import { pathToFileURL } from "node:url";
      import path from "node:path";
      const load = file => import(pathToFileURL(path.join(process.cwd(), file)).href);
      const runtime = await load("server/dbRuntime.ts");
      const schema = await load("server/dbSchema.ts");
      try {
        await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH } });
        await schema.ensureDatabaseSchema();
        await runtime.executeRaw('INSERT INTO "hosts" ("id", "name", "ip", "hostType", "userId", "agentVersion", "isOnline") VALUES (1, ?, ?, ?, 1, ?, 1), (2, ?, ?, ?, 1, ?, 1)',
          ["entry", "198.51.100.10", "slave", "3.3.0", "exit", "198.51.100.11", "slave", "3.3.0"]);
        for (const [id, version] of [[10, "v1"], [20, "v2"]]) {
          await runtime.executeRaw('INSERT INTO "tunnels" ("id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "forwardxVersion", "userId", "isEnabled") VALUES (?, ?, 1, 2, ?, ?, ?, 1, 1)',
            [id, "existing-" + version, "forwardx", 22600 + id, version]);
        }
        const { tunnelsRouter } = await load("server/routers/tunnels.ts");
        const caller = tunnelsRouter.createCaller({ user: { id: 1, role: "admin" }, req: { headers: {} }, res: {} });
        const rejectsV3 = error => error.code === "BAD_REQUEST" && /V3/.test(error.message);
        await assert.rejects(caller.create({ name: "closed-v3", entryHostId: 1, exitHostId: 2, mode: "forwardx", forwardxVersion: "v3", v3Transport: "ws" }), rejectsV3);
        for (const [id, version] of [[10, "v1"], [20, "v2"]]) {
          await assert.rejects(caller.update({ id, forwardxVersion: "v3", v3Transport: "ws" }), rejectsV3);
          const row = (await runtime.queryRaw('SELECT * FROM "tunnels" WHERE "id" = ?', [id]))[0];
          assert.equal(row.forwardxVersion, version);
          assert.equal(row.name, "existing-" + version);
          await caller.update({ id, name: "renamed-" + version });
          const renamed = (await runtime.queryRaw('SELECT * FROM "tunnels" WHERE "id" = ?', [id]))[0];
          assert.equal(renamed.forwardxVersion, version, "ordinary saves must preserve the transport");
          assert.equal(renamed.name, "renamed-" + version);
        }
        assert.equal((await runtime.queryRaw('SELECT COUNT(*) AS total FROM "tunnels"'))[0].total, 2);
        // A restored row may carry a dormant V3 value under another tool.
        // Omitting the version must not bypass the block when changing tools.
        await runtime.executeRaw('INSERT INTO "tunnels" ("id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "forwardxVersion", "v3Transport", "userId", "isEnabled") VALUES (30, ?, 1, 2, ?, 22630, ?, ?, 1, 1)',
          ["restored-legacy", "tls", "v3", "ws"]);
        await assert.rejects(caller.update({ id: 30, mode: "forwardx" }), rejectsV3);
        const dormant = (await runtime.queryRaw('SELECT * FROM "tunnels" WHERE "id" = 30'))[0];
        assert.equal(dormant.mode, "tls");
        assert.equal(dormant.forwardxVersion, "v3");
      } finally {
        await runtime.closeDatabase();
      }
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        SQLITE_PATH: path.join(directory, "panel.db"),
        DATABASE_CONFIG_PATH: path.join(directory, "database.json"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
