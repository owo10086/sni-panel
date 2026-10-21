import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const round = path.resolve('.scratch/2026-10-20_规则页面信息组织');
const record = JSON.parse(fs.readFileSync(path.join(round,'证据/独立预览路径.json'),'utf8'));
if (!record.database.startsWith(round + '/preview-') || record.database_existed_before_start !== false) throw new Error('Only the new task-owned preview database is permitted');
const db = new Database(record.database);
const source = db.prepare('select * from forward_rules where name = ?').get('Media failover template');
if (!source) throw new Error('Expected isolated preview seed is absent');
const inserted = [];
db.transaction(() => {
  for (const [name,sni,target] of [['SNI preview Hong Kong','hk.preview.example','192.0.2.10'],['SNI preview Tokyo','jp.preview.example','192.0.2.20']]) {
    if (db.prepare('select id from forward_rules where name = ?').get(name)) continue;
    const row = {...source,name,sni,targetIp:target,targetPort:443,sourcePort:443,sniSplitterPort:443,protocol:'tcp',adminManaged:1,trafficMode:'outbound',trafficLimit:10 * 1024 ** 3,quotaUsedIn:1024 ** 2,quotaUsedOut:2 * 1024 ** 3,isRunning:0,sortOrder:-2,createdAt:Math.floor(Date.now()/1000),updatedAt:Math.floor(Date.now()/1000)};
    delete row.id;
    const keys=Object.keys(row);
    const result=db.prepare(`insert into forward_rules (${keys.map(key=>'"'+key+'"').join(',')}) values (${keys.map(()=>'?').join(',')})`).run(...keys.map(key=>row[key]));
    inserted.push({id:Number(result.lastInsertRowid),name,sni});
  }
})();
db.close();
fs.writeFileSync(path.join(round,'证据/SNI预览数据.json'),JSON.stringify({scope:'isolated task preview only',inserted},null,2)+'\n');
console.log(JSON.stringify({inserted}));
