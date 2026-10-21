import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
// Only wrap transfers/remote idempotent operations. Never wrap a test command.
const [program, ...args] = process.argv.slice(2);
if (!program) throw new Error('Missing transfer command');
for (let attempt = 0; attempt < 3; attempt++) {
  if (attempt) await setTimeout([5000, 15000][attempt - 1]);
  const result = spawnSync(program, args, { stdio: 'inherit' });
  if (result.status === 0) process.exit(0);
  if (attempt === 2) process.exit(result.status || 1);
}
