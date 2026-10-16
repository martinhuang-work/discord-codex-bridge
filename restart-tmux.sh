#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
if ! tmux has-session -t discord-codex 2>/dev/null; then
  exec bash start-tmux.sh
fi
node --env-file-if-exists=.env --input-type=module - <<'JS'
import { readFileSync, readlinkSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { configFrom } from './src/config.js';
const { dataDir } = configFrom();
const stateFile = join(dataDir, 'state.json');
const pidFile = join(dataDir, 'bot.lock', 'pid');
if (existsSync(stateFile)) {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  if (Object.values(state.jobs).some(job => job.status === 'running')) {
    console.error('A Codex request is still running. Wait for its answer before restarting.');
    process.exit(1);
  }
}
if (existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile, 'utf8'));
  if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid bot lock.');
  try {
    process.kill(pid, 0);
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    if ((!cmd.includes('src/main.js') && !cmd.includes('src/start.js')) || cwd !== process.cwd()) {
      throw new Error('The lock PID does not identify this bridge. Inspect it before restarting.');
    }
    process.kill(pid, 'SIGTERM');
    for (let attempt = 0; attempt < 20; attempt++) {
      await delay(500);
      try { process.kill(pid, 0); }
      catch (error) { if (error.code === 'ESRCH') process.exit(0); throw error; }
    }
    throw new Error('The previous bot did not stop. Inspect tmux before restarting.');
  } catch (error) {
    if (error.code !== 'ESRCH' && error.code !== 'ENOENT') throw error;
    // A stale lock is validated and removed by main.js on startup.
  }
}
JS
if ! tmux has-session -t discord-codex 2>/dev/null; then
  exec bash start-tmux.sh
fi
tmux send-keys -t discord-codex -l 'npm start'
tmux send-keys -t discord-codex Enter
printf 'Restarted the bridge in tmux session discord-codex.\n'
