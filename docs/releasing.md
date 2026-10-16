# Prepare a release

Build from `release-files.json`. It lists every file permitted in the package.
Use the resulting archive for a public upload; a live working directory also
contains private files that must stay on the server.

## Check the source

```bash
npm ci --ignore-scripts
npm run lint
npm test
npm run security
npm audit --omit=dev
```

If this checkout has a local `.env`, run an additional scan that compares the
release files against its token and IDs without displaying their values:

```bash
node --env-file=.env scripts/check-release.js
```

Review `release-files.json` and the README examples yourself. The scanner checks
common credential formats, personal home paths, and Discord IDs. It cannot decide
whether an ordinary-looking paragraph contains private business information.

Changes to Codex versions or tool restrictions also require these checks on the
deployment host:

```bash
node scripts/check-sandbox.js
npm run smoke
```

The smoke test uses the account's ChatGPT allowance. It does not send a Discord
message. Add a manual test in a private Discord channel when changing transport
behavior or Discord permissions.

## Build and inspect

```bash
npm run release
```

On a live checkout, use this command instead to include the local-value scan:

```bash
node --env-file=.env scripts/release.js
```

The archive and its SHA-256 checksum are written under `.release`. The archive
contains only reviewed source paths. Its ownership and timestamps are normalized,
so it does not carry the host's username or file modification dates. The script
also leaves a clean source copy under `.release/build-*` for local inspection.

Inspect the archive's file list with `tar -tzf` and extract it into an empty
directory. Run the offline checks from that copy before publishing. It must not
contain `.env`, `data`, `.codex`, logs, credentials, or real context summaries.

## GitHub setup

Create the repository from the clean extracted source. Keep it private while
reviewing the initial commit, then make it public when ready. A suitable first
commit subject is:

```text
Add the Discord Codex bridge with private context support
```

Enable private vulnerability reporting and secret scanning or push protection
where available. Keep the included CI checks enabled. Do not add the bot token,
ChatGPT login, or runtime data as repository files or Actions secrets; the CI
checks do not need them.

This project is configured as a private npm package to prevent accidental npm
publication. That setting does not affect a public GitHub repository. The source
is licensed under MIT.
