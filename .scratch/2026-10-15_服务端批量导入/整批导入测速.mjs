import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [stage = 'before'] = process.argv.slice(2);
const samples = [['ordinary44', 'ordinary', 0, 44], ['ordinary56', 'ordinary', 0, 56], ['existing56plus56', 'ordinary', 56, 56], ['mixed56', 'mixed', 0, 56], ['sni56four', 'sni4', 0, 56], ['sni56three', 'sni3', 0, 56]];
const sources = ['server/routers/rules.crud.ts', 'server/sniRuleWrite.ts', 'client/src/lib/ruleImport.ts', 'client/src/pages/Rules.tsx', 'shared/ruleImport.ts'];
const sourceHashes = Object.fromEntries(sources.filter(file => fs.existsSync(file)).map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const evidence = { stage, sourceHashes, version: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), measurements: [] };
for (const [name, sample, existing, count] of samples) for (let round = 1; round <= 3; round++) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forwardx-import-benchmark-'));
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'server/test-support/sniImportHarness.mjs', 'import-benchmark', String(existing), String(count)], {
      encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, DATABASE_TYPE: 'sqlite', FORWARDX_TEST_DB: path.join(directory, 'test.db'), FORWARDX_LOG_DIR: path.join(directory, 'logs'), RULE_IMPORT_SAMPLE: sample, FORWARDX_BATCH_IMPORT: stage === 'before' ? '0' : '1' },
    });
    if (result.status !== 0) throw new Error(result.error?.message || result.stderr + result.stdout);
    const row = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('RULE_IMPORT_RESULT=')).slice('RULE_IMPORT_RESULT='.length));
    evidence.measurements.push({ name, round, ...row });
    fs.writeFileSync(new URL(`./整批导入测速-${stage}.json`, import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
    console.log(name, round, row.durationMs);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
