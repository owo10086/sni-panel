import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("structured migration preserves retained copies and remaps the manual takeover target", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-retirement-import-"));
  const source = String.raw`
    import assert from 'node:assert/strict';
    const runtime = await import('./server/dbRuntime.ts');
    const schema = await import('./server/dbSchema.ts');
    const migration = await import('./server/migration.ts');
    const retirement = await import('./server/forwardGroupRetirement.ts');
    const rules = await import('./server/repositories/forwardRuleRepository.ts');
    const groups = await import('./server/repositories/forwardGroupRepository.ts');
    await runtime.connectDatabase(); await schema.ensureDatabaseSchema();
    try {
      await runtime.insertAndGetId('users',{id:1,username:'existing-owner',password:'test'});
      await runtime.insertAndGetId('hosts',{id:1,name:'existing-host',ip:'192.0.2.100',userId:1});
      await runtime.insertAndGetId('forward_groups',{id:1,name:'existing-group',targetIp:'192.0.2.100',userId:1});
      await runtime.insertAndGetId('forward_group_members',{id:11,groupId:1,hostId:1,memberType:'host'});
      const startedAt = Date.now();
      const result = await migration.importMigrationSnapshot({version:1,exportedAt:startedAt,tables:{
        users:[{id:1,username:'incoming-owner',password:'test'}],
        hosts:[{id:1,name:'incoming-host',ip:'192.0.2.1',userId:1}],
        forward_groups:[{id:1,name:'incoming-group',targetIp:'192.0.2.2',userId:1,manualTakeoverMemberId:11,manualTakeoverToken:'incoming-sort',lastDdnsTtl:600}],
        forward_group_members:[{id:11,groupId:1,hostId:1,memberType:'host'}],
        forward_rules:[
          {id:100,name:'incoming-root',hostId:1,userId:1,sourcePort:20000,targetIp:'192.0.2.2',targetPort:443,forwardGroupId:1,isForwardGroupTemplate:true},
          {id:101,name:'incoming-retained',hostId:1,userId:1,sourcePort:20000,targetIp:'192.0.2.2',targetPort:443,forwardGroupId:1,isForwardGroupTemplate:false,forwardGroupRuleId:100,forwardGroupMemberId:10},
        ],
        forward_group_retirements:[{id:8,groupId:1,memberId:10,hostId:1,ruleIds:'[101]',provider:'cloudflare',domain:'handoff.example',recordType:'A',oldValue:'192.0.2.1',startedAt,fallbackDeadlineAt:startedAt+300000,oldTtl:600,switchedAt:startedAt+1000,switchTtl:60,retireAt:startedAt+601000,state:'pending'}],
      }});
      assert.equal(result.success,true);
      assert.equal(result.partial,false,JSON.stringify(result));
      const [batch] = await retirement.listForwardGroupRetirements();
      assert.ok(batch); assert.notEqual(batch.groupId,1); assert.notEqual(batch.hostId,1);
      assert.equal(batch.retireAt,startedAt+601000);
      const retained = await rules.getForwardRuleById(batch.ruleIds[0]);
      assert.ok(retained); assert.equal(retained.name,'incoming-retained');
      assert.equal(Number(retained.hostId),batch.hostId);
      assert.equal(Number(retained.forwardGroupMemberId),batch.memberId);
      const incoming = await groups.getForwardGroupById(batch.groupId);
      assert.equal(incoming.manualTakeoverToken,'incoming-sort');
      assert.notEqual(Number(incoming.manualTakeoverMemberId),11);
      assert.ok(incoming.members.some(member=>Number(member.id)===Number(incoming.manualTakeoverMemberId)));
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",source],{
      cwd:process.cwd(),encoding:"utf8",timeout:60_000,
      env:{...process.env,DATABASE_TYPE:"sqlite",SQLITE_PATH:path.join(directory,"panel.db"),
        DATABASE_CONFIG_PATH:path.join(directory,"database.json"),MYSQL_CONFIG_PATH:path.join(directory,"mysql.json"),
        MYSQL_URL:"",POSTGRES_URL:""},
    });
    assert.equal(result.status,0,result.stdout+result.stderr);
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
