import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess

root = Path('/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx-task-3')
fixtures = Path('/private/tmp/forwardx-task3-fixes/password-reset')
results = []
for mode in ['local', 'docker']:
    database = fixtures / f'{mode}.db'
    connection = sqlite3.connect(database)
    admin = connection.execute('SELECT id,password,accountEnabled,twoFactorEnabled FROM users WHERE username=?', ('dev.admin@forwardx.local',)).fetchone()
    others = connection.execute('SELECT id,password FROM users WHERE id<>? ORDER BY id', (admin[0],)).fetchall()
    live_before = connection.execute('SELECT COUNT(*) FROM auth_sessions WHERE userId=? AND revokedAt IS NULL', (admin[0],)).fetchone()[0]
    assert live_before > 0, 'fixture must have a real browser login session'
    connection.close()
    command = ['node', str(root/'dist/reset-admin-password.js'), '--stdin']
    env = dict(os.environ, DATABASE_TYPE='sqlite', SQLITE_PATH=str(database), DATABASE_CONFIG_PATH=str(fixtures/f'{mode}-config.json'), FORWARDX_LOG_DIR=str(fixtures/f'{mode}-logs'))
    if mode == 'docker':
        command = ['docker', 'run', '--rm', '-i', '--platform', 'linux/amd64', '--network', 'none', '--entrypoint', 'node',
                   '-v', f'{root}/dist:/app/dist:ro', '-v', f'{fixtures}:/fixtures',
                   '-e', 'DATABASE_TYPE=sqlite', '-e', 'SQLITE_PATH=/fixtures/docker.db',
                   '-e', 'DATABASE_CONFIG_PATH=/fixtures/docker-config.json', '-e', 'FORWARDX_LOG_DIR=/fixtures/docker-logs',
                   'forwardx-ticket20-panel:ed9be4f', '/app/dist/reset-admin-password.js', '--stdin']
    run = subprocess.run(command, cwd=root, env=env, input='dev.admin@forwardx.local\ntask3-reset-fixture-284\ntask3-reset-fixture-284\n', text=True, capture_output=True, timeout=90)
    (fixtures/f'{mode}.log').write_text(run.stdout + run.stderr)
    assert run.returncode == 0, run.stdout + run.stderr
    connection = sqlite3.connect(database)
    after = connection.execute('SELECT id,password,accountEnabled,twoFactorEnabled FROM users WHERE id=?', (admin[0],)).fetchone()
    assert after[1] != admin[1]
    assert after[2:] == admin[2:]
    assert connection.execute('SELECT id,password FROM users WHERE id<>? ORDER BY id', (admin[0],)).fetchall() == others
    assert connection.execute('SELECT COUNT(*) FROM auth_sessions WHERE userId=? AND revokedAt IS NULL', (admin[0],)).fetchone()[0] == 0
    revoked = connection.execute('SELECT COUNT(*) FROM auth_sessions WHERE userId=? AND revokeReason=?', (admin[0], 'password_reset_cli')).fetchone()[0]
    assert revoked >= live_before
    connection.close()
    results.append({'mode': mode, 'result': 'passed', 'administratorPasswordChanged': True, 'otherUsersUnchanged': True, 'accountAndTwoFactorFlagsPreserved': True, 'liveSessionsBefore': live_before, 'liveSessionsAfter': 0})
(fixtures/'result.json').write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(results, ensure_ascii=False))
