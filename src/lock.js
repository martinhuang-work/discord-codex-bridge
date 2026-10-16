import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readPrivateFile } from './private-files.js';
import { PublicError } from './errors.js';

export function acquireLock(dataDir) {
  const directory = join(dataDir, 'bot.lock');
  const recovery = join(dataDir, 'bot.lock-recovery');
  const token = randomUUID();
  const busy = () => new PublicError('Another bot is running, or its lock needs inspection. See the README before removing a lock.');
  const create = () => mkdirSync(directory, { mode: 0o700 });
  try { create(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Only one process may replace a stale lock. A failed startup leaves the
    // lock for inspection instead of risking two bots using the same state.
    try { mkdirSync(recovery, { mode: 0o700 }); } catch { throw busy(); }
    try {
      const pid = Number(readPrivateFile(join(directory, 'pid'), 32));
      if (!Number.isInteger(pid) || pid < 1) throw busy();
      try { process.kill(pid, 0); throw busy(); }
      catch (error) { if (error.code !== 'ESRCH') throw busy(); }
      rmSync(directory, { recursive: true });
      create();
    } finally { rmSync(recovery, { recursive: true, force: true }); }
  }
  writeFileSync(join(directory, 'pid'), String(process.pid), { flag: 'wx', mode: 0o600 });
  writeFileSync(join(directory, 'owner'), token, { flag: 'wx', mode: 0o600 });
  return () => {
    try {
      if (readPrivateFile(join(directory, 'owner'), 64) === token) rmSync(directory, { recursive: true });
    } catch { /* Preserve a lock that is missing, changed, or unreadable. */ }
  };
}
