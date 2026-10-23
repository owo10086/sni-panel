import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const baseline = { os: 'ubuntu-24.04', node: 'v22.23.3', pnpm: '10.28.1', go: 'go1.23.12' };
export const groups = {
  prepare: [['pnpm', 'check:versions'], ['pnpm', 'test:release-notes'], ['node', '--test', 'scripts/release/protocol.test.mjs', 'scripts/release/cli.test.mjs'], ['pnpm', 'exec', 'tsc', '--noEmit'], ['pnpm', 'build']],
  language: [['pnpm', 'test:i18n']],
  functional: [],
  docs: [['pnpm', 'docs:build'], ['node', 'scripts/release/verify-docs.mjs']],
  performance: [['node', '--import', 'tsx', '--test', '--test-concurrency=1', 'server/sniBatchEdit.performance.test.ts']],
  mysql: [['pnpm', 'test:database-upgrade']],
  agent: [['bash', 'scripts/release/verify-agent.sh']],
};
const scripts = ['ui', 'login-ui', 'startup', 'auth-captcha', 'billing-export', 'host-addresses', 'china-health', 'observability', 'support', 'affiliates', 'avatars', 'latency-history', 'agent-proxy', 'deployment-docs', 'google-auth', 'port-access-limits', 'plan-display', 'host-deletion', 'host-notifications', 'user-selection', 'operations', 'payments', 'list-settings', 'url-probe', 'motion', 'host-load', 'performance', 'plugin-bbr', 'rule-groups', 'server', 'ai', 'selftest-dispatch', 'sni-classification'];
groups.functional = scripts.flatMap(name => name === 'server' ? [['pnpm', 'pretest:server'], ['pnpm', 'test:server']] : [['pnpm', `test:${name}`]]);
// These two shell integration checks otherwise report SKIP when jq is absent.
groups.functional.unshift(['bash', '-c', 'command -v jq >/dev/null || { echo "Functional checks require jq; install jq before continuing" >&2; exit 1; }']);
groups.functional.push(['node', '--import', 'tsx', '--test', 'server/tunnelProbeReporting.test.ts']);
groups.functional.push(['node', '--import', 'tsx', '--test', '--test-name-pattern=port entry SNI|automatically enqueue', 'server/sniForwardGroup.test.ts']);
const command = (cmd, args = []) => spawnSync(cmd, args, { encoding: 'utf8' });
export function verify(selected = 'all') {
  const requested = selected === 'all' ? Object.keys(groups) : selected.split(',');
  for (const name of requested) if (!groups[name]) throw new Error(`Unknown check group: ${name}`);
  const commit = command('git', ['rev-parse', 'HEAD']).stdout.trim();
  const environment = { platform: process.platform, arch: process.arch, node: process.version,
    pnpm: command('pnpm', ['--version']).stdout.trim(), go: command('go', ['version']).stdout.trim(),
    os: fs.existsSync('/etc/os-release') ? fs.readFileSync('/etc/os-release', 'utf8') : process.platform };
  if (process.env.CI === 'true') {
    if (environment.node !== baseline.node || environment.pnpm !== baseline.pnpm || !environment.go.includes(baseline.go + ' ') || !environment.os.includes('VERSION_ID="24.04"') || !environment.os.includes('ID=ubuntu')) {
      throw new Error(`Validation baseline mismatch: ${JSON.stringify(environment)}`);
    }
  }
  fs.mkdirSync('.release/checks', { recursive: true });
  for (const name of requested) {
    if (name === 'mysql' && !process.env.FORWARDX_TEST_MYSQL_URL) throw new Error('MySQL integration URL is required; a skipped integration test cannot pass the release gate');
    if (name === 'agent' && (process.platform !== 'linux' || process.arch !== 'x64')) throw new Error('Agent release fixtures require Linux amd64, matching the released binaries');
    const sourceClean = command('git', ['status', '--porcelain', '--untracked-files=normal']).stdout.trim() === '';
    const record = { schema: 1, group: name, commit, sourceClean, environment, baseline, status: 'running', commands: [] };
    const recordFile = `.release/checks/${name}.json`;
    const save = () => fs.writeFileSync(recordFile, JSON.stringify(record, null, 2) + '\n');
    save();
    for (const [index, args] of groups[name].entries()) {
      console.log(`\n[${name}] ${args.join(' ')}`);
      const started = Date.now();
      const log = fs.openSync(`.release/checks/${name}-${index}.log`, 'w');
      const result = spawnSync(args[0], args.slice(1), { stdio: ['ignore', log, log], env: {
        ...process.env, npm_config_enable_pre_post_scripts: 'false', FORWARDX_DNS_RACE_REPEATS: '100',
      } });
      fs.closeSync(log);
      // Keep the full diagnostic log even when the first assertion fails.
      process.stdout.write(fs.readFileSync(`.release/checks/${name}-${index}.log`));
      record.commands.push({ args, status: result.status, signal: result.signal, elapsedMs: Date.now() - started });
      if (result.status !== 0) {
        record.status = 'failed'; save();
        throw new Error(`Check failed without retry: ${name}: ${args.join(' ')} (${result.error || result.status})`);
      }
      save();
    }
    record.status = 'passed'; save();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) verify(process.argv[2]);
