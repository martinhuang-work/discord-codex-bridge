# Discord Codex bridge

Mention the bot in Discord, get a reply in the same channel or thread, and keep
asking follow-up questions. Each channel and thread has its own saved Codex
conversation. You can also give it a project summary in a private text file.

The bot runs on your Linux machine or VPS and uses your own Codex CLI login with
ChatGPT. It does not use an API key. Your plan's usage limits still apply. This is
an unofficial project; it is not affiliated with OpenAI or Discord.

This release is for a small group of trusted users. It supports text questions
and optional web search. Local commands, browser control, plugins, and connected
apps are disabled. Read [Security](SECURITY.md) before letting others use it.

## Requirements

- Linux with Node.js 22.12 or later, npm, and GNU tar. CI targets Node 22 and 24.
- Codex CLI **0.163.0**, signed into an account with Codex access. The bot checks
  this exact version because its permissions and tool settings were tested with it.
- A Discord application with a bot, and permission to add it to your server.
- tmux for a terminal session, or systemd for a service that restarts after a reboot.

Discord does not need to be installed on the host. The bot makes outbound
connections; it does not need an open inbound port.

## Create the Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications),
   create an application, and open its **Bot** page.
2. Copy the bot token into your local `.env` when you reach the next section.
   Treat it like a password. Keep **Public Bot** off if only you should invite it.
3. Under **OAuth2 > URL Generator**, select the `bot` scope. Grant only:
   View Channels, Send Messages, Send Messages in Threads, Read Message History,
   and Attach Files. Open the generated URL and add the bot to your server.
4. Give it access to the private channels you plan to use. Invite it separately
   to private threads where it is needed.
5. Enable Developer Mode in Discord's advanced settings. Right-click your user,
   server, and target channel to copy their IDs.

The bot does not need Administrator or privileged Message Content Intent. It
receives the content of messages that mention its bot account.

## Set up the host

Use a dedicated Linux account for a deployment that will stay online. The
[service guide](docs/deployment.md) includes that setup. For a local trial, run
these commands from the project directory:

```bash
npm ci --ignore-scripts
npm install --global @openai/codex@0.163.0
codex login --device-auth
cp .env.example .env
chmod 600 .env
nano .env
```

Fill in all four required values from [.env.example](.env.example):

| Setting | Value |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Your bot token |
| `DISCORD_ALLOWED_USER_IDS` | Users who may ask questions |
| `DISCORD_ALLOWED_GUILD_IDS` | Servers where the bot may answer |
| `DISCORD_ALLOWED_CHANNEL_IDS` | Channels or threads where it may answer |

Lists accept comma-separated IDs. Empty lists stop startup. An allowed channel
also allows its child threads. Everyone who can read a channel can read the
answers posted there, even if they are not on the user list.

Web search is off by default. For current research, add `CODEX_WEB_SEARCH=live`
to `.env`. Search queries may include details from the question or context.
Leave it off for material that should not be used in web queries.

Check the setup and start the bot:

```bash
npm run check
node scripts/check-sandbox.js
npm start
```

The setup check verifies your login and Discord token without sending a message.
The sandbox check uses temporary test files and a local listener. It does not
contact the model or read your credentials. Fix a failed check before deployment;
do not switch to full-access mode to get around it.

For tmux:

```bash
bash start-tmux.sh
tmux attach -t discord-codex
```

Detach with **Ctrl-b**, then **d**. SSH can disconnect while the bot keeps running.
Use `bash restart-tmux.sh` after changing `.env` or the code. It waits for the old
process to stop and refuses to interrupt an active Codex request. Tmux does not
restart the bot after a VPS reboot; use the systemd setup for that.

## Ask questions

Select the bot account from Discord's mention picker, then send a message:

```text
@Codex What should we work on next?
```

Mention it on every follow-up. Tagging its role, replying without a mention, or
sending a DM will not start a Codex request.

| Command | What it does |
| --- | --- |
| `@Codex !help` | Show the available commands |
| `@Codex !new` | Start a fresh conversation on the next question |
| `@Codex !session` | Show this conversation's local Codex session ID |
| `@Codex !context research` | Use `research.txt` from the private context directory |
| `@Codex !context` | Check whether the selected context is ready |
| `@Codex !context off` | Remove the context selection and start fresh |

A thread has a separate conversation from its parent channel. Users in the same
channel share that channel's conversation. The bot forwards only the mentioned
message and its attachment URLs. It does not copy channel history, quoted reply
text, or the contents of uploaded files. Long answers arrive as a text attachment.

## Add project context

Create a summary using [the example](examples/research.txt), or ask an existing
chat to summarize your criteria, decisions, previous findings, and next step.
Do not include tokens, passwords, or material you cannot share in the target
Discord channel.

```bash
mkdir -p data/contexts
chmod 700 data data/contexts
install -m 600 examples/research.txt data/contexts/research.txt
nano data/contexts/research.txt
```

Run the `install` command only when creating a new summary; it replaces an
existing file. If `BRIDGE_DATA_DIR` is set, use that directory instead of `data`.
Then send `@Codex !context research` in the channel or thread you want to use.

Use lowercase names made from letters, numbers, and hyphens, up to 48 characters.
The bot accepts regular `.txt` files up to 64 KiB and rejects symlinks or files
readable by other Linux users. It reloads the file with each question, so edits
need no restart. `!new` keeps the selected context.

This is a manual handoff. It does not attach to a Codex Cloud chat or synchronize
with later changes there. `!new` and `!context off` reset the bridge's selection;
they do not delete the old Codex transcript from disk.

## Limits and troubleshooting

The bot runs one Codex request at a time, with at most 20 pending requests total,
3 per user, and 6 accepted mentions per user per minute. Requests are limited to
8,000 characters. The default timeout is 10 minutes.

- **No reply:** check all three access lists, channel permissions, and that you
  mentioned the bot account. A role mention gets a hint with the correct syntax.
- **Login or version error:** run `codex --version` and `codex login status` as the
  Linux account running the bot. Use the pinned version and a ChatGPT login.
- **Context error:** check the file name, its 0600 permissions, and the directory's
  0700 permissions. An empty file cannot start a request.
- **Lock error:** stop the service or tmux worker, then check the PID in
  `data/bot.lock/pid`. Remove a stale lock only after confirming that process is
  gone. Never run two workers against one data directory. An interrupted lock
  recovery can also leave `data/bot.lock-recovery`, which needs the same check.

A restart reports interrupted work instead of submitting it again. Discord
outages retry saved answers without repeating inference. Permanent permission
errors stop delivery; other failures get at most 10 attempts. Pending content is
removed after delivery, abandonment, or 24 hours. The bridge keeps up to 500
completed message records to ignore duplicate events. Messages sent while the
bot is offline are not fetched later.

## Development and releases

```bash
npm ci --ignore-scripts
npm run lint
npm test
npm run security
npm audit --omit=dev
```

These checks do not need real credentials. `npm run smoke` makes two short Codex
requests using your ChatGPT allowance to check session continuity.

See [Contributing](CONTRIBUTING.md) for the code layout and
[Releasing](docs/releasing.md) for creating a package that excludes runtime data.
The project uses the [MIT license](LICENSE).

References: [Codex authentication](https://learn.chatgpt.com/docs/auth),
[non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[permission profiles](https://learn.chatgpt.com/docs/permissions), and
[Discord message content access](https://docs.discord.com/developers/events/gateway#message-content-intent).
