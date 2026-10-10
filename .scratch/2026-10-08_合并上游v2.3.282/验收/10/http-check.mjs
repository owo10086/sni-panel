import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(process.cwd()+'/package.json');
const SQLite=require('better-sqlite3');
const dir='/private/tmp/forwardx-282-ticket10',origin='http://127.0.0.1:18830';
const run=Date.now(),newUsername='new10-'+run+'@example.test',missingUsername='missing10-'+run+'@example.test';
const stage=process.argv[2],admin=new Map(),anon=new Map(),evidence={stage,checks:[]};
function capture(jar,res){for(const cookie of res.headers.getSetCookie()){const pair=cookie.split(';',1)[0],at=pair.indexOf('=');const name=pair.slice(0,at),value=decodeURIComponent(pair.slice(at+1));if(value)jar.set(name,value);else jar.delete(name);}}
async function request(path,jar,init={}){const res=await fetch(origin+path,{...init,redirect:'manual',headers:{...init.headers,Origin:origin,Cookie:[...jar].map(([k,v])=>k+'='+encodeURIComponent(v)).join(';')}});capture(jar,res);return res;}
async function rpc(name,jar,input,query=false){const res=await request('/api/trpc/'+name+(query&&input!==undefined?'?input='+encodeURIComponent(JSON.stringify({json:input})):''),jar,query?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({json:input??null})});const body=await res.json();return {status:res.status,data:body.result?.data?.json,error:body.error?.json?.message,code:body.error?.json?.data?.code};}
function ok(name){evidence.checks.push({name,passed:true});console.log('PASS '+name);}
await request('/__ticket10/as-admin',admin);
if(stage==='off'){
 await rpc('system.updateSettings',admin,{email:{enabled:false,verifyRegistration:false,whitelistEnabled:false}});
 assert.equal((await rpc('auth.emailConfig',anon,undefined,true)).data.authCaptchaEnabled,true);assert.equal((await rpc('system.publicInfo',anon,undefined,true)).data.authCaptchaEnabled,true);ok('default enabled on public HTTP');
 assert.match((await rpc('auth.register',anon,{username:newUsername,password:'ticket10-new-password'})).error,/CAPTCHA_REQUIRED/);ok('registration requires verification by default');
 for(let i=0;i<3;i++)await rpc('auth.login',anon,{username:'admin10@example.test',password:'wrong-password'});
 assert.deepEqual((await rpc('auth.needsCaptcha',anon,{username:'admin10@example.test'},true)).data,{enabled:true,required:true});
 assert.match((await rpc('auth.login',anon,{username:'admin10@example.test',password:'ticket10-admin-password'})).error,/CAPTCHA_REQUIRED/);ok('password failures trigger login verification');
 assert.equal((await rpc('system.updateSettings',anon,{authCaptchaEnabled:false})).code,'UNAUTHORIZED');ok('anonymous cannot disable verification');
 assert.equal((await rpc('system.updateSettings',admin,{authCaptchaEnabled:false})).error,undefined);
 assert.equal((await rpc('auth.emailConfig',anon,undefined,true)).data.authCaptchaEnabled,false);assert.equal((await rpc('system.publicInfo',anon,undefined,true)).data.authCaptchaEnabled,false);
 assert.deepEqual((await rpc('auth.needsCaptcha',anon,{username:'admin10@example.test'},true)).data,{enabled:false,required:false});ok('admin disables verification and both public HTTP settings agree');
 const normal=new Map();assert.equal((await rpc('auth.login',normal,{username:'admin10@example.test',password:'ticket10-admin-password'})).data.id,1);admin.clear();for(const [k,v] of normal)admin.set(k,v);ok('existing password succeeds without captcha after disabling');
 assert.equal((await rpc('auth.register',anon,{username:newUsername,password:'ticket10-new-password'})).error,undefined);ok('registration succeeds without captcha');
 assert.equal((await rpc('auth.login',anon,{username:newUsername,password:'ticket10-new-password'})).error,undefined);
 assert.equal((await rpc('system.updateSettings',anon,{authCaptchaEnabled:true})).code,'FORBIDDEN');ok('ordinary user cannot change verification');
 const blocked=new Map();assert.match((await rpc('auth.login',blocked,{username:'disabled10@example.test',password:'ticket10-disabled-password'})).error,/账户已被禁用/);ok('disabled account remains blocked');
 for(let i=0;i<8;i++)assert.match((await rpc('auth.login',new Map(),{username:missingUsername,password:'wrong-password'})).error,/用户名或密码错误/);
 assert.equal((await rpc('auth.login',new Map(),{username:missingUsername,password:'wrong-password'})).code,'TOO_MANY_REQUESTS');ok('wrong-password checks and brute-force limits remain');
 assert.equal((await rpc('system.updateSettings',admin,{email:{enabled:true,verifyRegistration:true,whitelistEnabled:true,whitelist:'allowed.example'}})).error,undefined);
 assert.equal((await rpc('auth.emailConfig',new Map(),undefined,true)).data.verifyRegistration,true);
 assert.match((await rpc('auth.register',new Map(),{username:'verify@allowed.example',email:'verify@allowed.example',password:'ticket10-register-password'})).error,/邮箱验证码错误或已过期/);ok('email verification still required without captcha');
 assert.match((await rpc('auth.register',new Map(),{username:'verify@other.example',password:'ticket10-register-password'})).error,/白名单/);ok('email allowlist still enforced');
 await rpc('system.updateSettings',admin,{email:{enabled:false,verifyRegistration:false,whitelistEnabled:false},twoFactorEnabled:true});
 const db=new SQLite(dir+'/panel.db');db.prepare('UPDATE users SET twoFactorEnabled=1,twoFactorSecret=? WHERE id=1').run('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');db.close();
 const secondFactor=await rpc('auth.login',new Map(),{username:'admin10@example.test',password:'ticket10-admin-password'});assert.equal(secondFactor.data.twoFactorRequired,true);ok('2FA still required without captcha');
 const db2=new SQLite(dir+'/panel.db');db2.prepare('UPDATE users SET twoFactorEnabled=0,twoFactorSecret=NULL WHERE id=1').run();db2.close();
 await rpc('system.updateSettings',admin,{twoFactorEnabled:false,registrationEnabled:false});assert.match((await rpc('auth.register',new Map(),{username:'closed10@example.test',password:'ticket10-register-password'})).error,/注册未开放/);ok('registration switch still enforced');
 await rpc('system.updateSettings',admin,{registrationEnabled:true});
}
if(stage==='on'){
 assert.equal((await rpc('system.updateSettings',admin,{authCaptchaEnabled:true})).error,undefined);
 assert.equal((await rpc('auth.emailConfig',anon,undefined,true)).data.authCaptchaEnabled,true);
 assert.match((await rpc('auth.register',anon,{username:'again10@example.test',password:'ticket10-new-password'})).error,/CAPTCHA_REQUIRED/);ok('restoring verification takes effect on HTTP');
}
if(stage==='google-config'){
 assert.equal((await rpc('google.loginStatus',anon,undefined,true)).data.enabled,false);ok('Google default disabled');
 assert.equal((await rpc('google.saveSettings',admin,{enabled:true,clientId:'fixture10.apps.googleusercontent.com',clientSecret:'fixture10-client-secret',redirectUri:origin+'/api/auth/google/callback'})).error,undefined);
 const settings=(await rpc('google.settings',admin,undefined,true)).data;assert.equal(settings.secretConfigured,true);assert.ok(!JSON.stringify(settings).includes('fixture10-client-secret'));ok('configured Google enabled; client secret omitted from response');
}
if(stage==='google-password'){
 const google=new Map();await request('/__ticket10/as-google',google);
 assert.equal((await rpc('google.status',google,undefined,true)).data.passwordSet,false);
 assert.equal((await rpc('google.setPassword',google,{password:'ticket10-google-password'})).error,undefined);ok('real HTTP sets a password with recent Google proof');
 assert.match((await rpc('google.setPassword',google,{password:'ticket10-replay-password'})).error,/五分钟/);ok('successful password setup clears recent proof; normal resubmission rejected');
 assert.equal((await rpc('google.status',google,undefined,true)).data.passwordSet,true);
 const local=new Map();assert.equal((await rpc('auth.login',local,{username:'google10@example.test',password:'ticket10-google-password'})).error,undefined);ok('Google-created user can sign in with new password');
}
if(stage==='after-unbind'){
 const google=new Map();const login=await rpc('auth.login',google,{username:'google10@example.test',password:'ticket10-google-password'});assert.equal(login.error,undefined);
 const status=(await rpc('google.status',google,undefined,true)).data;assert.equal(status.bound,false);assert.equal(status.email,'');assert.equal(status.passwordSet,true);ok('confirmed unlink persists; password sign-in still works');
 const db=new SQLite(dir+'/panel.db',{readonly:true});const row=db.prepare('SELECT googleSubject,googleEmail,googleLinkedAt FROM users WHERE username=?').get('google10@example.test');assert.deepEqual(row,{googleSubject:null,googleEmail:null,googleLinkedAt:null});db.close();evidence.googleFields=row;ok('all Google identity fields cleared in SQLite');
}
fs.writeFileSync(dir+'/http-'+stage+'-evidence.json',JSON.stringify(evidence,null,2)+'\n');
