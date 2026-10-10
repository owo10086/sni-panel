import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(),dir='/private/tmp/forwardx-282-ticket11';
process.env.DATABASE_TYPE='sqlite';process.env.DATABASE_CONFIG_PATH=path.join(dir,'database.json');
process.env.FORWARDX_SEAMLESS_MIGRATION_STATE_PATH=path.join(dir,'migration.json');
process.env.FORWARDX_LOG_DIR=path.join(dir,'logs');process.env.FORWARDX_DEV_PANEL='0';
process.env.TELEGRAM_BOT_TOKEN='';process.env.DISCORD_BOT_TOKEN='';
const secret=path.join(dir,'jwt.txt');if(!fs.existsSync(secret))fs.writeFileSync(secret,crypto.randomBytes(32).toString('hex'),{mode:0o600});process.env.JWT_SECRET=fs.readFileSync(secret,'utf8');
const require=createRequire(path.join(root,'package.json'));const express=require('express'),cookieParser=require('cookie-parser');
const {createExpressMiddleware}=require('@trpc/server/adapters/express');
const {createServer}=await import(pathToFileURL(require.resolve('vite')).href);
const source=file=>import(pathToFileURL(path.join(root,file)).href);
const runtime=await source('server/dbRuntime.ts'),db=await source('server/db.ts');
const {ensureDatabaseSchema}=await source('server/dbSchema.ts');
const users=await source('server/repositories/userRepository.ts');
const {hashPassword}=await source('server/password.ts');
const {appRouter}=await source('server/routers.ts'),{createContext}=await source('server/_core/context.ts');
const {issueLoginSession}=await source('server/routers/auth.ts');
const {registerDatabaseHealthRoutes}=await source('server/databaseHealthRoutes.ts');
const {registerLocaleHintRoute}=await source('server/localeHint.ts');
const {seamlessMigrationRouter}=await source('server/seamlessPanelMigration.ts');
const tg=await source('server/telegramBot.ts'),dc=await source('server/discordBot.ts');
const {databaseHealth}=await source('server/databaseHealthState.ts');
await runtime.connectDatabase({type:'sqlite',sqlite:{path:path.join(dir,'panel.db')}});
const tables=await runtime.queryRaw("SELECT name FROM sqlite_master WHERE type='table' AND name='users'");
if(!tables.length){
 await ensureDatabaseSchema();
 for(const [id,role] of [[1,'admin'],[2,'user'],[3,'admin']]){
  assert.equal(await users.createUser({username:`user${id}@example.test`,password:'ticket11-test-password',name:`通知验收用户${id} unchanged`,role}),id);
  await runtime.executeRaw('UPDATE users SET "accountEnabled"=?,"telegramId"=?,"telegramAnnouncementSubscribed"=1 WHERE id=?',[id===3?0:1,String(1000+id),id]);
 }
 const [{sql:currentSql}]=await runtime.queryRaw("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'");
 const oldSql=currentSql.replace('CREATE TABLE "users"','CREATE TABLE "users_legacy"').replace(/, "discord[A-Za-z]+" [^,]+/g,'').replace(/, UNIQUE \("discord[A-Za-z]+"\)/g,'');
 const columns=(await runtime.queryRaw('PRAGMA table_info(users)')).filter(r=>!r.name.startsWith('discord')).map(r=>'"'+r.name+'"').join(',');
 await runtime.executeRaw('PRAGMA foreign_keys=OFF');await runtime.executeRaw(oldSql);await runtime.executeRaw('INSERT INTO users_legacy ('+columns+') SELECT '+columns+' FROM users');await runtime.executeRaw('DROP TABLE users');await runtime.executeRaw('ALTER TABLE users_legacy RENAME TO users');await runtime.executeRaw('PRAGMA foreign_keys=ON');
 assert.ok(!(await runtime.queryRaw('PRAGMA table_info(users)')).some(r=>r.name==='discordId'));
 await ensureDatabaseSchema();await ensureDatabaseSchema();
 assert.equal((await users.getUserById(1)).telegramId,'1001');assert.equal((await users.getUserById(3)).accountEnabled,false);assert.ok(await users.verifyUserPassword(1,'ticket11-test-password'));
 fs.writeFileSync(path.join(dir,'upgrade-evidence.json'),JSON.stringify({discordColumnsAbsentBefore:true,upgradeRuns:2,oldTelegramBinding:'1001',oldSubscription:true,disabledPreserved:true,passwordWorks:true},null,2)+'\n');
 await db.setSettings({siteTitle:'sni-panel 11验收',telegramBotEnabled:'true',telegramBotToken:'ticket11-tg-test-token',telegramBotUsername:'ticket11_tg_bot',discordBotEnabled:'true',discordBotToken:'ticket11-dc-test-token',discordBotUsername:'ticket11_dc_bot',discordBotId:'999999999999999999',panelPublicUrl:'http://127.0.0.1:18831',telegramHostStatusNotify:'true',discordHostStatusNotify:'true'});
}else await ensureDatabaseSchema();
let platformFailure=false,event=100,pollWaiter=null;const pending=[];
const platform=[];const savePlatform=()=>fs.writeFileSync(path.join(dir,'platform.json'),JSON.stringify(platform,null,2)+'\n');
const sockets=[];
class FakeGateway extends EventTarget {static OPEN=1;readyState=1;constructor(url){super();this.url=url;sockets.push(this);setImmediate(()=>{this.dispatch({op:10,d:{heartbeat_interval:10000}});this.dispatch({op:0,t:'READY',s:1,d:{session_id:'ticket11-session'}});});}dispatch(data){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}));}send(_data){}close(){this.readyState=3;this.dispatchEvent(Object.assign(new Event('close'),{code:1000}));}}
globalThis.WebSocket=FakeGateway;
globalThis.fetch=async(url,options)=>{
 const parsed=new URL(String(url));const body=options?.body?JSON.parse(String(options.body)):null;
 if(parsed.hostname==='api.telegram.org'){
  const method=parsed.pathname.split('/').at(-1);
  if(method==='getUpdates'){
   if(!pending.length)await new Promise((resolve,reject)=>{pollWaiter=resolve;options.signal?.addEventListener('abort',()=>{if(pollWaiter===resolve)pollWaiter=null;reject(Object.assign(new Error('cancelled'),{name:'AbortError'}));},{once:true});});
   return Response.json({ok:true,result:pending.splice(0,body?.limit||100)});
  }
  platform.push({provider:'telegram',method,body});savePlatform();
  if(platformFailure&&method==='sendMessage')return Response.json({ok:false,description:'Test platform temporarily unavailable'},{status:503});
  return Response.json({ok:true,result:method==='getMe'?{id:999,username:'ticket11_tg_bot'}:{message_id:++event}});
 }
 if(parsed.hostname==='discord.com'){
  const method=parsed.pathname.replace('/api/v10','');platform.push({provider:'discord',method,body});savePlatform();
  if(platformFailure&&method.endsWith('/messages'))return Response.json({message:'Test platform temporarily unavailable'},{status:503});
  if(method==='/users/@me')return Response.json({id:'999999999999999999',bot:true,username:'ticket11_dc_bot'});
  return Response.json({id:method==='/users/@me/channels'?'234567890123456789':String(345678901234567000n+BigInt(++event))});
 }
 throw new Error('Fixture blocks external request');
};
await tg.startTelegramBot();await dc.startDiscordBot();
const app=express();app.use(express.json({limit:'10mb'}));app.use(cookieParser());registerDatabaseHealthRoutes(app);registerLocaleHintRoute(app);app.use(seamlessMigrationRouter);
app.get('/__ticket11/as-admin',async(req,res,next)=>{try{await issueLoginSession({req,res},await users.getUserById(1),'browser');res.redirect('/settings');}catch(e){next(e);}});
app.get('/__ticket11/as-user',async(req,res,next)=>{try{await issueLoginSession({req,res},await users.getUserById(2),'browser');res.redirect('/profile');}catch(e){next(e);}});
app.post('/__ticket11/message',async(req,res,next)=>{try{const {provider,text,actor='123456789012345678',type='private'}=req.body;if(provider==='discord')await dc.handleDiscordGatewayDispatch('MESSAGE_CREATE',{id:String(456789012345670000n+BigInt(++event)),channel_id:'234567890123456789',...(type!=='private'?{guild_id:'public-guild'}:{}),author:{id:actor,username:'ticket11_test'},content:text});else{pending.push({update_id:++event,message:{message_id:event,chat:{id:Number(actor),type},from:{id:Number(actor),username:'ticket11_test'},text}});pollWaiter?.();pollWaiter=null;}res.json({accepted:true});}catch(e){next(e);}});
app.post('/__ticket11/platform',async(req,res)=>{platformFailure=!!req.body.fail;res.json({fail:platformFailure});});
app.get('/__ticket11/state',async(req,res)=>res.json({channel:(await db.getAllSettings()).notificationChannel||'telegram',users:await Promise.all([1,2,3].map(async id=>{const u=await users.getUserById(id);return {id,telegramId:u.telegramId,discordId:u.discordId,telegramBindCode:u.telegramBindCode,discordBindCode:u.discordBindCode,telegramLoginCode:u.telegramLoginCode,discordLoginCode:u.discordLoginCode,telegramAnnouncementSubscribed:u.telegramAnnouncementSubscribed,discordAnnouncementSubscribed:u.discordAnnouncementSubscribed};})),platformCount:platform.length,sockets:sockets.length,connection:dc.discordConnectionStatus()}));
app.use('/api/trpc',(req,res,next)=>{fs.appendFileSync(path.join(dir,'requests.jsonl'),JSON.stringify({at:new Date().toISOString(),path:req.path})+'\n');next();});
app.use('/api/trpc',createExpressMiddleware({router:appRouter,createContext}));
const vite=await createServer({configFile:path.join(root,'vite.config.ts'),root,server:{middlewareMode:true,hmr:{port:18833}},appType:'spa'});app.use(vite.middlewares);
const server=app.listen(18831,'127.0.0.1',()=>console.log('Ticket11 ready http://127.0.0.1:18831/__ticket11/as-admin'));
let closing=false;const stop=async()=>{if(closing)return;closing=true;tg.stopTelegramBot();dc.stopDiscordBot();pollWaiter?.();server.closeAllConnections();await new Promise(r=>server.close(r));await vite.close();await runtime.closeDatabase();process.exit(0);};process.on('SIGINT',stop);process.on('SIGTERM',stop);
