// This uses synthetic files and a local TCP listener. It does not read account
// credentials, contact Discord, or send a prompt to the model.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { codexEnvironment, securityArgs, codexReadPaths } from '../src/codex.js';

const exec = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), 'bridge-sandbox-'));
const cwd = join(dir, 'workspace');
const listener = createServer(socket => socket.end());
try {
  await mkdir(cwd, { mode: 0o700 });
  await writeFile(join(cwd, 'allowed.txt'), 'readable fixture', { mode: 0o600 });
  await writeFile(join(dir, 'outside.txt'), 'private fixture', { mode: 0o600 });
  await symlink(join(dir, 'outside.txt'), join(cwd, 'linked.txt'));
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const probe = `
    const fs = require('node:fs');
    const net = require('node:net');
    if (fs.readFileSync('allowed.txt', 'utf8') !== 'readable fixture') process.exit(2);
    for (const file of [process.argv[1], 'linked.txt']) {
      let readable = false;
      try { fs.readFileSync(file); readable = true; } catch {}
      if (readable) process.exit(3);
    }
    let writable = false;
    try { fs.writeFileSync('unexpected.txt', 'write'); writable = true; } catch {}
    if (writable) process.exit(4);
    const socket = net.connect({ host: '127.0.0.1', port: Number(process.argv[2]) });
    socket.on('connect', () => process.exit(5));
    socket.on('error', () => process.exit(42));
    socket.setTimeout(1500, () => process.exit(42));
  `;
  const executable = process.env.CODEX_BIN || 'codex';
  let exitCode;
  try {
    await exec(executable, ['sandbox', ...securityArgs(codexReadPaths(executable)),
      '-P', 'discord-bridge', '-C', cwd, '--', process.execPath, '-e', probe,
      join(dir, 'outside.txt'), String(listener.address().port)],
    { env: codexEnvironment(), timeout: 20000, maxBuffer: 65536 });
  } catch (error) { if (error.code !== 42) throw error; exitCode = error.code; }
  // Some runners discard sandbox stdout. A distinct exit code still proves the
  // probe reached its final check; an unexecuted command would exit zero.
  if (exitCode !== 42) throw new Error('Sandbox did not report probe completion.');
  console.log('Sandbox check passed: workspace reads allowed; outside reads, symlink reads, writes, and local network access denied.');
} catch (error) {
  const reasons = ['unshare', 'Operation not permitted', 'Permission denied', 'unexpected argument', 'unknown', 'bwrap', 'not found', 'config']
    .filter(reason => error.stderr?.includes(reason));
  console.error(`Sandbox check failed (exit=${Number.isInteger(error.code) ? error.code : 'unknown'}; hints=${reasons.join(',') || 'none'}). Do not weaken the permissions profile. Check the supported Codex version and Linux sandbox support.`);
  process.exitCode = 1;
} finally {
  await new Promise(resolve => listener.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
