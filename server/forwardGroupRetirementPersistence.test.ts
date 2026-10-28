import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function runPersistenceCase(kind: "sqlite" | "mysql" | "postgresql", configPath?: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-retirement-"));
  const source = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    const runtime = await import('./server/dbRuntime.ts');
    const schema = await import('./server/dbSchema.ts');
    const retirement = await import('./server/forwardGroupRetirement.ts');
    const q = runtime.quoteDbIdentifier;
    const config = process.env.FORWARDX_RETIREMENT_DB_CONFIG
      ? JSON.parse(fs.readFileSync(process.env.FORWARDX_RETIREMENT_DB_CONFIG, 'utf8'))
      : {type:'sqlite',sqlite:{path:process.env.SQLITE_PATH}};
    assert.equal(config.type,process.env.DATABASE_TYPE);
    if (config.type !== 'sqlite') assert.ok(
      String(config[config.type]?.database || '').endsWith('_retirement_test'),
      'only a dedicated retirement test database may be used');
    await runtime.connectDatabase(config);
    try {
      const tables = await runtime.queryRaw(config.type === 'sqlite'
        ? "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        : config.type === 'mysql'
          ? 'SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE()'
          : "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
      assert.equal(tables.length,0,'refuse to change a nonempty database');
      // Verify fresh creation, reconstruct the exact pre-change schema, and
      // upgrade it with an existing row rather than an empty synthetic table.
      await schema.ensureDatabaseSchema();
      assert.deepEqual(await retirement.listForwardGroupRetirements(),[]);
      await runtime.executeRaw('DROP TABLE '+q('forward_group_retirements'));
      for (const column of ['lastDdnsTtl','manualTakeoverMemberId','manualTakeoverToken']) {
        await runtime.executeRaw('ALTER TABLE '+q('forward_groups')+' DROP COLUMN '+q(column));
      }
      await runtime.insertAndGetId('forward_groups',{id:7,name:'existing group',targetIp:'192.0.2.1',userId:1});
      await schema.ensureDatabaseSchema();
      const [oldGroup] = await runtime.queryRaw('SELECT * FROM '+q('forward_groups')+' WHERE '+q('id')+'=7');
      assert.equal(oldGroup.name,'existing group');
      assert.equal(oldGroup.lastDdnsTtl,null);
      assert.equal(oldGroup.manualTakeoverMemberId,null);
      await runtime.executeRaw('UPDATE '+q('forward_groups')+' SET '+q('lastDdnsTtl')+'=?, '+q('manualTakeoverMemberId')+'=?, '+q('manualTakeoverToken')+'=? WHERE '+q('id')+'=7',[600,8,'sort-identity']);
      const startedAt = 1800000000000;
      const first = await retirement.createForwardGroupRetirement({groupId:7,memberId:9,hostId:10,ruleIds:[111,112],provider:'cloudflare',domain:'handoff.example',recordType:'A',oldValue:'192.0.2.1',oldTtl:600,startedAt});
      assert.equal(first.fallbackDeadlineAt,1800000300000);
      assert.equal(first.retireAt,null);
      const duplicate = await retirement.createForwardGroupRetirement({...first,startedAt:startedAt+60000});
      assert.deepEqual(duplicate,first,'retries keep the same batch and original deadline');
      assert.deepEqual([...await retirement.getProtectedForwardGroupRuleIds(7)],[111,112]);
      await runtime.insertAndGetId('users',{id:1,username:'retirement-owner',password:'test'});
      await runtime.insertAndGetId('hosts',{id:10,name:'retired host',ip:'192.0.2.1',userId:1});
      for (const id of [110,111,112]) await runtime.insertAndGetId('forward_rules',{
        id,hostId:10,name:'retained-'+id,userId:1,sourcePort:10000+id,targetIp:'192.0.2.100',targetPort:80,
        forwardGroupId:7,isForwardGroupTemplate:id===110,forwardGroupRuleId:id===110?null:110,
        forwardGroupMemberId:id===110?null:9,isEnabled:true,isRunning:true,
      });
      const integrity = await import('./server/forwardGroupRuleIntegrity.ts');
      const rules = await import('./server/repositories/forwardRuleRepository.ts');
      assert.equal((await integrity.repairForwardGroupRuleIntegrity()).orphanRules,0,
        'startup integrity repair retains retired members whose live member rows were removed');
      assert.ok((await rules.getForwardRuleById(111)).isEnabled);
      // Publishing the old value or another DNS identity never starts TTL.
      for (const changed of [{value:'192.0.2.1'},{domain:'new.example'},{recordType:'AAAA'},{provider:'other'}]) {
        await retirement.commitForwardGroupRetirementSwitch({groupId:7,provider:'cloudflare',domain:'handoff.example',recordType:'A',value:'192.0.2.2',ttl:60,now:startedAt+240000,...changed});
        assert.equal((await retirement.listForwardGroupRetirements(7))[0].switchedAt,null);
      }
      await runtime.withDatabaseTransaction(async () => {
        await retirement.commitForwardGroupRetirementSwitch({groupId:7,provider:'cloudflare',domain:'handoff.example',recordType:'A',value:'192.0.2.2',ttl:60,now:startedAt+240000});
      });
      const switched = (await retirement.listForwardGroupRetirements(7))[0];
      assert.equal(switched.switchedAt,1800000240000);
      assert.equal(switched.switchTtl,60);
      assert.equal(switched.retireAt,1800000840000,'old 600 second TTL survives a switch at minute four');
      await retirement.commitForwardGroupRetirementSwitch({groupId:7,provider:'cloudflare',domain:'handoff.example',recordType:'A',value:'192.0.2.3',ttl:1200,now:startedAt+250000});
      assert.deepEqual((await retirement.listForwardGroupRetirements(7))[0],switched,'later publishes cannot change the deadline');
      await runtime.closeDatabase(); await runtime.connectDatabase(config);
      assert.deepEqual((await retirement.listForwardGroupRetirements(7))[0],switched,'reconnect preserves all batch data');
      const [persistedGroup] = await runtime.queryRaw('SELECT * FROM '+q('forward_groups')+' WHERE '+q('id')+'=7');
      assert.equal(Number(persistedGroup.lastDdnsTtl),600);
      assert.equal(Number(persistedGroup.manualTakeoverMemberId),8);
      assert.equal(persistedGroup.manualTakeoverToken,'sort-identity');
      assert.equal((await retirement.markForwardGroupRetirementsDue({groupId:7,now:startedAt+300000})).length,0,'five minute fallback no longer truncates a switched batch');
      assert.equal((await retirement.markForwardGroupRetirementsDue({groupId:7,now:startedAt+839999})).length,0);
      const due = await retirement.markForwardGroupRetirementsDue({groupId:7,now:startedAt+840000});
      assert.equal(due.length,1); assert.equal(due[0].state,'retiring');
      assert.deepEqual([...await retirement.getProtectedForwardGroupRuleIds(7)],[111,112],'cleanup retries remain protected');
      await retirement.finishForwardGroupRetirement(first.id);
      assert.equal((await retirement.listForwardGroupRetirements(7)).length,0);
      assert.equal((await retirement.getProtectedForwardGroupRuleIds(7)).size,0);
      const laterStart = startedAt+3600000;
      const pending = await retirement.createForwardGroupRetirement({groupId:7,memberId:20,hostId:10,ruleIds:[113],provider:'cloudflare',domain:'handoff.example',recordType:'A',oldValue:'192.0.2.2',fallbackTtl:180,startedAt:laterStart});
      assert.equal(pending.oldTtl,180,'legacy groups snapshot the settings TTL at removal');
      await runtime.closeDatabase(); await runtime.connectDatabase(config);
      assert.deepEqual(await retirement.getForwardGroupRetirement(pending.id),pending,'restart also preserves a batch before its first switch');
      await assert.rejects(()=>runtime.withDatabaseTransaction(async()=>{
        await retirement.commitForwardGroupRetirementSwitch({groupId:7,provider:'cloudflare',domain:'handoff.example',recordType:'A',value:'192.0.2.3',ttl:60,now:laterStart+1000});
        throw new Error('rollback valid publication');
      }),/rollback valid publication/);
      assert.deepEqual(await retirement.getForwardGroupRetirement(pending.id),pending,'a publication rollback cannot consume the fallback deadline');
      await Promise.all([
        retirement.markForwardGroupRetirementsDue({groupId:7,now:laterStart+300000}),
        retirement.commitForwardGroupRetirementSwitch({groupId:7,provider:'cloudflare',domain:'handoff.example',recordType:'A',value:'192.0.2.3',ttl:600,now:laterStart+300000}),
      ]);
      const expired = await retirement.getForwardGroupRetirement(pending.id);
      assert.equal(expired.state,'retiring'); assert.equal(expired.switchedAt,null,
        'a fallback due at the same instant as a late result cannot be resurrected');
      await retirement.finishForwardGroupRetirement(pending.id);
      const forced = await retirement.createForwardGroupRetirement({groupId:7,memberId:21,hostId:10,ruleIds:[114],provider:'cloudflare',domain:'handoff.example',recordType:'A',oldValue:'192.0.2.2',oldTtl:600,startedAt:laterStart});
      assert.equal((await retirement.markForwardGroupRetirementsDue({groupId:7,hostId:99,force:true,now:laterStart})).length,0);
      assert.equal((await retirement.markForwardGroupRetirementsDue({groupId:7,hostId:10,force:true,now:laterStart}))[0].id,forced.id,
        'readding the same host can claim its retained batch immediately');
      await retirement.finishForwardGroupRetirement(forced.id);
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: {...process.env, DATABASE_TYPE:kind, SQLITE_PATH:path.join(directory,"panel.db"),
        DATABASE_CONFIG_PATH:path.join(directory,"database.json"), MYSQL_CONFIG_PATH:path.join(directory,"mysql.json"),
        MYSQL_URL:"",POSTGRES_URL:"",FORWARDX_RETIREMENT_DB_CONFIG:configPath || ""},
    });
    assert.equal(result.status,0,result.stdout+result.stderr);
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
}

test("SQLite upgrades and preserves retirement deadlines and manual takeover intent across reconnect",()=>runPersistenceCase("sqlite"));

for (const kind of ["mysql","postgresql"] as const) {
  const configPath = process.env[kind === "mysql" ? "FORWARDX_RETIREMENT_MYSQL_CONFIG" : "FORWARDX_RETIREMENT_POSTGRESQL_CONFIG"];
  test(kind+" upgrades and preserves retirement deadlines and manual takeover intent across reconnect",{
    skip:configPath ? false : "dedicated empty test database configuration is unavailable",
  },()=>runPersistenceCase(kind,configPath));
}
