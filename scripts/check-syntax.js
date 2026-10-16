import { execFileSync } from 'node:child_process';
import { releaseFiles } from './release-files.js';

try {
  const files = releaseFiles(process.cwd());
  for (const file of files) {
    try {
      if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      if (file.endsWith('.sh')) execFileSync('bash', ['-n', file], { stdio: 'pipe' });
      if (file.endsWith('.json')) JSON.parse((await import('node:fs')).readFileSync(file, 'utf8'));
    } catch { console.error(`Could not check ${file}.`); throw new Error('Syntax check failed.'); }
  }
  console.log('JavaScript, JSON, and shell syntax checks passed.');
} catch {
  console.error('Syntax check failed. Check the source files and release-files.json.');
  process.exitCode = 1;
}
