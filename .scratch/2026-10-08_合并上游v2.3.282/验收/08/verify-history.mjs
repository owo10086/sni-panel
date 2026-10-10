import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import{createRequire}from'node:module';import{pathToFileURL}from'node:url';
const require=createRequire(path.join(process.cwd(),'package.json'));const{createTRPCProxyClient,httpLink}=require('@trpc/client');const superjson=require('superjson').default;
process.env.DATABASE_TYPE='sqlite';const source=f=>import(pathToFileURL(path.join(process.cwd(),f)).href);const r=await source('server/dbRuntime.ts');await r.connectDatabase({type:'sqlite',sqlite:{path:'/private/tmp/forwardx-282-ticket08/panel.db'}});
const now=Math.floor(Date.now()/1000),start=now-23*3600-55*60,end=now-60;const perService=2000,serviceCount=32;
try{
 await r.withDatabaseTransaction(async()=>{
  await r.executeRaw('DELETE FROM host_probe_service_stats');await r.executeRaw('DELETE FROM host_probe_services');
  for(let service=1;service<=serviceCount;service++)await r.insertAndGetId('host_probe_services',{id:service,name:'History service '+service,method:'tcping',targetIp:'192.0.2.100',targetPort:443,hostScope:'selected',hostIds:'[1]',userId:1,isEnabled:true});
  const values=[];
  for(let index=0;index<perService;index++)for(let service=1;service<=serviceCount;service++)values.push([service,1,service*2,index%10===0?1:0,3,index%10===0?0:2,Math.round(start+(end-start)*index/(perService-1))]);
  for(let offset=0;offset<values.length;offset+=500){const batch=values.slice(offset,offset+500);await r.executeRaw('INSERT INTO host_probe_service_stats (serviceId,hostId,latencyMs,isTimeout,probeCount,probeSuccesses,recordedAt) VALUES '+batch.map(()=>'(?,?,?,?,?,?,?)').join(','),batch.flat());}
 });
 const client=createTRPCProxyClient({links:[httpLink({url:'http://127.0.0.1:18828/api/trpc',transformer:superjson})]});
 const detail=await client.hosts.publicMonitorHostDetail.query({path:'dev',hostId:1,hours:24});
 assert.equal(detail.services.length,32);assert.ok(detail.serviceSeries.length<=20000);
 let count=0,success=0,from=Infinity,to=0;const services=new Set();
 for(const point of detail.serviceSeries){count+=point.probeCount;success+=point.probeSuccesses;const time=new Date(point.recordedAt).getTime()/1000;from=Math.min(from,time);to=Math.max(to,time);services.add(point.serviceId);}
 assert.equal(count,192000);assert.equal(success,115200);assert.equal(services.size,32);assert.ok(from<=start && from>=start-600);assert.ok(to>=end-600 && to<=end);
 const evidence={syntheticHistory:true,realDatabaseAndPublicHTTPQuery:true,serviceCount,rawRows:64000,expectedProbeCount:192000,probeCount:count,expectedProbeSuccesses:115200,probeSuccesses:success,responsePoints:detail.serviceSeries.length,maxPoints:20000,requestedHours:24,firstRawAt:new Date(start*1000).toISOString(),lastRawAt:new Date(end*1000).toISOString(),firstAggregateAt:new Date(from*1000).toISOString(),lastAggregateAt:new Date(to*1000).toISOString(),retainsWholeTimeWindow:true};
 fs.writeFileSync('/private/tmp/forwardx-282-ticket08/history-evidence.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{await r.closeDatabase();}
