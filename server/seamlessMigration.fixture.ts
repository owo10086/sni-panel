// Isolated two-process integration fixture; never uses the workspace database.
import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import { once } from "node:events";
import * as runtime from "./dbRuntime";
import { ensureDatabaseSchema } from "./dbSchema";
import * as state from "./seamlessMigrationState";
import { seamlessAgentProxy } from "./seamlessMigrationProxy";
import { migrationRouter, startPanelMigration, getMigrationJob, buildMigrationRuntimeExpectations } from "./migration";
import { createMigrationCode, getCurrentMigrationCode, approveMigrationRequest } from "./migrationCodes";
import { agentRouter } from "./agentRoutes";
import * as migration from "./seamlessPanelMigration";
import { importSeamlessSnapshot } from "./seamlessMigrationImport";
import { resolveAgentAdvertisedPanelUrl } from "./agentPanelUrl";
import { AGENT_VERSION } from "../shared/versions";
import { paymentCallbackRouter } from "./payment";
import { seedSeamlessRuntimeFixture } from "./seamlessRuntime.fixture";
import { decryptPayload } from "./agentCrypto";

await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
await ensureDatabaseSchema();
const app = express();
let dropActivationResponse = false;
const observations: any[] = [];
app.use(seamlessAgentProxy);
app.use(state.seamlessAdmissionMiddleware);
app.use((req, res, next) => {
  if (req.path === "/api/migration/seamless-activate" && dropActivationResponse) {
    const json = res.json.bind(res);
    res.json = ((body: any) => {
      if (body.success) { dropActivationResponse = false; res.destroy(); return res; }
      return json(body);
    }) as typeof res.json;
  }
  next();
});
app.use(paymentCallbackRouter);
app.post("/api/agent/raw-test", express.raw({ type: "*/*" }), (req, res) => res.send(req.body));
app.post("/api/payment/webhook/test", express.raw({ type: "*/*" }), async (_req, res) => {
  await runtime.executeRaw("INSERT INTO system_settings (key,value) VALUES ('test-callback','target-only')");
  res.json({ success: true });
});
app.use(express.json());
app.use((req, _res, next) => {
  if (["/api/sync", "/api/agent/traffic", "/api/agent/heartbeat"].includes(req.path)) {
    for (const token of ["migration-test-agent-token", "migration-test-exit-token"]) {
      try {
        const decoded = decryptPayload(req.body, token, { rememberReplay: false }) as any;
        const requestPath = req.path === "/api/sync" ? decoded.path : req.path;
        if (["/api/agent/traffic", "/api/agent/heartbeat"].includes(requestPath)) {
          observations.push({ path: requestPath, payload: req.path === "/api/sync" ? decoded.payload : decoded,
            phase: state.getSeamlessMigrationState()?.phase || "normal", token });
        }
        break;
      } catch { /* Other fixture identity or an unencrypted request. */ }
    }
  }
  next();
});
app.use(migrationRouter);
app.use(agentRouter);
app.post("/api/trpc/rules.create", (_req, res) => res.json({ unexpected: true }));
const server = http.createServer(app);
const bindHost = process.env.FORWARDX_TEST_HOST || "127.0.0.1";
server.listen(Number(process.env.FORWARDX_TEST_PORT || 0), bindHost);
await once(server, "listening");
const address = server.address() as any;
const url = `http://${bindHost}:${address.port}`;
process.send?.({ ready: url });
process.on("message", async (message: any) => {
  try {
    let result: any;
    switch (message.op) {
      case "seed":
        await runtime.executeRaw("INSERT INTO users (id,username,role,password) VALUES (3,'migration-admin','admin','fixture')");
        await runtime.executeRaw("INSERT INTO hosts (id,userId,name,ip,agentToken,agentVersion,isOnline,lastHeartbeat) VALUES (7,3,'fixture','127.0.0.1','migration-test-agent-token',?,1,?)", [AGENT_VERSION, Math.floor(Date.now() / 1000)]);
        await runtime.executeRaw("INSERT INTO forward_rules (id,userId,hostId,name,sourcePort,targetIp,targetPort,forwardType,protocol,isEnabled,isRunning) VALUES (101,3,7,'fixture-rule',18001,'127.0.0.1',18002,'realm','tcp',1,1)");
        await runtime.executeRaw("INSERT INTO system_settings (key,value) VALUES ('panelPublicUrl',?)", [url]);
        break;
      case "seed-runtime":
        await seedSeamlessRuntimeFixture(url, message.entryIp, message.exitIp);
        break;
      case "freeze":
        result = await migration.freezeAndExportSeamless({ sourceUrl: url, targetUrl: message.targetUrl, token: message.token, dataScope: "full" });
        break;
      case "import": {
        const snapshot = message.snapshot;
        const identity = (rows: any[]) => Object.fromEntries(rows.map((row) => [Number(row.id), Number(row.id)]));
        const expectations = buildMigrationRuntimeExpectations(snapshot, {
          hosts: identity(snapshot.tables.hosts || []), tunnels: identity(snapshot.tables.tunnels || []),
          forwardRules: identity(snapshot.tables.forward_rules || []),
        });
        state.persistSeamlessMigrationState({ version: 1, id: snapshot.seamless.id, role: "target", phase: "verifying",
          sourceUrl: message.sourceUrl, targetUrl: url, tokenHash: crypto.createHash("sha256").update(snapshot.takeoverToken).digest("hex"),
          takeoverToken: snapshot.takeoverToken, startedAt: Date.now(), expiresAt: Date.now() + 3_600_000,
          requiredHosts: expectations.hostIds, requiredRules: expectations.ruleIds, requiredTunnels: expectations.tunnelIds,
          job: { id: "fixture-job", status: "running", progress: 35, step: "fixture", startedAt: Date.now() } });
        await importSeamlessSnapshot(snapshot, url);
        state.persistSeamlessMigrationState({ ...state.getSeamlessMigrationState()!, imported: true });
        break;
      }
      case "resume": result = await migration.resumeSeamlessMigration(); break;
      case "code": result = createMigrationCode(); break;
      case "pending": result = getCurrentMigrationCode()?.pendingRequest; break;
      case "approve": result = approveMigrationRequest(message.requestId); break;
      case "start": result = startPanelMigration({ oldPanelUrl: message.sourceUrl, targetPanelUrl: url, migrationCode: message.code, dataScope: "full", seamless: true }); break;
      case "job": result = getMigrationJob(message.jobId); break;
      case "query": result = await runtime.queryRaw(message.sql); break;
      case "write": result = await runtime.executeRaw(message.sql); break;
      case "advertised": result = await resolveAgentAdvertisedPanelUrl(); break;
      case "status": result = state.getSeamlessMigrationState(); break;
      case "forget-imported": state.persistSeamlessMigrationState({ ...state.getSeamlessMigrationState()!, imported: false }); break;
      case "drop-activation-response": dropActivationResponse = true; break;
      case "observations": result = observations; break;
      default: throw new Error("Unknown fixture operation");
    }
    process.send?.({ id: message.id, result });
  } catch (error) { process.send?.({ id: message.id, error: error instanceof Error ? error.message : String(error) }); }
});
