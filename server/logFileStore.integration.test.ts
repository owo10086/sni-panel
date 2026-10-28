import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

for (const [timezone, oldest, expired] of [
  ["America/Los_Angeles", "2026-10-25T07:00:00Z", "2026-10-25T06:59:59Z"],
  ["Asia/Tokyo", "2026-10-25T15:00:00Z", "2026-10-25T14:59:59Z"],
]) test(`authenticated panel log query and export retain three local dates in ${timezone}`, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sni-log-interface-"));
  const script = String.raw`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { mock } from 'node:test';
    import jwt from 'jsonwebtoken';
    import * as runtime from './server/dbRuntime.ts';
    import { ensureDatabaseSchema } from './server/dbSchema.ts';
    import { createAuthSession } from './server/repositories/sessionRepository.ts';
    import { createContext, updateMultiDeviceLoginSettingCache } from './server/_core/context.ts';
    import { databaseHealth } from './server/databaseHealthState.ts';
    import { systemRouter } from './server/_core/systemRouter.ts';
    import { installPanelLogger } from './server/_core/panelLogger.ts';
    import { appendJsonLog, flushJsonLogWrites, pruneJsonLogFile } from './server/logFileStore.ts';
    import { COOKIE_NAME } from './shared/const.ts';
    mock.timers.enable({apis:['Date','setTimeout'],now:new Date('2026-10-28T00:30:00Z')});
    await runtime.connectDatabase({type:'sqlite',sqlite:{path:process.env.SQLITE_PATH}});
    await ensureDatabaseSchema();
    await runtime.executeRaw("INSERT INTO users (id,username,password,role) VALUES (1,'admin','x','admin')");
    await createAuthSession({userId:1,sid:'log-session',kind:'browser',expiresAt:new Date('2026-11-01T00:00:00Z')});
    updateMultiDeviceLoginSettingCache(true);databaseHealth.healthy();
    const token=jwt.sign({userId:1,sid:'log-session',kind:'browser'},process.env.JWT_SECRET);
    const req={headers:{},cookies:{[COOKIE_NAME]:token}};
    const ctx=await createContext({req,res:{clearCookie(){}},info:{}});
    const api=systemRouter.createCaller(ctx);
    const file=path.join(process.env.FORWARDX_LOG_DIR,'panel.jsonl');
    const entry=(id,createdAt,level='info')=>({id,createdAt,level,message:'message-'+id});
    try {
      appendJsonLog(file,entry('expired',process.env.EXPIRED));
      appendJsonLog(file,entry('boundary',process.env.OLDEST));
      appendJsonLog(file,entry('previous','2026-10-27T00:00:00Z','warn'));
      appendJsonLog(file,entry('latest','2026-10-28T00:30:00Z','warn'));
      await flushJsonLogWrites(file);
      const first=await api.panelLogs({limit:2});
      assert.deepEqual(first.logs.map(log=>log.id),['latest','previous']);
      assert.equal(first.total,3);assert.equal(first.hasMore,true);
      assert.deepEqual((await api.panelLogs({limit:2,offset:first.nextOffset})).logs.map(log=>log.id),['boundary']);
      assert.deepEqual((await api.panelLogs({level:'warn'})).logs.map(log=>log.id),['latest','previous']);
      const exported=await api.exportPanelLogs({level:'all'});
      assert.equal(exported.count,3);assert.ok(exported.content.includes('message-boundary'));assert.ok(!exported.content.includes('message-expired'));
      assert.ok(exported.content.indexOf('message-boundary')<exported.content.indexOf('message-latest'));
      const unrelated=path.join(process.env.FORWARDX_LOG_DIR,'journal.2000-01-01.jsonl');fs.writeFileSync(unrelated,'external');
      await pruneJsonLogFile(file);
      assert.equal(fs.readFileSync(unrelated,'utf8'),'external');
      await api.clearPanelLogs();
      assert.equal((await api.panelLogs()).total,0,'clearing removes current and archived records');
      // Startup rotates a previous-day current file into an existing archive
      // without replacing its earlier records; it also deletes expired files.
      const yesterday=new Date('2026-10-27T00:00:00Z');
      const day=process.env.TZ==='America/Los_Angeles'?'2026-10-26':'2026-10-27';
      const archive=path.join(process.env.FORWARDX_LOG_DIR,'panel.'+day+'.jsonl');
      fs.writeFileSync(archive,JSON.stringify(entry('earlier',yesterday.toISOString()))+'\n');
      fs.writeFileSync(file,JSON.stringify(entry('midnight',yesterday.toISOString()))+'\n');
      fs.utimesSync(file,yesterday,yesterday);
      const expiredArchive=path.join(process.env.FORWARDX_LOG_DIR,'panel.2000-01-01.jsonl');
      fs.writeFileSync(expiredArchive,'old');
      installPanelLogger();
      assert.deepEqual((await api.panelLogs()).logs.map(log=>log.id),['midnight','earlier']);
      assert.equal(fs.existsSync(expiredArchive),false);
      assert.equal(fs.existsSync(file),false);
      assert.deepEqual(fs.readFileSync(archive,'utf8').trim().split('\n').map(line=>JSON.parse(line).id),['earlier','midnight']);
      // No appends: the installed midnight maintenance timer must still age
      // out old archives. The query only waits for the serialized maintenance.
      mock.timers.tick(4*24*60*60*1000);
      assert.equal((await api.panelLogs()).total,0);
      assert.equal(fs.existsSync(archive),false);
      assert.equal(fs.readFileSync(unrelated,'utf8'),'external');
    } finally {mock.timers.reset();await runtime.closeDatabase();}
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      encoding: "utf8", timeout: 20_000,
      env: { ...process.env, TZ: timezone, OLDEST: oldest, EXPIRED: expired, DATABASE_TYPE: "sqlite", SQLITE_PATH: path.join(dir, "panel.db"), DATABASE_CONFIG_PATH: path.join(dir, "config.json"), JWT_SECRET: "log-integration-test-secret-long-enough", FORWARDX_DEV_PANEL: "0", FORWARDX_LOG_DIR: path.join(dir, "logs") },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
