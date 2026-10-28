import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("HTTP login retains cookies through real database faults and rechecks account permissions", { timeout: 30_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sni-auth-backpressure-"));
  const script = String.raw`
    import assert from 'node:assert/strict';
    import express from 'express';
    import cookieParser from 'cookie-parser';
    import jwt from 'jsonwebtoken';
    import Database from 'better-sqlite3';
    import { once } from 'node:events';
    import { createExpressMiddleware } from '@trpc/server/adapters/express';
    import * as runtime from './server/dbRuntime.ts';
    import { ensureDatabaseSchema } from './server/dbSchema.ts';
    import { createUser } from './server/repositories/userRepository.ts';
    import { setSetting } from './server/repositories/settingsRepository.ts';
    import { createContext, updateMultiDeviceLoginSettingCache } from './server/_core/context.ts';
    import { databaseHealth } from './server/databaseHealthState.ts';
    import { router } from './server/_core/trpc.ts';
    import { authRouter } from './server/routers/auth.ts';
    import { systemRouter } from './server/_core/systemRouter.ts';
    import { COOKIE_NAME } from './shared/const.ts';
    import { encodeSessionLease } from './server/session.ts';
    await runtime.connectDatabase({type:'sqlite',sqlite:{path:process.env.SQLITE_PATH}});
    await ensureDatabaseSchema();
    const alice = await createUser({username:'alice@example.com',password:'test-password',role:'user'});
    const bob = await createUser({username:'bob@example.com',password:'test-password',role:'admin'});
    await setSetting('authCaptchaEnabled','false');
    updateMultiDeviceLoginSettingCache(false);
    databaseHealth.healthy();
    const app = express();app.use(express.json());app.use(cookieParser());
    app.use('/api/trpc',createExpressMiddleware({router:router({auth:authRouter,system:systemRouter}),createContext}));
    const server = app.listen(0,'127.0.0.1');await once(server,'listening');
    const base = 'http://127.0.0.1:'+server.address().port+'/api/trpc/';
    async function call(method,cookie='',input,mutation=false) {
      const response = await fetch(base+method+(mutation?'':'?input='+encodeURIComponent(JSON.stringify({json:input}))),{
        method:mutation?'POST':'GET',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},
        ...(mutation?{body:JSON.stringify({json:input})}:{})});
      return {status:response.status,cleared:(response.headers.get('set-cookie')||'').startsWith(COOKIE_NAME+'=;'),cookie:(response.headers.get('set-cookie')||'').split(';')[0],data:await response.json()};
    }
    let external;
    try {
      const loginA = await call('auth.login','',{username:'alice@example.com',password:'test-password'},true);
      const loginB = await call('auth.login','',{username:'bob@example.com',password:'test-password'},true);
      assert.equal(loginA.status,200,JSON.stringify(loginA));assert.equal(loginB.status,200,JSON.stringify(loginB));
      const a=loginA.cookie,b=loginB.cookie;
      assert.equal((await call('auth.me',a)).data.result.data.json.id,alice);
      assert.equal((await call('system.panelLogs',a,{limit:1})).status,403);
      assert.equal((await call('system.panelLogs',b,{limit:1})).status,200);
      // A genuine SQL failure is not proof of an invalid cookie. Restore the
      // same table and recover using the same browser credential.
      await runtime.executeRaw('ALTER TABLE users RENAME TO unavailable_users');
      const fault=await call('auth.me',a);
      assert.ok([500,503].includes(fault.status),JSON.stringify(fault));
      assert.equal(fault.cleared,false,'infrastructure errors must not discard credentials');
      await runtime.executeRaw('ALTER TABLE unavailable_users RENAME TO users');
      assert.equal((await call('auth.me',a)).data.result.data.json.id,alice);
      // Hold a real second SQLite writer while the session lease needs refresh.
      const sid=jwt.decode(decodeURIComponent(a.slice(a.indexOf('=')+1))).sid;
      await runtime.executeRaw('UPDATE users SET browserSessionToken=? WHERE id=?',[encodeSessionLease(sid,Date.now()-31000),alice]);
      await runtime.withSqliteExclusive(db=>db.pragma('busy_timeout=30'));
      external=new Database(process.env.SQLITE_PATH);external.exec('BEGIN IMMEDIATE');
      const busy=await call('auth.me',a);
      assert.equal(busy.status,503,JSON.stringify(busy));assert.equal(busy.cleared,false);
      external.exec('ROLLBACK');external.close();external=undefined;
      assert.equal((await call('auth.me',a)).data.result.data.json.id,alice);
      // A slow real connection causes bounded admission, then healthy recovery.
      let release,entered;const ready=new Promise(resolve=>entered=resolve);
      const held=runtime.withSqliteExclusive(async()=>{entered();await new Promise(resolve=>release=resolve);});await ready;
      const responses=Promise.all(Array.from({length:300},(_,i)=>call('auth.me',i%2?a:b).then(result=>({...result,expected:i%2?alice:bob}))));
      await new Promise(resolve=>setTimeout(resolve,2200));release();await held;
      const burst=await responses;
      assert.ok(burst.some(result=>result.status===503),'excess requests receive backpressure');
      assert.ok(burst.some(result=>result.status===200),'active requests finish after SQL is released');
      assert.ok(burst.every(result=>[200,503].includes(result.status)&&!result.cleared));
      for(const result of burst.filter(result=>result.status===200)) assert.equal(result.data.result.data.json.id,result.expected,'account context must stay isolated');
      assert.equal((await call('auth.me',b)).data.result.data.json.id,bob);
      await runtime.executeRaw("UPDATE users SET role='user' WHERE id=?",[bob]);
      assert.equal((await call('system.panelLogs',b,{limit:1})).status,403,'role change takes effect on next request');
      await runtime.executeRaw('UPDATE users SET accountEnabled=0 WHERE id=?',[bob]);
      const disabled=await call('auth.me',b);assert.equal(disabled.status,401);assert.equal(disabled.cleared,true);
      const expiredToken=jwt.sign({userId:alice,sid,kind:'browser'},process.env.JWT_SECRET,{expiresIn:-1});
      const expiredJwt=await call('system.panelLogs',COOKIE_NAME+'='+expiredToken,{limit:1});
      assert.equal(expiredJwt.status,401);assert.equal(expiredJwt.cleared,true);
      await runtime.executeRaw('UPDATE auth_sessions SET expiresAt=1 WHERE sid=?',[sid]);
      assert.equal((await call('auth.me',a)).status,401,'expired database session remains invalid');
      await runtime.executeRaw('UPDATE auth_sessions SET expiresAt=? WHERE sid=?',[Math.floor(Date.now()/1000)+60,sid]);
      assert.equal((await call('auth.logout',a,undefined,true)).status,200);
      const revoked=await call('auth.me',a);assert.equal(revoked.status,401);assert.equal(revoked.cleared,true);
      const wrong=jwt.sign({userId:alice,sid:'other-account-session',kind:'browser'},process.env.JWT_SECRET);
      assert.equal((await call('system.panelLogs',COOKIE_NAME+'='+wrong,{limit:1})).status,401);
      console.log('login/fault/recovery/busy/burst/role-change/disabled/logout verified through HTTP');
    } finally {
      if(external){external.exec('ROLLBACK');external.close();}
      server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await runtime.closeDatabase();
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      encoding: "utf8", timeout: 25_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", SQLITE_PATH: path.join(dir, "auth.db"), DATABASE_CONFIG_PATH: path.join(dir, "config.json"), JWT_SECRET: "auth-integration-test-secret-32-characters", FORWARDX_DEV_PANEL: "0", FORWARDX_LOG_DIR: path.join(dir, "logs") },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    console.log(result.stdout.trim());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
