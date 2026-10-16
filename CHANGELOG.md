# Changelog

## 1.1.0

- Require explicit user, server, and channel access lists.
- Disable Codex command execution and connected-account tools, and limit file
  access to the workspace and runtime files. Require the tested CLI version.
- Keep unrelated secrets and shell injection variables out of the Codex process.
- Add request limits, bounded delivery retries, and expiration for pending content.
- Reject context symlinks, unsafe permissions, and oversized files.
- Replace the project-specific context with named text files and a research example.
- Remove personal IDs and paths from source and examples.
- Add security tests, a sandbox probe, and a release package built from reviewed files.
- Document setup, service deployment, privacy limits, and release checks.

Upgrading clears the bridge's old session mappings once, so conversations started
under the old tool settings are not resumed. Selected context files stay in place.
The next question starts a new session with the current summary. Old Codex
transcripts remain on disk.
