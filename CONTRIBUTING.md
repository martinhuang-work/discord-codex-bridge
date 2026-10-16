# Contributing

Keep changes small enough to review. Describe the problem, the resulting behavior,
and how you checked it. Use plain comments that explain a decision or an edge case.
Avoid comments that just repeat the next line of code.

## Local checks

Use Node 22 or 24 on Linux:

```bash
npm ci --ignore-scripts
npm run lint
npm test
npm run security
```

The tests use fake runners and temporary files. They need no Discord token,
ChatGPT login, or network access. Add a regression test when changing access
checks, retries, persistence, private file handling, or subprocess control.

`node scripts/check-sandbox.js` tests the installed Codex sandbox with synthetic
files. `npm run smoke` checks real session continuity and uses a small amount of
the signed-in account's allowance. Keep these checks outside CI jobs that accept
untrusted contributions.

## Code layout

| File | Responsibility |
| --- | --- |
| `src/config.js` | Validate settings and check access lists |
| `src/bridge.js` | Parse mentions, queue requests, and deliver answers |
| `src/codex.js` | Start and stop Codex with the tested restrictions |
| `src/contexts.js` | Load a selected project summary |
| `src/store.js` | Save state and remove completed message content |
| `src/private-files.js` | Read and replace private files safely |
| `src/lock.js` | Keep one worker per data directory |
| `src/main.js` | Connect the worker to Discord |
| `scripts/release-files.js` | Validate and scan release files |

## Changes that need extra review

Adding a tool, allowing another environment variable, changing a directory rule,
or upgrading Codex can expand what a Discord request can access. Explain why the
new access is necessary, update SECURITY.md, and rerun the sandbox and live checks.
Keep the exact Codex version check until the new version has been reviewed.

Never include real tokens, IDs, context summaries, or transcripts in examples or
tests. Test Discord IDs use one digit repeated 18 times. Update
`release-files.json` when adding a file that belongs in a release.

Use a short commit subject that says what changed, such as:

```text
Reject context files that are readable by other users
```

Pull requests should include the relevant test result and any remaining limitation.
