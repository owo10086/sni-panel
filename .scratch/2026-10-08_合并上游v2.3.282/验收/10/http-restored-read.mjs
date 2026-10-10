import assert from 'node:assert/strict';
import fs from 'node:fs';
const base='http://127.0.0.1:18830/api/trpc/',evidence={checks:[]};
async function rpc(name,input,query=false){const r=await fetch(base+name+(query&&input!==undefined?'?input='+encodeURIComponent(JSON.stringify({json:input})):''),query?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({json:input??null})});const b=await r.json();return {data:b.result?.data?.json,error:b.error?.json?.message};}
assert.equal((await rpc('auth.emailConfig',undefined,true)).data.authCaptchaEnabled,true);assert.equal((await rpc('system.publicInfo',undefined,true)).data.authCaptchaEnabled,true);evidence.checks.push('web save restored public HTTP setting');
assert.match((await rpc('auth.register',{username:'restored10@example.test',password:'ticket10-register-password'})).error,/CAPTCHA_REQUIRED/);evidence.checks.push('web save restored registration verification');
for(let i=0;i<3;i++)await rpc('auth.login',{username:'missing-ui10@example.test',password:'wrong-password'});
assert.deepEqual((await rpc('auth.needsCaptcha',{username:'missing-ui10@example.test'},true)).data,{enabled:true,required:true});evidence.checks.push('restored verification also applies to failed password sign-in');
fs.writeFileSync('/private/tmp/forwardx-282-ticket10/http-restored-read-evidence.json',JSON.stringify(evidence,null,2)+'\n');console.log(evidence);
