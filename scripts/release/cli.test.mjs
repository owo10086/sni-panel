import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { baseline, groups } from '../verify.mjs';
import { createManifest, requiredFiles } from './protocol.mjs';
const cli = fileURLToPath(new URL('./publish.mjs', import.meta.url));
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init']); git(['config', 'user.email', 'fixture@example.test']); git(['config', 'user.name', '发布测试']);
  fs.writeFileSync(`${root}/source`, 'immutable'); git(['add', 'source']); git(['commit', '-m', '准备发布测试']);
  const commit = git(['rev-parse', 'HEAD']);
  const identity = { commit, version: '3.5.2', agentVersion: '3.5.0', fxpVersion: '3.5.0', image: `ghcr.io/owo10086/sni-panel@sha256:${'b'.repeat(64)}` };
  const dir = `${root}/.release/candidate`; fs.mkdirSync(dir, { recursive: true });
  for (const name of requiredFiles(identity.version)) fs.writeFileSync(`${dir}/${name}`, name);
  const records = [...Object.keys(groups), 'bundle', 'image'].map(group => ({ group, commit, status: 'passed', sourceClean: true, image: identity.image,
    environment: { node: baseline.node, pnpm: baseline.pnpm, go: `${baseline.go} linux/amd64`, os: 'ID=ubuntu\nVERSION_ID="24.04"' },
    commands: (groups[group] || []).map(args => ({ args, status: 0 })) }));
  const manifest = createManifest(dir, identity, records);
  fs.writeFileSync(`${dir}/manifest.json`, JSON.stringify(manifest));
  fs.mkdirSync(`${root}/bin`); fs.mkdirSync(`${root}/remote`);
  const fake = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.FAKE_REMOTE;
const args = process.argv.slice(2);
const program = path.basename(process.argv[1]);
fs.appendFileSync(root + '/calls', JSON.stringify([program, ...args]) + '\n');
const flag = key => args[args.indexOf(key) + 1];
const releaseFile = root + '/release.json';
const read = () => JSON.parse(fs.readFileSync(releaseFile));
if (program === 'gh') {
  if (args[0] === 'api') {
    if (args[1].includes('/commits/')) { console.log(JSON.stringify({ sha: process.env.FAKE_COMMIT })); process.exit(0); }
    if (!fs.existsSync(releaseFile) || args[1].endsWith('/latest') || (args[1].includes('/tags/') && read().draft)) { console.error('HTTP 404'); process.exit(1); }
    const release = read(); release.assets = fs.readdirSync(root).filter(n => n.startsWith('asset-')).map(n => ({name:n.slice(6)})); console.log(JSON.stringify(release));
  } else if (args[1] === 'view') {
    if (!fs.existsSync(releaseFile)) { console.error('release not found'); process.exit(1); }
    const release = read(); console.log(JSON.stringify({isDraft:release.draft, tagName:release.tag_name, assets:fs.readdirSync(root).filter(n => n.startsWith('asset-')).map(n => ({name:n.slice(6)}))}));
  } else if (args[1] === 'create') {
    fs.writeFileSync(releaseFile, JSON.stringify({ draft: true, tag_name: 'v3.5.2', assets: [] }));
  } else if (args[1] === 'upload') {
    if (process.env.FAKE_FAULT === 'upload') { console.error('network upload failed'); process.exit(1); }
    fs.copyFileSync(args[3], root + '/asset-' + path.basename(args[3]));
  } else if (args[1] === 'download') {
    const directory = flag('--dir'); fs.mkdirSync(directory, {recursive:true});
    const pattern = args.includes('--pattern') ? flag('--pattern') : null;
    for (const name of fs.readdirSync(root).filter(n => n.startsWith('asset-'))) {
      if (!pattern || name.slice(6) === pattern) fs.copyFileSync(root + '/' + name, directory + '/' + name.slice(6));
    }
    if (!pattern && process.env.FAKE_FAULT === 'download-checksum') fs.writeFileSync(directory + '/forwardx-agent-linux-amd64', 'corrupted');
  } else if (args[1] === 'edit') { const release = read(); release.draft = false; fs.writeFileSync(releaseFile, JSON.stringify(release)); }
  else { console.error('Unexpected fake gh command'); process.exit(2); }
} else if (program === 'docker') {
  if (args.includes('create')) fs.writeFileSync(root + '/image', args[args.length - 1]);
  else if (args.includes('inspect')) console.log('Digest: sha256:' + 'b'.repeat(64));
  else process.exit(2);
}
`;
  for (const program of ['gh', 'docker']) { fs.writeFileSync(`${root}/bin/${program}`, fake); fs.chmodSync(`${root}/bin/${program}`, 0o755); }
  const run = fault => spawnSync(process.execPath, [cli], { cwd: root, encoding: 'utf8', env: { ...process.env,
    PATH: `${root}/bin:${process.env.PATH}`, GITHUB_REPOSITORY: 'owo10086/sni-panel', GITHUB_REF_NAME: 'v3.5.2',
    FAKE_REMOTE: `${root}/remote`, FAKE_COMMIT: commit, FAKE_FAULT: fault || '' } });
  return { root, dir, run };
}
test('real CLI transfers to a draft, verifies downloads, then publishes; repeated invocation recovers', t => {
  const f = setup(t);
  let result = f.run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(`${f.root}/remote/release.json`)).draft, false);
  assert.ok(fs.existsSync(`${f.root}/remote/image`));
  let state = JSON.parse(fs.readFileSync(`${f.root}/.release/state.json`)); assert.equal(state.status, 'incomplete');
  result = f.run(); assert.equal(result.status, 0, result.stderr);
  state = JSON.parse(fs.readFileSync(`${f.root}/.release/state.json`)); assert.equal(state.steps.verify, 'complete');
});
test('real CLI rejects wrong downloaded checksums while Release remains a draft', t => {
  const f = setup(t); const result = f.run('download-checksum'); assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(`${f.root}/remote/release.json`)).draft, true);
  assert.equal(fs.existsSync(`${f.root}/remote/image`), false);
  assert.equal(JSON.parse(fs.readFileSync(`${f.root}/.release/state.json`)).error.step, 'verify');
});
test('real CLI retains the original candidate after upload failures and resumes it', t => {
  const f = setup(t); let result = f.run('upload'); assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(`${f.root}/remote/release.json`)).draft, true);
  assert.equal(fs.existsSync(`${f.root}/remote/image`), false);
  const calls = fs.readFileSync(`${f.root}/remote/calls`, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(args => args[2] === 'upload').length, 3);
  result = f.run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(`${f.root}/remote/release.json`)).draft, false);
});
