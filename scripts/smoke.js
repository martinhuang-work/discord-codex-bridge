import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { CodexRunner, checkLogin } from '../src/codex.js';
import { PublicError, publicMessage } from '../src/errors.js';

process.umask(0o077);
try {
  const dataDir = resolve('data/smoke');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const codexBin = process.env.CODEX_BIN || 'codex';
  await checkLogin(codexBin);
  const runner = new CodexRunner({ dataDir, codexBin, timeoutMs: 90000 });
  if (!process.argv.includes('--search-only')) {
    const marker = randomBytes(5).toString('hex');
    let sessionId;
    const first = await runner.run({ key: 'smoke',
      prompt: `Remember the marker ${marker}. Reply with exactly READY and do not use tools.`,
      onSession: id => sessionId = id });
    if (!sessionId || !first.answer.includes('READY')) throw new PublicError('New session check failed.');
    const second = await runner.run({ key: 'smoke', sessionId,
      prompt: 'Reply with only the marker I asked you to remember. Do not use tools.' });
    if (!second.answer.includes(marker) || second.sessionId !== sessionId) throw new PublicError('Follow-up check failed.');
    console.log('Live Codex check passed: ChatGPT login, new session, final answer, and follow-up context.');
  }
  if (process.argv.includes('--search') || process.argv.includes('--search-only')) {
    const search = await runner.run({ key: 'search-smoke', webSearch: 'live',
      prompt: 'Use web search to find the official OpenAI documentation for Codex CLI. Reply with the official documentation link and one sentence. Do not use any other tools.' });
    if (!search.itemTypes.includes('web_search') || !/https:\/\/(?:learn\.chatgpt\.com|developers\.openai\.com)\//.test(search.answer)) {
      const types = search.itemTypes.filter(type => /^[a-z_]{1,40}$/.test(type));
      throw new PublicError(`Live web-search check failed. Item types: ${types.join(', ') || 'none'}.`);
    }
    console.log('Live hosted web-search check passed.');
  }
} catch (error) {
  console.error(`Live Codex check failed: ${publicMessage(error)}`);
  process.exitCode = 1;
}
