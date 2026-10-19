// Execute in the task's isolated Linux container, using exported real heartbeats.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

const [input,binary,output]=process.argv.slice(2);
assert.ok(input&&binary&&output,'provide heartbeat directory, Linux FXP and output path');
assert.ok(fs.existsSync('/.dockerenv'),'run only inside the isolated test container');
const digest=value=>createHash('sha256').update(value).digest('hex');
const files=['initial-1.json','initial-2.json','updated-1.json','updated-2.json'];
const rawFiles=files.map(file=>fs.readFileSync(path.join(input,file)));
const [initialA,initialB,updatedA,updatedB]=rawFiles.map(raw=>JSON.parse(raw));
const initial=[initialA,initialB],updated=[updatedA,updatedB];
for(let i=0;i<2;i++) {
  assert.equal(initial[i].role,'sni-splitter');
  assert.equal(initial[i].sniRoutes.length,3);
  assert.equal(updated[i].sniRoutes.length,3);
  assert.ok(updated[i].sniRouteVersion>initial[i].sniRouteVersion);
}
const target=route=>route.targetIp+':'+route.targetPort;
const find=(config,domain)=>config.sniRoutes.find(route=>route.sni===domain);
const changed=initialA.sniRoutes.filter(route=>target(route)!==target(find(updatedA,route.sni))).map(route=>route.sni);
assert.equal(changed.length,1,'the real saved update changes exactly one domain destination');
const unchanged=initialA.sniRoutes.map(route=>route.sni).filter(domain=>!changed.includes(domain));
for(const domain of unchanged)assert.equal(target(find(initialB,domain)),target(find(updatedB,domain)));
const work=fs.mkdtempSync(path.join(os.tmpdir(),'forwardx-port-sni-network-'));
const generated=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(work,'key.pem'),'-out',path.join(work,'cert.pem'),'-subj','/CN=task-sni-backend','-days','1'],{encoding:'utf8',timeout:15_000});
assert.equal(generated.status,0,generated.stderr);
const credentials={key:fs.readFileSync(path.join(work,'key.pem')),cert:fs.readFileSync(path.join(work,'cert.pem'))};
const servers=[],processes=[],sockets=new Set(),held=[];
const checks=[],probes=[];
let acceptedBackends=0;
const track=socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>{});return socket;};
const listen=(server,port,host)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
const firstHello=raw=>{
  assert.ok(raw.length>=5,'TLS record header arrived');
  const length=raw.readUInt16BE(3)+5;
  assert.ok(raw.length>=length,'complete original TLS record arrived');
  assert.equal(raw[0],22,'TLS handshake record');
  assert.equal(raw[5],1,'TLS ClientHello');
  return raw.subarray(0,length);
};
const result={heartbeatFiles:Object.fromEntries(files.map((file,i)=>[file,digest(rawFiles[i])])),binarySha256:digest(fs.readFileSync(binary)),changedDomain:changed[0],unchangedDomains:unchanged,checks,probes};
try {
  const targets=new Map([...initial,...updated].flatMap(config=>config.sniRoutes).map(route=>[target(route),route]));
  for(const address of new Set([...targets.values()].map(route=>route.targetIp))) {
    assert.match(address,/^203\.0\.113\./,'use only the saved documentation-range test targets');
    const added=spawnSync('ip',['addr','add',address+'/32','dev','lo'],{encoding:'utf8'});
    assert.equal(added.status,0,added.stderr);
  }
  for(const [destination,route] of targets) {
    const rawByPort=new Map();
    const tlsServer=tls.createServer(credentials,socket=>{
      track(socket);
      const raw=rawByPort.get(socket.remotePort);
      assert.ok(raw,'raw destination capture belongs to this TLS connection');
      let text='';
      socket.on('data',chunk=>{
        text+=chunk.toString();
        for(let end;(end=text.indexOf('\n'))>=0;) {
          const token=text.slice(0,end);text=text.slice(end+1);
          socket.write(JSON.stringify({token,destination,domain:socket.servername,helloSha256:digest(firstHello(raw.bytes))})+'\n');
        }
      });
    });
    await listen(tlsServer,0,'127.0.0.1');servers.push(tlsServer);
    const front=net.createServer(socket=>{
      acceptedBackends++;track(socket);
      const raw={bytes:Buffer.alloc(0)};
      socket.on('data',chunk=>{raw.bytes=Buffer.concat([raw.bytes,chunk]);});
      const upstream=track(net.connect(tlsServer.address().port,'127.0.0.1'));
      upstream.once('connect',()=>rawByPort.set(upstream.localPort,raw));
      upstream.once('close',()=>rawByPort.delete(upstream.localPort));
      socket.once('error',()=>upstream.destroy());upstream.once('error',()=>socket.destroy());
      socket.pipe(upstream).pipe(socket);
    });
    await listen(front,route.targetPort,route.targetIp);servers.push(front);
  }
  const entries=[];
  for(let i=0;i<2;i++) {
    const listenHost=i===0?'127.0.0.1':'::1',configPath=path.join(work,'entry-'+(i+1)+'.json'),control=path.join(work,'entry-'+(i+1)+'.sock');
    // The only test-environment additions are listener binding and socket path.
    fs.writeFileSync(configPath,JSON.stringify({...initial[i],listenHost,controlSocketPath:control}));
    const child=spawn(binary,['-config',configPath],{stdio:['ignore','ignore','pipe']});processes.push(child);
    let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
    for(let attempt=0;!fs.existsSync(control)&&attempt<200;attempt++)await new Promise(resolve=>setTimeout(resolve,20));
    assert.ok(fs.existsSync(control),stderr);
    const captureByPort=new Map();
    const observer=net.createServer(socket=>{
      track(socket);const raw={bytes:Buffer.alloc(0)};captureByPort.set(socket.remotePort,raw);
      socket.on('data',chunk=>{raw.bytes=Buffer.concat([raw.bytes,chunk]);});
      const upstream=track(net.connect(initial[i].listenPort,listenHost));
      socket.once('error',()=>upstream.destroy());upstream.once('error',()=>socket.destroy());
      socket.pipe(upstream).pipe(socket);
    });
    await listen(observer,0,'127.0.0.1');servers.push(observer);
    const entry={id:i+1,listenHost,configPath,control,child,captureByPort,observer};entries.push(entry);
  }
  assert.notEqual(entries[0].child.pid,entries[1].child.pid);
  result.processIds=entries.map(entry=>entry.child.pid);
  const open=async(entry,domain)=>{
    const raw=track(net.connect(entry.observer.address().port,'127.0.0.1'));
    const socket=track(tls.connect({socket:raw,servername:domain,rejectUnauthorized:false}));
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{socket.destroy();reject(new Error('TLS handshake timed out'));},3000);
      const ready=()=>{clearTimeout(timer);socket.removeListener('error',failed);resolve();};
      const failed=error=>{clearTimeout(timer);socket.removeListener('secureConnect',ready);reject(error);};
      socket.once('secureConnect',ready);socket.once('error',failed);
    });
    return {socket,raw,entry,domain};
  };
  const exchange=async(connection,route,stage)=>{
    const {socket,raw,entry,domain}=connection,token=randomUUID();
    const reply=await new Promise((resolve,reject)=>{
      let text='';
      const clean=()=>{clearTimeout(timer);socket.removeListener('data',data);socket.removeListener('error',failed);socket.removeListener('close',closed);};
      const failed=error=>{clean();reject(error);};const closed=()=>failed(new Error('held TLS connection closed'));
      const data=chunk=>{text+=chunk.toString();if(!text.includes('\n'))return;clean();resolve(JSON.parse(text.slice(0,text.indexOf('\n'))));};
      const timer=setTimeout(()=>failed(new Error('TLS echo timed out')),3000);
      socket.on('data',data);socket.once('error',failed);socket.once('close',closed);socket.write(token+'\n');
    });
    assert.equal(reply.token,token);assert.equal(reply.domain,domain);assert.equal(reply.destination,target(route));
    const hello=firstHello(entry.captureByPort.get(raw.localPort).bytes);
    assert.equal(reply.helloSha256,digest(hello),'destination sees the exact original ClientHello bytes');
    probes.push({entry:entry.id,domain,destination:reply.destination,stage,helloSha256:reply.helloSha256,tls:socket.getProtocol()});
  };
  const probe=async(entry,config,stage)=>{
    for(const route of config.sniRoutes) {
      const connection=await open(entry,route.sni);
      try{await exchange(connection,route,stage);}finally{connection.socket.destroy();}
    }
  };
  for(let i=0;i<2;i++)await probe(entries[i],initial[i],'initial');
  checks.push('both_entries_each_route_to_three_distinct_saved_destinations','exact_original_clienthello_reaches_destination');
  for(const entry of entries) {
    const before=acceptedBackends;
    await assert.rejects(open(entry,'unknown.example.test'));
    await assert.rejects(open(entry,undefined));
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(acceptedBackends,before,'unknown or absent SNI never reaches a backend');
  }
  checks.push('unknown_and_missing_sni_rejected_without_backend_connection');
  for(let i=0;i<2;i++)for(const domain of unchanged) {
    const connection=await open(entries[i],domain);held.push(connection);
    await exchange(connection,find(initial[i],domain),'held-before-update');
  }
  const update=async(entry,next)=>{
    const response=await new Promise((resolve,reject)=>{
      const socket=track(net.connect(entry.control));let text='';
      const timer=setTimeout(()=>{socket.destroy();reject(new Error('control update timed out'));},3000);
      socket.once('error',error=>{clearTimeout(timer);reject(error);});
      socket.once('connect',()=>socket.write(JSON.stringify({version:next.sniRouteVersion,sniRoutes:next.sniRoutes})+'\n'));
      socket.on('data',chunk=>{text+=chunk.toString();if(!text.includes('\n'))return;clearTimeout(timer);socket.destroy();resolve(JSON.parse(text.trim()));});
    });
    assert.equal(response.ok,true,JSON.stringify(response));
    fs.writeFileSync(entry.configPath,JSON.stringify({...next,listenHost:entry.listenHost,controlSocketPath:entry.control}));
    assert.equal(entry.child.exitCode,null,'route updates keep the same process');
  };
  await update(entries[0],updatedA);
  await probe(entries[0],updatedA,'only-A-updated');await probe(entries[1],initialB,'B-still-initial');
  for(const connection of held)await exchange(connection,find(initial[connection.entry.id-1],connection.domain),'held-after-A-update');
  checks.push('updating_A_does_not_update_B','other_domains_long_connections_survive_A_update');
  await update(entries[1],updatedB);await probe(entries[1],updatedB,'both-updated');
  for(const connection of held)await exchange(connection,find(updated[connection.entry.id-1],connection.domain),'held-after-B-update');
  checks.push('other_domains_long_connections_survive_B_update','route_updates_keep_both_process_ids');
  const stopped=entries[0].child;await new Promise(resolve=>{stopped.once('exit',resolve);stopped.kill('SIGTERM');});
  await assert.rejects(open(entries[0],changed[0]));
  assert.equal(entries[1].child.exitCode,null);
  await probe(entries[1],updatedB,'A-stopped-B-still-serving');
  for(const connection of held.filter(connection=>connection.entry.id===2))await exchange(connection,find(updatedB,connection.domain),'B-held-after-A-stop');
  checks.push('stopping_A_keeps_B_new_and_existing_connections_alive');
  result.result='passed';result.probeCount=probes.length;fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
} finally {
  for(const connection of held)connection.socket.destroy();
  await Promise.all(processes.map(child=>new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();child.once('exit',resolve);child.kill('SIGTERM');})));
  for(const socket of sockets)socket.destroy();
  await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));
  fs.rmSync(work,{recursive:true,force:true});
}
