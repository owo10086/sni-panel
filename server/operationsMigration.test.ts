import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("full operational backup restores four histories and natural-key probe heads; old and essential backups remain compatible", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-operations-backup-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const kind='sqlite', port=0;
const directory=fs.mkdtempSync(path.join(process.env.FORWARDX_TEST_TEMP_ROOT, 'operations-data-'));
process.env.DATABASE_TYPE=kind;
process.env.DATABASE_CONFIG_PATH=path.join(directory,'database.json');
process.env.FORWARDX_LOG_DIR=path.join(directory,'logs');
const mod=n=>import(pathToFileURL(path.join(process.cwd(),n)).href);
const runtime=await mod('server/dbRuntime.ts');
const config=kind==='sqlite'?{type:kind,sqlite:{path:path.join(directory,'data.sqlite')}}:{type:kind,[kind]:{host:'127.0.0.1',port,user:kind==='mysql'?'root':'postgres',password:'fixture-password',database:'forwardx285'}};
try {
 runtime.writeDatabaseConfig(config); await runtime.connectDatabase(config);
 const schema=await mod('server/dbSchema.ts');await schema.ensureDatabaseSchema();await schema.ensureDatabaseSchema();
 const {quoteIdentifier:q}=await mod('server/dbCompat.ts');
 const insert=async(table,row)=>{const keys=Object.keys(row);await runtime.executeRaw('INSERT INTO '+q(table)+' ('+keys.map(q).join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')',Object.values(row));};
 const now=Math.floor(Date.now()/1000), {operationsDay}=await mod('shared/operations.ts'), day=operationsDay(now);
 await insert('users',{id:1,username:'data-admin@test.local',password:'unused',role:'admin'});
 await insert('users',{id:2,username:'data-user@test.local',password:'unused',role:'user'});
 await insert('hosts',{id:1,name:'Entry',ip:'192.0.2.1',userId:1});
 await insert('forward_rules',{id:1,name:'Port',userId:1,hostId:1,sourcePort:18080,targetIp:'192.0.2.2',targetPort:80,forwardType:'gost'});
 await insert('probe_counter_heads',{hostId:1,kind:'rule',refId:1,probeKey:'port',epoch:'test-epoch',epochStartedAt:now*1000,totalCount:3,totalSuccesses:3,recordedAt:now});
 const ops=await mod('server/repositories/operationsRepository.ts'), settings=await mod('server/repositories/settingsRepository.ts');
 const context=new Map([[1,{rule:{id:1,name:'Port',hostId:1,userId:1,isEnabled:true}}]]), host={id:1,name:'Entry'}, item={stat:{ruleId:1,bytesIn:10,bytesOut:20,connections:1},userId:1};
 await runtime.withDatabaseTransaction(()=>ops.recordOperationsTraffic([item],context,host));
 await runtime.withDatabaseTransaction(()=>ops.recordOperationsTraffic([item],context,host));
 assert.equal(Number((await ops.getOperationsOverview(day,day+86400)).trend[0].bytesIn),20);
 await assert.rejects(runtime.withDatabaseTransaction(async()=>{await ops.recordOperationsTraffic([item],context,host);throw new Error('rollback fixture');}));
 assert.equal(Number((await ops.getOperationsOverview(day,day+86400)).trend[0].bytesIn),20);
 assert.equal(await ops.sourceAnalyticsEnabled(),false);await settings.setSetting('operationsSourceAnalytics','true');
 const sample={ruleId:1,ip:'113.118.113.77',bytesIn:7,bytesOut:9,accounting:true};
 await ops.recordOperationsSources(host,[sample],context,new Map(),'sampled',now);
 await ops.recordOperationsSources(host,[sample],context,new Map(),'sampled',now);
 const sources=await ops.getOperationsSources(day,day+86400,0,'');
 assert.equal(Number(sources.totals.bytesIn),14);assert.equal(Number(sources.provinces[0].ips),1);
 const billing=await mod('server/repositories/billingRepository.ts');
 for(let i=1;i<=25;i++)await insert('payment_orders',{id:i,userId:i===25?2:1,outTradeNo:'data-order-'+i,provider:'easypay',paymentType:'alipay',status:'completed',subject:'fixture',amountCents:100,currency:i===24?'USD':'CNY',paidAt:now,createdAt:now});
 const finance=await mod('server/repositories/operationsFinanceRepository.ts');
 const finances=await finance.getOperationsFinance(day,day+86400,1);
 assert.equal(finances.receipts.find(row=>row.currency==='CNY').amountCents,2300);assert.equal(finances.receipts.find(row=>row.currency==='USD').amountCents,100);
 const pages=await Promise.all([0,1,2].map(page=>finance.getOperationsFinanceLedger(day,day+86400,1,page)));
 assert.deepEqual(pages.map(p=>p.rows.length),[10,10,4]);assert.equal(new Set(pages.flatMap(p=>p.rows.map(r=>r.id))).size,24);
 for(const page of pages)assert.ok(page.rows.every(row=>row.userId===1));
 const migration=await mod('server/migration.ts');
 const backup=await migration.exportMigrationSnapshot(undefined,{dataScope:'full',consistent:true});
 const operations=['operations_traffic_daily','operations_source_daily','operations_source_status','operations_ip_geo'];
 for(const table of [...operations,'probe_counter_heads'])assert.equal(backup.tables[table].length,1,table);
 const essential=await migration.exportMigrationSnapshot(undefined,{dataScope:'essential'});
 for(const table of operations)assert.equal(essential.tables[table],undefined,table);
 // Empty the dedicated test database and restore through the supported importer.
 for(const table of [...schema.MIGRATION_TABLES].reverse())await runtime.executeRaw('DELETE FROM '+q(table));
 const restored=await migration.importMigrationSnapshot(backup);
 assert.equal(restored.partial,false,JSON.stringify(restored.warnings));
 for(const table of [...operations,'probe_counter_heads'])assert.equal((await runtime.queryRaw('SELECT * FROM '+q(table))).length,1,table);
 const [head]=await runtime.queryRaw('SELECT * FROM '+q('probe_counter_heads'));assert.equal(Number(head.totalCount),3);assert.equal(Number(head.totalSuccesses),3);
 await runtime.executeRaw('UPDATE '+q('probe_counter_heads')+' SET '+q('totalCount')+' = 6, '+q('totalSuccesses')+' = 6');
 const merged=await migration.importMigrationSnapshot(backup);assert.equal(merged.partial,false,JSON.stringify(merged.warnings));
 const [currentHead]=await runtime.queryRaw('SELECT * FROM '+q('probe_counter_heads'));assert.equal(Number(currentHead.totalCount),6,'incremental import cannot rewind live probe counters');
 const old=structuredClone(backup);for(const table of operations)delete old.tables[table];
 for(const table of [...schema.MIGRATION_TABLES].reverse())await runtime.executeRaw('DELETE FROM '+q(table));
 const legacy=await migration.importMigrationSnapshot(old);assert.equal(legacy.partial,false,JSON.stringify(legacy.warnings));
 for(const table of operations)assert.equal((await runtime.queryRaw('SELECT * FROM '+q(table))).length,0);
 // Cleanup uses the real backend, with expired operational records only.
 await insert('operations_traffic_daily',{dayStart:day-30*86400,ruleId:1,logicalRuleId:1,hostId:1,userId:1,resourceKey:'host:1',ruleName:'expired',hostName:'Entry',resourceName:'Entry',bytesIn:1,bytesOut:1});
 await ops.cleanOperationsHistory();assert.equal((await runtime.queryRaw('SELECT * FROM '+q('operations_traffic_daily'))).length,0);
 assert.equal((await runtime.queryRaw('SELECT * FROM '+q('payment_orders'))).length,25);
 console.log(JSON.stringify({database:kind,result:'passed',checks:['schema-idempotent','traffic-upsert-and-rollback','source-default-off','offline-geo','currency-separation','pagination-owner-isolation','full-backup-four-ops-and-probe-head','essential-backup-omits-ops','restore-full','legacy-missing-ops','history-cleanup-retains-money']}));
}finally{await runtime.closeDatabase();fs.rmSync(directory,{recursive:true,force:true});}

    `], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: {...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_TEMP_ROOT: directory},
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});
