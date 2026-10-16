#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
if tmux has-session -t discord-codex 2>/dev/null; then
  printf 'The discord-codex tmux session already exists. Attach with: tmux attach -t discord-codex\n'
  exit 0
fi
tmux new-session -d -s discord-codex -c "$PWD" 'npm start; exec bash'
printf 'Started. Attach with: tmux attach -t discord-codex\nDetach with Ctrl-b, then d.\n'
