# Run as a systemd service

Use a dedicated Linux account so the bot does not share a home directory with
SSH keys, other projects, or unrelated account credentials. These instructions
assume Node is at `/usr/bin/node`, Codex is installed system-wide, and systemd is
available. Check the paths on your host before installing the service.

## Create the account and directories

Run as an administrator:

```bash
sudo useradd --system --user-group --create-home --home-dir /var/lib/discord-codex --shell /usr/sbin/nologin discord-codex
sudo chmod 700 /var/lib/discord-codex
sudo install -d -o root -g root -m 755 /opt/discord-codex-bridge
sudo npm install --global @openai/codex@0.163.0
```

Extract the reviewed release into `/opt/discord-codex-bridge`. The source files
should be owned by root and readable by the service account. Do not copy `.env`,
`data`, or an existing Codex home from a live installation into the source tree.

```bash
cd /opt/discord-codex-bridge
sudo npm ci --omit=dev --ignore-scripts
sudo install -o root -g root -m 600 .env.example /etc/discord-codex-bridge.env
sudoedit /etc/discord-codex-bridge.env
```

Fill in the token and all three access lists. Leave `BRIDGE_DATA_DIR` unset in
this file; the service sets it to `/var/lib/discord-codex/data`. Keep the other
optional values only if you need them. Systemd's environment file does not expand
shell variables, so use complete paths for `CODEX_BIN` if you set it.

## Sign in and check the sandbox

Run Codex as the service account so it saves the login in the correct home:

```bash
sudo -u discord-codex -H codex login --device-auth
sudo -u discord-codex -H codex login status
sudo -u discord-codex -H node scripts/check-sandbox.js
```

Follow the device-login instructions in your browser using your own ChatGPT
account. No API key is required. A login may need renewal later; the bot will
report a failed request if it cannot authenticate.

The sandbox check must pass. User namespaces and the sandbox helper must work on
this host. Do not disable the sandbox or change the permission profile to work
around a failure.

## Start the service

Review [the unit file](../deploy/discord-codex-bridge.service), adjust executable
paths if needed, then install it:

```bash
sudo install -m 644 deploy/discord-codex-bridge.service /etc/systemd/system/discord-codex-bridge.service
sudo systemd-analyze verify /etc/systemd/system/discord-codex-bridge.service
sudo systemctl daemon-reload
sudo systemctl enable --now discord-codex-bridge
sudo systemctl status discord-codex-bridge
sudo journalctl -u discord-codex-bridge -n 30 --no-pager
```

Look for `Discord connected`. Test a mention from an allowed account in an
allowed private channel. Do not run the tmux worker alongside this service.

The unit limits writes to the service home, protects other users' homes, and
restarts on failure. It limits memory to 1 GiB and the process count to 128. Check
these limits under your own workload; a killed request is reported as interrupted
after restart. The unit is a deployment example. Verify it on your distribution
before depending on it unattended.

## Context and updates

Store summaries in `/var/lib/discord-codex/data/contexts`, owned by `discord-codex`,
with mode 0600. The directory must have mode 0700. Use the same context commands
as the terminal deployment.

Before updating, wait for active work to finish, then stop the service:

```bash
sudo systemctl stop discord-codex-bridge
```

Back up the private data directory and Codex home to a protected location. Replace
the source files with the reviewed release, run `npm ci --omit=dev --ignore-scripts`,
and read the changelog for migration steps. Preserve the private environment file
and account home. Check the sandbox again, then restart:

```bash
sudo systemctl start discord-codex-bridge
sudo systemctl status discord-codex-bridge
```

Changing a summary needs no restart. Changing environment settings does. If a
service stops repeatedly, inspect its status and fix the cause before resetting
the restart limit with `systemctl reset-failed`.
