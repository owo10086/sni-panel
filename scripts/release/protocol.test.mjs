import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { baseline, groups } from '../verify.mjs';
import { createManifest, requiredFiles, validateManifest, publish, transfer, finishDocs } from './protocol.mjs';
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-faults-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const identity = { commit: 'a'.repeat(40), version: '3.5.2', agentVersion: '3.5.0', fxpVersion: '3.5.0', image: `ghcr.io/owo10086/sni-panel@sha256:${'b'.repeat(64)}` };
  for (const file of requiredFiles(identity.version)) fs.writeFileSync(path.join(directory, file), file);
  const records = [...Object.keys(groups), 'bundle', 'image'].map(group => ({ group, commit: identity.commit, status: 'passed', sourceClean: true, image: identity.image, environment: { node: baseline.node, pnpm: baseline.pnpm, go: `${baseline.go} linux/amd64`, os: 'ID=ubuntu\nVERSION_ID="24.04"' }, commands: (groups[group] || []).map(args => ({ args, status: 0 })) }));
  const manifest = createManifest(directory, identity, records);
  const calls = [];
  const remote = Object.fromEntries(['draft', 'upload', 'verify', 'release', 'image'].map(step => [step, async () => { calls.push(step); }]));
  let saved;
  return { directory, identity, records, manifest, calls, remote, state: {}, save: state => { saved = structuredClone(state); }, get saved() { return saved; } };
}
for (const fault of ['test', 'missing', 'hash', 'incomplete-checks']) test(`${fault} fails before any public write`, async t => {
  const f = fixture(t);
  if (fault === 'test') f.manifest.checks[0].status = 'failed';
  if (fault === 'missing') fs.unlinkSync(path.join(f.directory, f.manifest.artifacts[0].name));
  if (fault === 'hash') fs.writeFileSync(path.join(f.directory, f.manifest.artifacts[0].name), 'changed');
  if (fault === 'incomplete-checks') f.manifest.checks[0].commands.pop();
  await assert.rejects(publish(f)); assert.deepEqual(f.calls, []);
});
test('upload failure leaves draft and records incomplete; same manifest resumes idempotently', async t => {
  const f = fixture(t);
  f.remote.upload = async () => { throw new Error('upload failed'); };
  await assert.rejects(publish(f), /upload failed/);
  assert.deepEqual(f.calls, ['draft']);
  assert.equal(f.saved.status, 'incomplete'); assert.equal(f.saved.error.step, 'upload');
  f.remote.upload = async () => { f.calls.push('upload'); };
  await publish(f);
  assert.equal(f.state.status, 'incomplete', 'Pages still needs verification');
  await finishDocs({ ...f, verifyDocs: async () => {} });
  assert.equal(f.state.status, 'complete');
  await publish(f); await finishDocs({ ...f, verifyDocs: async () => {} });
  assert.equal(f.state.status, 'complete');
});
test('remote verification failure blocks publication and image tags', async t => {
  const f = fixture(t); f.remote.verify = async () => { throw new Error('wrong remote checksum'); };
  await assert.rejects(publish(f), /wrong remote checksum/);
  assert.deepEqual(f.calls, ['draft', 'upload']);
});
test('interrupted finalization resumes original artifacts and rejects replacement commit', async t => {
  const f = fixture(t); f.remote.image = async () => { throw new Error('registry unavailable'); };
  await assert.rejects(publish(f), /registry unavailable/);
  assert.equal(f.state.steps.release, 'complete'); assert.equal(f.state.status, 'incomplete');
  const changed = structuredClone(f.manifest); changed.commit = 'c'.repeat(40);
  changed.checks.forEach(record => { record.commit = changed.commit; });
  await assert.rejects(publish({ ...f, manifest: changed }), /different commit/);
  f.remote.image = async () => {}; await publish(f);
  await assert.rejects(finishDocs({ ...f, verifyDocs: async () => { throw new Error('wrong docs commit'); } }));
  assert.equal(f.state.status, 'incomplete');
  await finishDocs({ ...f, verifyDocs: async () => {} }); assert.equal(f.state.status, 'complete');
});
test('network transfer gets exactly three attempts with 5 and 15 second delays', async () => {
  let calls = 0; const delays = [];
  await assert.rejects(transfer(async () => { calls++; throw new Error('network'); }, async ms => { delays.push(ms); }));
  assert.equal(calls, 3); assert.deepEqual(delays, [5000, 15000]);
});
test('identity is retained in an immutable manifest', t => { const f = fixture(t); assert.ok(validateManifest(f.manifest, f.directory)); });

test('a local image ID can never be sealed as an official release', t => { const f = fixture(t); assert.throws(() => createManifest(f.directory, { ...f.identity, image: 'sha256:' + 'b'.repeat(64) }, f.records)); });
