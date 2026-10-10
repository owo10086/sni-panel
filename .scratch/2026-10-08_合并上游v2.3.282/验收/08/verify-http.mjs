import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createRequire}from'node:module';import {pathToFileURL}from'node:url';
const require=createRequire(path.join(process.cwd(),'package.json'));const {createTRPCProxyClient,httpLink}=require('@trpc/client');const superjson=require('superjson').default;
const source=f=>import(pathToFileURL(path.join(process.cwd(),f)).href);const {encryptPayload,decryptPayload}=await source('server/agentCrypto.ts');const dir='/private/tmp/forwardx-282-ticket08';const token='isolated-monitor-token-1';const base='http://127.0.0.1:18828';
const controller=new AbortController();const stream=await fetch(base+'/api/agent/events',{headers:{authorization:'Bearer '+token,'x-agent-version':'3.3.0'},signal:controller.signal});assert.equal(stream.status,200);const reader=stream.body.getReader();let text='';const events=[];
const reading=(async()=>{try{while(true){const chunk=await reader.read();if(chunk.done)break;text+=new TextDecoder().decode(chunk.value);let end;while((end=text.indexOf('\n\n'))>=0){const frame=text.slice(0,end);text=text.slice(end+2);const name=frame.match(/event: (.*)/)?.[1];const data=frame.match(/data: (.*)/)?.[1];if(name&&data){const decoded=decryptPayload(JSON.parse(data),token);events.push({name:decoded.type,data:decoded.data});}}}}catch(e){if(!controller.signal.aborted)throw e;}})();
try{
 fs.writeFileSync(dir+'/control.json',JSON.stringify({summary:'error',detail:'ok'}));
 await new Promise(resolve=>setTimeout(resolve,16000));
 fs.writeFileSync(dir+'/control.json',JSON.stringify({summary:'ok',detail:'ok'}));
 const client=createTRPCProxyClient({links:[httpLink({url:base+'/api/trpc',transformer:superjson})]});
 const summary=await client.hosts.publicMonitor.query({path:'dev'});assert.equal(summary.hosts.length,2);
 await new Promise(resolve=>setTimeout(resolve,100));
 const refresh=events.find(event=>event.name==='agent-refresh');assert.ok(refresh,'public monitor sends a real refresh event');
 const report={busy:true,agentVersion:'3.3.0',cpuUsage:68,memoryUsage:45,diskUsage:13,uptime:900,networkIn:100000,networkOut:150000};
 const response=await fetch(base+'/api/agent/heartbeat',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','x-agent-encrypted':'1'},body:JSON.stringify(encryptPayload(report,token))});assert.equal(response.status,200);const result=decryptPayload(await response.json(),token);assert.equal(result.trafficReportInterval,10);assert.equal(result.nextInterval,3);
 const updated=await client.hosts.publicMonitor.query({path:'dev'});const detail=await client.hosts.publicMonitorHostDetail.query({path:'dev',hostId:1,hours:24});assert.equal(updated.metrics.find(m=>m.hostId===1).cpuUsage,68);assert.equal(detail.metric.cpuUsage,68);assert.equal(updated.metrics.find(m=>m.hostId===2).cpuUsage,57);
 await assert.rejects(client.hosts.publicMonitorHostDetail.query({path:'dev',hostId:999,hours:24}),error=>error.data?.code==='NOT_FOUND');
 const evidence={syntheticAgentPayload:true,realEncryptedHeartbeatRoute:true,realSSERefreshEvent:refresh,heartbeatResponse:result,refreshedAt:updated.refreshedAt,metrics:updated.metrics,detailMetric:detail.metric,missingHostRejected:true};fs.writeFileSync(dir+'/http-evidence.json',JSON.stringify(evidence,null,2));console.log('Real SSE refresh, encrypted report, separate-host state and missing host passed');
}finally{controller.abort();await reading;}
