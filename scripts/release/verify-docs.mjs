import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const dir = 'docs/.vitepress/dist';
const info = JSON.parse(fs.readFileSync(`${dir}/build-info.json`));
assert.equal(info.version, JSON.parse(fs.readFileSync('package.json')).version);
assert.equal(info.commit, process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
for (const page of ['index.html', 'guide/index.html', 'guide/interface.html', 'guide/releases.html', 'guide/rules.html', 'guide/deploy-panel.html', 'guide/deploy-docker.html', 'guide/deploy-local.html', 'guide/agent.html', 'guide/ssh-management.html', 'guide/agent-proxy-manager.html', 'guide/agent-proxy-manager.en.html']) assert.ok(fs.statSync(`${dir}/${page}`).size > 0, page);
console.log(`Validated docs v${info.version} at ${info.commit}`);
