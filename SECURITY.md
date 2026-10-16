# Security

Run this bot for users you trust, under a dedicated Linux account on a machine
without unrelated credentials. It uses that account's Codex login and can spend
its subscription allowance. It is not designed to serve untrusted public users.
No test suite can establish that an application has zero security risk.

## Access and tools

Every request must come from an allowed human user, in an allowed server and
channel. DMs, webhooks, other bots, and messages without an explicit mention are
ignored. An allowed parent channel also permits its threads. Pending jobs are
checked against the current lists again after a restart and before delivery.

All allowed users must be trusted with the bot's available context files. A
separate conversation per channel is not a separate user account or a permission
boundary between those files. Use separate installations and Linux accounts
when different users need different access.

The Codex subprocess receives a short list of environment variables needed for
its executable, login location, locale, and TLS/proxy configuration. Discord
credentials, API keys, cloud credentials, agent sockets, and shell injection
variables are not forwarded. The bot forces ChatGPT authentication and ignores
user configuration and execution-policy rules.

The tested CLI settings disable local command execution, plugins, connected
apps, browser and computer control, image tools, hooks, and subagents. A separate
filesystem profile denies reads outside the current workspace except the
platform's minimal runtime files and the Codex installation. It allows no writes
or command network access. Hosted web search is a separate capability, disabled
by default and controlled through `CODEX_WEB_SEARCH`.

Permission profiles are a beta Codex feature. This release requires CLI 0.163.0
and checks the version at startup. Review the tool settings and rerun the sandbox
and live tests before supporting another version. Do not add full-access mode,
API-key fallback, or an automatic approval bypass to fix a startup failure.
Administrator-managed Codex policies and a compromised host can change the
security assumptions; use a clean, controlled deployment.

## Where data goes

Your messages and selected context go to Codex. Replies go to the originating
Discord channel or thread. Anyone with read access there can see them. The bot
turns off reply pings and link previews, but it does not inspect every link the
model returns. Be careful about following links or instructions from a reply.

If web search is enabled, the model may use prompt or context details in search
queries. Public web content can contain malicious instructions. Disabling local
tools reduces what those instructions can do, but does not prevent every form of
information disclosure or an incorrect answer. Keep secrets out of prompts and
context files.

Private files include `.env`, everything under `BRIDGE_DATA_DIR`, and Codex's
account and session storage. The bridge uses 0700 directories and 0600 files.
State contains session mappings, selected context names, and pending messages or
answers. Completed records retain routing metadata and message IDs for duplicate
suppression; message text and answers are removed. Failed jobs are discarded
after 10 delivery attempts or 24 hours. Codex keeps its own transcripts separately.
Resetting a bridge session does not erase those transcripts or Discord messages.

Normal logs report status and error codes without tokens, prompts, answers, or
Discord identifiers. Do not post `.env`, state files, Codex logs, context files,
or unreviewed terminal captures in a public issue. Backups of these files need
the same protection as the running installation.

## Releases

The release script copies only paths in `release-files.json`. It rejects symlinks,
private directories, populated Discord settings in `.env.example`, common token
formats, personal home paths, and non-example Discord IDs. When run with the local
`.env` loaded, it also checks for the configured token and IDs without printing
them. These scans cannot identify every possible secret or sensitive passage;
review the file list and archive before publishing.

Dependencies are locked. Install them with `npm ci --ignore-scripts`, run the
dependency audit, and review updates before deployment. GitHub Actions use pinned
commits, read-only repository permissions, and no deployment credentials.

## Reporting a problem

Use the repository's private vulnerability-reporting feature if it is enabled.
Otherwise, open an issue asking for a private reporting channel without including
the vulnerability details or any credentials. Give a minimal reproduction using
synthetic values.

If a bot token is exposed, reset it in the Discord Developer Portal, update the
server's `.env`, and restart the bot. If Codex login data is exposed, revoke the
affected login through your account controls and sign in again. Deleting a public
file does not remove copies or Git history.
