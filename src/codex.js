import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, dirname, delimiter, isAbsolute } from 'node:path';
import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { readPrivateFile, privateDirectory } from './private-files.js';
import { PublicError } from './errors.js';

const execFileAsync = promisify(execFile);

export function codexEnvironment(source = process.env) {
  // Allow only login-location, executable discovery, locale, and TLS/proxy
  // settings. A denylist misses future secrets and injection variables such as
  // NODE_OPTIONS, LD_PRELOAD, BASH_ENV, and SSH_AUTH_SOCK.
  const allowed = ['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'CODEX_HOME',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE'];
  return Object.fromEntries(allowed.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}

export const supportedCodexVersion = '0.163.0';

export function codexReadPaths(executable) {
  const found = isAbsolute(executable) || executable.includes('/') ? executable
    : (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, executable)).find(path => existsSync(path));
  if (!found) throw new PublicError('Codex executable was not found. Check CODEX_BIN and PATH.');
  const real = realpathSync(found);
  const packageRoot = dirname(dirname(real));
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    // The npm launcher reexecutes a bundled native helper inside the sandbox.
    // Home-directory installs need access to this package, not the whole home.
    if (manifest.name === '@openai/codex') return [packageRoot];
  } catch { /* Standalone binaries need only their executable path. */ }
  return [real];
}

export function securityArgs(readPaths = []) {
  const filesystem = ['":root"="deny"', '":minimal"="read"', '":workspace_roots"="read"',
    ...readPaths.map(path => `${JSON.stringify(path)}="read"`)].join(',');
  const settings = [
    'forced_login_method="chatgpt"', 'model_provider="openai"', 'approval_policy="never"',
    'default_permissions="discord-bridge"',
    `permissions.discord-bridge.filesystem={${filesystem}}`,
    'permissions.discord-bridge.network.enabled=false',
    'shell_environment_policy.inherit="none"', 'project_doc_max_bytes=0',
    'project_doc_fallback_filenames=[]', 'mcp_servers={}', 'notify=[]', 'apps._default.enabled=false',
  ];
  // This bot handles text and optional hosted web search. Local execution and
  // connected-account actions are deliberately unavailable, even on follow-ups.
  // Pin the tested CLI version: newly introduced tool surfaces need review.
  const disabled = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'hooks',
    'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access',
    'computer_use', 'in_app_browser', 'in_app_local_automation', 'image_generation', 'view_image',
    'memories', 'shell_snapshot', 'skill_search', 'code_mode', 'daemon_auto_start', 'use_legacy_landlock'];
  for (const feature of disabled) settings.push(`features.${feature}=false`);
  settings.push('features.skip_host_skill_discovery=true');
  // Hosted web tools use the JavaScript tool dispatcher. It does not grant
  // shell access; shell_tool and unified_exec remain disabled above.
  settings.push('features.code_mode_host=true');
  return settings.flatMap(setting => ['-c', setting]);
}

export function codexArgs({ sessionId, outputPath, model, webSearch, readPaths }) {
  if (sessionId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId)) throw new PublicError('Invalid saved session. Use !new to start a fresh conversation.');
  const args = ['exec'];
  if (sessionId) args.push('resume', sessionId);
  args.push('--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--json',
    ...securityArgs(readPaths), '--output-last-message', outputPath);
  if (model) args.push('--model', model);
  webSearch ??= 'disabled';
  if (!['live', 'cached', 'disabled'].includes(webSearch)) throw new PublicError('Invalid web search mode.');
  args.push('-c', `web_search="${webSearch}"`);
  args.push('-');
  return args;
}

export async function checkLogin(codexBin) {
  try {
    const options = { env: codexEnvironment(), timeout: 15000, maxBuffer: 64 * 1024 };
    const version = await execFileAsync(codexBin, ['--version'], options);
    if (version.stdout.trim() !== `codex-cli ${supportedCodexVersion}`) {
      throw new PublicError(`This release requires Codex CLI ${supportedCodexVersion}, whose security flags have been tested.`);
    }
    const { stdout, stderr } = await execFileAsync(codexBin,
      ['-c', 'forced_login_method="chatgpt"', 'login', 'status'], options);
    if (!/Logged in using ChatGPT/i.test(stdout + stderr)) throw new Error('Wrong authentication mode.');
  } catch (error) {
    if (error instanceof PublicError) throw error;
    throw new PublicError('Check that Codex is installed, then sign in with ChatGPT: codex login --device-auth');
  }
}

export class CodexRunner {
  constructor(config) { this.config = config; this.active = new Set(); }

  async run({ sessionId, key, prompt, onSession, webSearch }) {
    if (!/^[\w-]{1,100}$/.test(key)) throw new PublicError('Invalid conversation identifier.');
    if (Buffer.byteLength(prompt) > 96 * 1024) throw new PublicError('The combined request and context are too large.');
    const cwd = join(this.config.dataDir, 'workspaces', key);
    privateDirectory(cwd);
    const runDir = await mkdtemp(join(this.config.dataDir, 'run-'));
    const outputPath = join(runDir, 'answer.txt');
    try {
      await writeFile(outputPath, '', { flag: 'wx', mode: 0o600 });
      return await this.execute({ cwd, outputPath, sessionId, prompt, onSession, webSearch: webSearch ?? this.config.webSearch });
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  }

  async execute({ cwd, outputPath, sessionId, prompt, onSession, webSearch }) {
    const child = spawn(this.config.codexBin, codexArgs({ sessionId, outputPath, model: this.config.model, webSearch,
      readPaths: codexReadPaths(this.config.codexBin) }), {
      cwd, env: codexEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
    this.active.add(child);
    let completed = false;
    let failed = false;
    let timedOut = false;
    let oversized = false;
    let outputBytes = 0;
    const itemTypes = new Set();
    let callbackError;
    const countOutput = chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 8 * 1024 * 1024 && !oversized) {
        oversized = true;
        child.stdout.destroy();
        this.stop(child);
      }
    };
    child.stdout.on('data', countOutput);
    child.stderr.on('data', countOutput);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (typeof event.item?.type === 'string') itemTypes.add(event.item.type);
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        sessionId = event.thread_id;
        try { onSession?.(sessionId); }
        catch (error) { callbackError = error; this.stop(child); }
      }
      if (event.type === 'turn.completed') completed = true;
      if (event.type === 'turn.failed') failed = true;
    });
    // Drain diagnostics without forwarding tool output, prompts, or credentials.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    const timer = setTimeout(() => { timedOut = true; this.stop(child); }, this.config.timeoutMs);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      if (callbackError) throw callbackError;
      if (timedOut) throw new PublicError('Codex timed out. Try a shorter request.');
      if (oversized) throw new PublicError('Codex produced too much output. Try a shorter request.');
      if (code !== 0 || failed || !completed) {
        throw new PublicError('Codex could not finish. Check the ChatGPT login, plan usage limits, and Codex configuration on the server.');
      }
      let answer;
      try { answer = readPrivateFile(outputPath, 256 * 1024).trim(); }
      catch { throw new PublicError('Codex returned an invalid or oversized answer. Try a shorter request.'); }
      if (!answer) throw new PublicError('Codex finished without a text answer. Please try again.');
      return { answer, sessionId, itemTypes: [...itemTypes] };
    } finally {
      clearTimeout(timer);
      lines.close();
      this.active.delete(child);
    }
  }

  stop(child) {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
    timer.unref();
    // Keep the group deadline even if the parent exits first: a child process
    // may ignore SIGTERM and otherwise outlive the request.
  }
  stopAll() { for (const child of this.active) this.stop(child); }
}
