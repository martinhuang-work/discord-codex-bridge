import { readFileSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';

export function releaseFiles(root) {
  const files = JSON.parse(readFileSync(join(root, 'release-files.json'), 'utf8'));
  if (!Array.isArray(files) || new Set(files).size !== files.length) throw new Error('Invalid release file list.');
  for (const file of files) {
    const parts = typeof file === 'string' ? file.split('/') : [];
    if (!parts.length || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')
      || /(^|\/)(data|node_modules|\.git|\.release|\.codex|\.aws|\.ssh)(\/|$)/.test(file)
      || (parts.some(part => part.startsWith('.env')) && file !== '.env.example')) {
      throw new Error('Release file list contains a forbidden path.');
    }
    let path = resolve(root);
    for (let index = 0; index < parts.length; index++) {
      path = join(path, parts[index]);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
        throw new Error(`Release entry must be a regular file without symlinks: ${file}`);
      }
      if (index === parts.length - 1 && stat.size > 1024 * 1024) throw new Error(`Unexpectedly large release file: ${file}`);
    }
  }
  return files;
}

export function scanRelease(root, files, environment = process.env) {
  // Match common credentials, real Discord IDs, and personal home paths. Test
  // IDs use one repeated digit so they cannot be confused with an account ID.
  const patterns = [
    ['private key', new RegExp('-----BEGIN [A-Z ]*' + 'PRIVATE KEY-----')],
    ['API credential', new RegExp('\\b(?:sk-' + '(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{30,})')],
    ['Discord credential', new RegExp('\\b[A-Za-z0-9_-]{23,30}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{25,}\\b')],
    ['personal home path', /\/(?:home|Users)\/(?!example(?:[/'"\s]|$)|test(?:[/'"\s]|$))[a-z][a-z0-9_-]+/i],
    ['Discord ID', /\b(?!([0-9])\1{16,19}\b)[0-9]{17,20}\b/],
  ];
  // When invoked with --env-file, also compare against the actual local secret
  // without logging it. CI does not need deployment credentials for this check.
  const secrets = Object.entries(environment)
    .filter(([key, value]) => /(?:TOKEN|SECRET|PASSWORD|API_KEY|ALLOWED_.*_IDS)$/.test(key) && value?.length >= 8)
    .flatMap(([key, value]) => key.endsWith('_IDS') ? value.split(/[\s,]+/).filter(Boolean) : [value]);
  const findings = [];
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const [label, pattern] of patterns) if (pattern.test(text)) findings.push(`${file}: ${label}`);
    if (secrets.some(secret => text.includes(secret))) findings.push(`${file}: configured private value`);
    if (file === '.env.example' && /^DISCORD_[A-Z_]+=(?!""\s*$).+/m.test(text)) findings.push(`${file}: populated Discord setting`);
  }
  return findings;
}
