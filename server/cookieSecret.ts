import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function usableSecret(value: string) {
  return value.length >= 32 && !/^change[-_ ]?me/i.test(value) && !/^(.)\1+$/u.test(value);
}

export function resolveCookieSecret(secret: string, candidates: string[], warn = console.warn): string {
  secret = secret.trim();
  if (usableSecret(secret)) return secret;
  if (secret) warn("[Security] JWT_SECRET is weak or a placeholder; replacing it with a persistent random secret. Existing sessions must sign in again.");
  const read = (filePath: string) => {
    try { return fs.readFileSync(filePath, "utf8").trim(); } catch { return ""; }
  };
  // Check every existing candidate before creating a new key on another path.
  for (const filePath of candidates) {
    const existing = read(filePath);
    if (usableSecret(existing)) return existing;
  }
  for (const filePath of candidates) {
    const lock = `${filePath}.lock`;
    let owned = false;
    let temporary = "";
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // Serialize weak-file replacement too. Exclusive file creation alone is
      // insufficient when several starters all find the same old weak value.
      for (let attempt = 0; attempt < 500; attempt++) {
        const existing = read(filePath);
        if (usableSecret(existing)) return existing;
        try { fs.mkdirSync(lock, { mode: 0o700 }); owned = true; break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      if (!owned) throw new Error("Secret initialization is busy");
      const existing = read(filePath);
      if (usableSecret(existing)) return existing;
      const generated = crypto.randomBytes(32).toString("hex");
      temporary = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
      fs.writeFileSync(temporary, `${generated}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, filePath);
      temporary = "";
      warn("[Security] Using a generated persistent cookie secret. Existing sessions signed with a replaced key must sign in again.");
      return generated;
    } catch {
      // Try the next persistent path before falling back to process-local state.
    } finally {
      if (temporary) { try { fs.rmSync(temporary, { force: true }); } catch {} }
      if (owned) { try { fs.rmdirSync(lock); } catch {} }
    }
  }
  warn("[Security] No writable secret path was found; using an in-memory cookie secret. Sessions will require sign-in after restart.");
  return crypto.randomBytes(32).toString("hex");
}
