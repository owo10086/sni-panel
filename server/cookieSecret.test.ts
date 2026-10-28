import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import jwt from "jsonwebtoken";

const strong = "a59fd2c710c759be1a4fb2dd82f04e3c66bd234aa047087de940b3128df0d2a1";
function boot(directory: string, secret: string) {
  return new Promise<{ token: string; warnings: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", `
      import { ENV } from ${JSON.stringify(path.resolve("server/env.ts"))};
      import jwt from ${JSON.stringify(path.resolve("node_modules/jsonwebtoken/index.js"))};
      process.stdout.write(jwt.sign({ userId: 7, sid: 'browser-session', kind: 'browser' }, ENV.cookieSecret));
    `], { cwd: directory, env: { ...process.env, JWT_SECRET: secret, SQLITE_PATH: path.join(directory, "panel.db"), FORWARDX_JWT_SECRET_PATH: path.join(directory, "jwt.secret") } });
    let token = "", warnings = "";
    child.stdout.on("data", chunk => { token += chunk; });
    child.stderr.on("data", chunk => { warnings += chunk; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve({ token, warnings }) : reject(new Error(warnings)));
  });
}

test("configured strong signing key survives startup without touching persisted key", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sni-secret-"));
  try {
    fs.writeFileSync(path.join(dir, "jwt.secret"), "persisted-key-is-separate-and-long-enough-12345");
    const result = await boot(dir, strong);
    assert.equal((jwt.verify(result.token, strong) as jwt.JwtPayload).userId, 7);
    assert.equal(fs.readFileSync(path.join(dir, "jwt.secret"), "utf8"), "persisted-key-is-separate-and-long-enough-12345");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("weak signing configuration reuses a valid persisted key and keeps sessions on restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sni-secret-"));
  try {
    fs.writeFileSync(path.join(dir, "jwt.secret"), strong);
    for (const weak of ["short", "change-me-to-a-very-long-random-secret", "x".repeat(64)]) {
      const first = await boot(dir, weak);
      const restarted = await boot(dir, weak);
      assert.equal((jwt.verify(first.token, strong) as jwt.JwtPayload).sid, "browser-session");
      assert.equal((jwt.verify(restarted.token, strong) as jwt.JwtPayload).userId, 7);
      assert.ok(!first.warnings.includes(strong));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("concurrent cold starts and weak-file upgrades share one persistent signing key", async () => {
  for (const existing of ["", "z".repeat(64)]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sni-secret-concurrent-"));
    try {
      if (existing) fs.writeFileSync(path.join(dir, "jwt.secret"), existing, { mode: 0o644 });
      const results = await Promise.all(Array.from({ length: 12 }, () => boot(dir, "change-me-placeholder-that-is-long-enough")));
      const stored = fs.readFileSync(path.join(dir, "jwt.secret"), "utf8").trim();
      assert.match(stored, /^[a-f0-9]{64}$/);
      assert.equal(fs.statSync(path.join(dir, "jwt.secret")).mode & 0o777, 0o600);
      for (const result of results) {
        assert.equal((jwt.verify(result.token, stored) as jwt.JwtPayload).userId, 7);
        assert.ok(!result.warnings.includes(stored));
      }
      const restarted = await boot(dir, "");
      assert.equal((jwt.verify(restarted.token, stored) as jwt.JwtPayload).sid, "browser-session");
      assert.deepEqual(fs.readdirSync(dir), ["jwt.secret"]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test("unwritable secret storage uses random process keys and explains restart sign-in", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sni-secret-readonly-"));
  try {
    const blocked = path.join(dir, "not-a-directory");
    fs.writeFileSync(blocked, "blocked");
    const source = `
      import jwt from 'jsonwebtoken';
      import { resolveCookieSecret } from './server/cookieSecret.ts';
      const key = resolveCookieSecret('public-weak-value', [${JSON.stringify(path.join(blocked, "jwt.secret"))}]);
      process.stdout.write(jwt.sign({userId:7},key));
    `;
    const run = () => new Promise<{ token: string; warning: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source]);
      let token = "", warning = "";
      child.stdout.on("data", chunk => { token += chunk; });
      child.stderr.on("data", chunk => { warning += chunk; });
      child.on("error", reject);
      child.on("exit", code => code === 0 ? resolve({ token, warning }) : reject(new Error(warning)));
    });
    const [first, second] = await Promise.all([run(), run()]);
    assert.notEqual(first.token, second.token);
    assert.throws(() => jwt.verify(first.token, "public-weak-value"), /signature/);
    assert.match(first.warning, /in-memory.*restart/);
    assert.ok(!first.warning.includes(first.token));
    assert.equal(fs.readFileSync(blocked, "utf8"), "blocked");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
