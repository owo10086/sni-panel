import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
process.env.DATABASE_TYPE='sqlite'; const secret='/private/tmp/forwardx-282-ticket08/jwt.txt'; if(!fs.existsSync(secret))fs.writeFileSync(secret,crypto.randomBytes(32).toString('hex'),{mode:0o600}); process.env.JWT_SECRET=fs.readFileSync(secret,'utf8');
const root=process.cwd(); const require=createRequire(path.join(root,'package.json'));
const express=require('express'); const cookieParser=require('cookie-parser');
const {createExpressMiddleware}=require('@trpc/server/adapters/express');
const {createServer}=await import(pathToFileURL(require.resolve('vite')).href);
const source=file=>import(pathToFileURL(path.join(root,file)).href);
const runtime=await source('server/dbRuntime.ts'); const {ensureDatabaseSchema}=await source('server/dbSchema.ts');
const db=await source('server/db.ts'); const {appRouter}=await source('server/routers.ts');
const {createContext}=await source('server/_core/context.ts'); const {issueLoginSession}=await source('server/routers/auth.ts');
const {agentRouter}=await source('server/agentRoutes.ts'); const {encryptPayload,decryptPayload}=await source('server/agentCrypto.ts');
const {registerDatabaseHealthRoutes}=await source('server/databaseHealthRoutes.ts'); const {registerLocaleHintRoute}=await source('server/localeHint.ts');
const dir='/private/tmp/forwardx-282-ticket08';
await runtime.connectDatabase({type:'sqlite',sqlite:{path:path.join(dir,'panel.db')}}); await ensureDatabaseSchema();
const insert=(table,row)=>runtime.insertAndGetId(table,row);
if(!(await db.getUserById(1))){
 await insert('users',{id:1,username:'monitor-admin',password:'unused',name:'监控验收管理员',role:'admin'});
 for(const id of [1,2]){
  await insert('hosts',{id,name:id===1?'监控主机 A':'监控主机 B',ip:'192.0.2.'+id,userId:1,isOnline:true,lastHeartbeat:Math.floor(Date.now()/1000),agentToken:'isolated-monitor-token-'+id,agentVersion:'3.3.0'});
  await db.insertHostMetric({hostId:id,cpuUsage:id===1?23:57,memoryUsage:40,diskUsage:12,uptime:600,networkIn:1000,networkOut:2000,recordedAt:new Date()});
 }
 await db.setSettings({publicHostMonitorEnabled:'true',publicHostMonitorPath:'dev',publicHostMonitorTitle:'08监控验收'});
}
const app=express(); app.use(express.json({limit:'10mb'}));app.use(cookieParser());app.use(agentRouter);
registerDatabaseHealthRoutes(app);registerLocaleHintRoute(app);
app.get('/__ticket08/login',async(req,res,next)=>{try {await issueLoginSession({req,res},await db.getUserById(1),'browser');res.redirect('/dev');}catch(e){next(e);}});
app.use('/api/trpc',async(req,res,next)=>{
 const control=JSON.parse(fs.readFileSync(path.join(dir,'control.json'),'utf8'));
 const detail=req.path.includes('publicMonitorHostDetail'),monitor=req.path.includes('hosts.publicMonitor');
 if(!monitor)return next();
 const mode=detail?control.detail:control.summary;
 fs.appendFileSync(path.join(dir,'requests.jsonl'),JSON.stringify({at:new Date().toISOString(),path:req.path,query:req.query,mode})+'\n');
 if(mode==='hang'){res.on('close',()=>fs.appendFileSync(path.join(dir,'requests.jsonl'),JSON.stringify({closed:true,path:req.path,at:new Date().toISOString()})+'\n'));return;}
 if(mode==='error'||mode==='missing')return res.status(mode==='missing'?404:503).json({error:{json:{message:mode==='missing'?'主机不存在':'验收：服务器暂时不可用',code:mode==='missing'?-32004:-32603,data:{code:mode==='missing'?'NOT_FOUND':'SERVICE_UNAVAILABLE',httpStatus:mode==='missing'?404:503,path:req.path.slice(1)}}}});
 if(mode==='delay')await new Promise(resolve=>setTimeout(resolve,4000));
 next();
});
app.use('/api/trpc',createExpressMiddleware({router:appRouter,createContext}));
const vite=await createServer({configFile:path.join(root,'vite.config.ts'),root,server:{middlewareMode:true},appType:'spa'});app.use(vite.middlewares);
const server=http.createServer(app);await new Promise(resolve=>server.listen(18828,'127.0.0.1',resolve));
console.log('Ticket08 real routes ready http://127.0.0.1:18828/dev');
const timer=setInterval(()=>void runtime.executeRaw('UPDATE hosts SET "isOnline"=1,"lastHeartbeat"=?',[Math.floor(Date.now()/1000)]),10000);
let closing=false;const stop=async()=>{if(closing)return;closing=true;clearInterval(timer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await vite.close();await runtime.closeDatabase();process.exit(0);};process.on('SIGINT',stop);process.on('SIGTERM',stop);
