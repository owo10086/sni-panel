// Real connection acceptance for group handoff. Current Agent code applies the
// panel's real desired actions to nftables inside network-isolated containers.
// No host firewall, production target or DNS provider is touched.
// node --import tsx scripts/verify-forward-group-handover.mjs [remove|disable|fallback]
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { mock } from "node:test";
import express from "express";
import { Lab, buildAgentTestBinary, ECHO_PY, PROBE_PY } from "./verify-nft-docker-coexistence.mjs";

const OLD_ADDRESS = "10.201.1.1";
const NEW_ADDRESS = "10.201.1.3";
const PORT = 35211;
const FORWARDED = "OK forwarded:10.201.2.2:10042:ping";
const version = fs.readFileSync(new URL("../agent/main.go", import.meta.url), "utf8").match(/^var Version = "([^"]+)"/m)[1];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-real-handoff-"));
const requested = process.argv.slice(2);
const scenarios = requested.length ? requested : ["remove", "disable", "fallback"];
assert.ok(scenarios.every(name => ["remove", "disable", "fallback"].includes(name)));
process.env.DATABASE_TYPE = "sqlite";
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.MYSQL_CONFIG_PATH = path.join(directory, "mysql.json");
process.env.SQLITE_PATH = path.join(directory, "unused.db");
process.env.JWT_SECRET ||= "local-isolated-forward-group-runtime-acceptance";
// The scheduler captures Date.now/setTimeout at import, just like production
// startup. Install this clock before loading the panel modules.
mock.timers.enable({apis:["Date","setTimeout"],now:Math.floor(Date.now()/1000)*1000});

const runtime = await import("../server/dbRuntime.ts");
const { ensureDatabaseSchema } = await import("../server/dbSchema.ts");
const { forwardGroupsRouter } = await import("../server/routers/forwardGroups.ts");
const { rulesRouter } = await import("../server/routers/rules.ts");
const { registerAgentHeartbeatRoute } = await import("../server/agentHeartbeatRoute.ts");
const { registerAgentStatusRoutes } = await import("../server/agentStatusRoutes.ts");
const { setSettings } = await import("../server/repositories/settingsRepository.ts");
const context = { req:{headers:{}},res:{clearCookie(){}},user:{id:1,username:"admin",role:"admin",accountEnabled:true},authSession:null,authFailureReason:null };
const groups = forwardGroupsRouter.createCaller(context);
const rules = rulesRouter.createCaller(context);

async function runScenario(name, sequence) {
  const labs = new Map();
  const localState = new Map();
  const lastDesired = new Map();
  const publications = [];
  let editWallStartedAt=null;
  let editWallSavedAt=null;
  let observedReplacementConfiguration=false;
  const tokens = new Map([1,2].map(id => [id,`real-handoff-${sequence}-${id}`]));
  const ids = new Map([1,2].map(id => [id,sequence * 10 + id]));
  const app = express();
  app.use(express.json({limit:"32mb"}));
  app.use((req,_res,next)=>{req.agentToken=String(req.headers.authorization||"").replace(/^Bearer /,"");next();});
  registerAgentHeartbeatRoute(app);
  registerAgentStatusRoutes(app);
  app.post("/ddns",(req,res)=>{publications.push({...req.body,at:Date.now()});res.json({success:true});});
  const server = http.createServer(app);
  let groupId;
  const post = async (id,route,payload) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/agent/${route}`,{
      method:"POST",headers:{authorization:`Bearer ${tokens.get(id)}`,"content-type":"application/json",connection:"close"},body:JSON.stringify(payload),
    });
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  const heartbeat = async id => {
    const reply=await post(id,"heartbeat",{
      agentVersion:version,agentBootId:`real-handoff-${sequence}-${id}`,agentProcessId:1000+id,forceReconcile:true,
      ...(localState.has(id) ? localState.get(id) : {}),
    });
    const actions=(reply.desiredState?.actions || []).filter(action=>Number(action.ruleId)>0);
    if (actions.length) lastDesired.set(id,{...reply.desiredState,actions});
    if (id===2 && name!=="fallback" && editWallSavedAt!==null && !observedReplacementConfiguration
      && (reply.runningRules || []).some(rule=>Number(rule.sourcePort)===PORT)) {
      observedReplacementConfiguration=true;
      console.log(`  ${name}: real wall time save call=${Math.round(editWallSavedAt-editWallStartedAt)}ms, save completion to replacement's next explicit heartbeat=${Math.round(performance.now()-editWallSavedAt)}ms`);
    }
    return reply;
  };
  const converge = async id => {
    const reply = await heartbeat(id);
    const desired = lastDesired.get(id);
    if (!desired) return reply;
    const output = labs.get(id).agent("sync",{state:desired,runningRules:reply.runningRules || []});
    if (process.env.LAB_DEBUG) console.log(JSON.stringify({host:id,running:reply.runningRules,actions:desired.actions.map(({ruleId,op})=>({ruleId,op})),reports:output.reports,local:output.localState}));
    if (output.reports?.length) {
      const result = await post(id,"rule-status-batch",{statuses:output.reports});
      assert.deepEqual((result.rejected || []).filter(report=>report.error!=="rule not found"),[]);
    }
    localState.set(id,{localState:output.localState,localStateSignature:output.localStateSignature});
    await heartbeat(id);
    return reply;
  };
  const current = async () => (await groups.list()).find(group=>Number(group.id)===Number(groupId));
  const expectDns = async value => assert.equal((await current()).lastDdnsValue,value);
  const probe = (id,phase,expected=true) => {
    const result = labs.get(id).probe("client","tcp",id===1?OLD_ADDRESS:NEW_ADDRESS,PORT);
    if (expected) assert.equal(result,FORWARDED,phase);
    else assert.match(result,/^FAIL/,phase);
    console.log(`  ${name}: ${phase}: ${result}`);
  };
  const advance = async milliseconds => {
    // Keep real Agent heartbeats fresh while only panel time is advanced.
    for (let elapsed=0;elapsed<milliseconds;) {
      const step=Math.min(10_000,milliseconds-elapsed);mock.timers.tick(step);elapsed+=step;
      for (const id of [1,2]) await heartbeat(id);
      await groups.runFailover();
    }
  };
  try {
    for (const id of [1,2]) {
      const lab=new Lab(directory,`forwardx-real-handoff-${process.pid}-${sequence}-${id}`);
      labs.set(id,lab);
      lab.start();
      if (id===2) labs.get(id).sh(`ip addr add ${NEW_ADDRESS}/24 dev c1`);
    }
    await runtime.connectDatabase({type:"sqlite",sqlite:{path:path.join(directory,`panel-${sequence}.db`)}});
    await ensureDatabaseSchema();
    await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
    await runtime.insertAndGetId("users",{id:1,username:"admin",password:"x",role:"admin",canAddRules:true,manualCanAddRules:true});
    for (const id of [1,2]) await runtime.insertAndGetId("hosts",{
      id:ids.get(id),name:`real-entry-${id}`,ip:id===1?OLD_ADDRESS:NEW_ADDRESS,ipv4:id===1?OLD_ADDRESS:NEW_ADDRESS,
      userId:1,agentToken:tokens.get(id),agentVersion:version,isOnline:true,lastHeartbeat:Math.floor(Date.now()/1000),portRangeStart:30000,portRangeEnd:40000,
    });
    groupId=(await groups.create({name:`real ${name}`,groupType:"host",groupMode:"failover",forwardType:"nftables",protocol:"tcp",domain:"",
      failoverSeconds:17,recoverSeconds:23,autoFailback:false,members:[1,2].map((id,priority)=>({memberType:"host",hostId:ids.get(id),priority,isEnabled:true})),
    })).id;
    await rules.create({forwardGroupId:groupId,name:"actual native forwarding",sourcePort:PORT,targetIp:"10.201.2.2",targetPort:10042,protocol:"tcp",forwardType:"nftables",isEnabled:true});
    for (let round=0;round<2;round++) for (const id of [1,2]) await converge(id);
    await advance(25_000);
    await setSettings({ddnsEnabled:"true",ddnsProvider:"webhook",ddnsWebhookUrl:`http://127.0.0.1:${server.address().port}/ddns`,ddnsWebhookMethod:"POST",ddnsTtl:"60"});
    await groups.updateFields({id:groupId,domain:`${name}.isolated.example`});
    await groups.runFailover();await expectDns(OLD_ADDRESS);
    probe(1,"new connection before switch");
    if (name==="fallback") {
      // Break the replacement's actual native runtime, then use the Agent's
      // own readiness inventory. It receives heartbeats without applying the
      // requested repair during this accepted five-minute fallback scenario.
      labs.get(2).sh("nft delete table inet forwardx");
      const stopped=labs.get(2).agent("state");
      assert.ok((stopped.localState.rules || []).every(rule=>!rule.ready));
      localState.set(2,{localState:stopped.localState,localStateSignature:stopped.localStateSignature});
      await heartbeat(2);
    }
    const beforeEdit=Date.now();
    editWallStartedAt=performance.now();
    await groups.updateFields({id:groupId,members:name==="disable"
      ? [1,2].map((id,priority)=>({memberType:"host",hostId:ids.get(id),priority,isEnabled:id!==1}))
      : [{memberType:"host",hostId:ids.get(2),priority:0,isEnabled:true}],
    });
    editWallSavedAt=performance.now();
    await groups.runFailover();
    await converge(1);
    probe(1,"old address immediately after administrator edit");
    if (name==="fallback") {
      await expectDns(OLD_ADDRESS);
      await advance(290_000);await converge(1);
      probe(1,"old address before five-minute fallback");
      await advance(Math.max(0,beforeEdit+302_000-Date.now()));await converge(1);
      probe(1,"old address after accepted five-minute fallback",false);
    } else {
      await converge(2);await groups.runFailover();await expectDns(NEW_ADDRESS);
      probe(2,"new published address after real runtime confirmation");
      const switched=publications.find(publication=>publication.values?.includes(NEW_ADDRESS));
      assert.ok(switched,"replacement DDNS publication must be committed");
      await advance(Math.max(0,switched.at+50_000-Date.now()));await converge(1);
      probe(1,"new connection using old address inside TTL");
      await advance(Math.max(0,switched.at+62_000-Date.now()));await converge(1);
      probe(1,"old address after fixed TTL withdrawal",false);
      probe(2,"replacement still forwards after old withdrawal");
    }
    console.log(`PASS real Agent nft handoff ${name}`);
  } finally {
    await runtime.closeDatabase().catch(()=>{});
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    for (const lab of labs.values()) lab.stop();
  }
}

try {
  fs.writeFileSync(path.join(directory,"echo.py"),ECHO_PY);
  fs.writeFileSync(path.join(directory,"probe.py"),PROBE_PY);
  buildAgentTestBinary(directory);
  for (const [index,name] of scenarios.entries()) await runScenario(name,index+1);
} finally { mock.timers.reset();fs.rmSync(directory,{recursive:true,force:true}); }
