import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("operations routes page four fixed sequences without gaps, preserve boundaries and isolate cached sizes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-operations-pagination-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", String.raw`
      import assert from 'node:assert/strict';
      const rt = await import('./server/dbRuntime.ts');
      await rt.connectDatabase({type:'sqlite',sqlite:{path:process.env.FORWARDX_TEST_DB}});
      await (await import('./server/dbSchema.ts')).ensureDatabaseSchema();
      const {operationsDay,operationsDate} = await import('./shared/operations.ts');
      const now = Math.floor(Date.now()/1000), start = operationsDay(now);
      try {
        await rt.insertAndGetId('users',{id:1,username:'admin',password:'test-only',role:'admin'});
        await rt.insertAndGetId('hosts',{id:1,name:'Entry',ip:'192.0.2.1',userId:1});
        await rt.insertAndGetId('host_probe_services',{id:1,name:'Probe',userId:1,targetIp:'192.0.2.2'});
        await rt.withDatabaseTransaction(async () => {
          for (let id=1;id<=117;id++) {
            await rt.insertAndGetId('operations_source_daily',{dayStart:start,ruleId:1,hostId:1,ip:'192.0.2.'+id,userId:1,logicalRuleId:1,bytesIn:id,bytesOut:0,knownSamples:1,unknownSamples:0,lastSeen:now});
            if (id%2) await rt.insertAndGetId('payment_orders',{id,userId:1,outTradeNo:'pagination-'+id,provider:'easypay',paymentType:'alipay',subject:'Fixture',orderType:'balance',currency:'CNY',amountCents:100,status:'completed',createdAt:start+id,paidAt:start+id});
            else await rt.insertAndGetId('balance_transactions',{id,userId:1,type:'payment',amountCents:100,balanceAfterCents:100,createdAt:start+id});
            await rt.insertAndGetId('operations_alert_events',{id,hostId:1,hostName:'Entry',metric:'cpu',type:'triggered',value:95,createdAt:now});
            await rt.insertAndGetId('host_ip_switch_attempts',{id,hostId:1,serviceId:1,incidentId:'pagination-'+id,status:'succeeded',createdAt:now});
          }
        });
        const {operationsRouter} = await import('./server/routers/operations.ts');
        const caller = operationsRouter.createCaller({user:{id:1,role:'admin'},req:{headers:{}},res:{}});
        const dates = {from:operationsDate(start),to:operationsDate(start)};
        const ids = Array.from({length:117},(_,i)=>117-i);
        const sourceIds = ids.map(id=>'192.0.2.'+id);
        for (const pageSize of [20,50,1000,1]) {
          const allSources=[], allLedger=[], allAlerts=[], allIps=[];
          const pages=Math.ceil(117/pageSize);
          for (let page=0;page<pages;page++) {
            const sources=await caller.sources({...dates,page,pageSize});
            const ledger=await caller.financeLedger({...dates,page,pageSize});
            const monitor=await caller.monitor({page,ipPage:page,pageSize,ipPageSize:pageSize});
            const expectedLength=Math.min(pageSize,117-page*pageSize);
            assert.equal(sources.ips.length,expectedLength,'source size '+pageSize);
            assert.equal(ledger.rows.length,expectedLength,'ledger size '+pageSize);
            assert.equal(monitor.events.length,expectedLength,'alert size '+pageSize);
            assert.equal(monitor.ipEvents.length,expectedLength,'IP size '+pageSize);
            assert.equal(ledger.page,page); assert.equal(monitor.page,page); assert.equal(monitor.ipPage,page);
            allSources.push(...sources.ips.map(row=>row.ip));
            allLedger.push(...ledger.rows.map(row=>row.id));
            allAlerts.push(...monitor.events.map(row=>row.id));
            allIps.push(...monitor.ipEvents.map(row=>row.id));
          }
          assert.deepEqual(allSources,sourceIds);
          for (const actual of [allLedger,allAlerts,allIps]) assert.deepEqual(actual,ids);
          assert.equal((await caller.sources({...dates,page:pages,pageSize})).ips.length,0);
          const pastLedger=await caller.financeLedger({...dates,page:pages,pageSize});
          assert.equal(pastLedger.page,pages-1);
          assert.deepEqual(pastLedger.rows.map(row=>row.id),ids.slice((pages-1)*pageSize));
          const pastMonitor=await caller.monitor({page:pages,ipPage:pages,pageSize,ipPageSize:pageSize});
          assert.deepEqual(pastMonitor.events,[]); assert.deepEqual(pastMonitor.ipEvents,[]);
          assert.equal(pastMonitor.page,pages); assert.equal(pastMonitor.ipPage,pages);
        }
        for (const pageSize of [1001,0]) {
          for (const request of [
            ()=>caller.sources({...dates,pageSize}), ()=>caller.financeLedger({...dates,pageSize}),
            ()=>caller.monitor({pageSize}), ()=>caller.monitor({ipPageSize:pageSize}),
          ]) await assert.rejects(request(),error=>error.code==='BAD_REQUEST');
        }
        // Repeat within the TTL in both orders, changing only one size at a time.
        for (const sizes of [[[20,20],[50,20],[50,50]],[[50,50],[50,20],[20,20]]]) {
          for (const [pageSize,ipPageSize] of sizes) {
            const report=await caller.monitor({page:1,ipPage:1,pageSize,ipPageSize});
            assert.deepEqual(report.events.map(row=>row.id),ids.slice(pageSize,2*pageSize));
            assert.deepEqual(report.ipEvents.map(row=>row.id),ids.slice(ipPageSize,2*ipPageSize));
          }
        }
        for (const pageSize of [20,50,50,20]) {
          assert.deepEqual((await caller.sources({...dates,page:1,pageSize})).ips.map(row=>row.ip),sourceIds.slice(pageSize,2*pageSize));
          assert.deepEqual((await caller.financeLedger({...dates,page:1,pageSize})).rows.map(row=>row.id),ids.slice(pageSize,2*pageSize));
        }
        assert.deepEqual((await caller.sources({...dates,page:5,pageSize:50,search:'missing'})).ips,[]);
        const emptyLedger=await caller.financeLedger({...dates,page:5,pageSize:50,userId:999});
        assert.equal(emptyLedger.total,0); assert.equal(emptyLedger.page,0); assert.deepEqual(emptyLedger.rows,[]);
        await rt.executeRaw('DELETE FROM operations_alert_events');
        await rt.executeRaw('DELETE FROM host_ip_switch_attempts');
        const emptyMonitor=await caller.monitor({page:500,ipPage:500,pageSize:50,ipPageSize:50});
        assert.equal(emptyMonitor.total,0); assert.equal(emptyMonitor.ipTotal,0);
        assert.deepEqual(emptyMonitor.events,[]); assert.deepEqual(emptyMonitor.ipEvents,[]);
      } finally {await rt.closeDatabase();}
    `], {cwd:process.cwd(),encoding:"utf8",timeout:60000,windowsHide:true,
      env:{...process.env,DATABASE_TYPE:"sqlite",JWT_SECRET:"operations-pagination-test-secret-only",FORWARDX_TEST_DB:path.join(directory,"test.db"),FORWARDX_LOG_DIR:path.join(directory,"logs")}});
    assert.equal(result.status,0,result.stdout+result.stderr);
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
