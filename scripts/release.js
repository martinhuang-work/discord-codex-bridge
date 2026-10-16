import { mkdirSync, mkdtempSync, copyFileSync, chmodSync, readFileSync, lstatSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { releaseFiles, scanRelease } from './release-files.js';
import { writePrivateFile } from '../src/private-files.js';

// Package only reviewed paths. A broad copy of a live installation can include
// credentials even when Git ignores them.
try {
  const root = process.cwd();
  const files = releaseFiles(root);
  if (scanRelease(root, files).length) throw new Error('Release scan failed.');
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version.');
  mkdirSync('.release', { recursive: true, mode: 0o700 });
  if (!lstatSync('.release').isDirectory() || lstatSync('.release').isSymbolicLink()) throw new Error('Invalid release directory.');
  const build = mkdtempSync(join(root, '.release', 'build-'));
  const name = `discord-codex-bridge-${version}`;
  const source = join(build, name);
  for (const file of files) {
    const destination = join(source, file);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
    copyFileSync(join(root, file), destination);
    chmodSync(destination, file.endsWith('.sh') ? 0o755 : 0o644);
  }
  if (scanRelease(source, releaseFiles(source)).length) throw new Error('Packaged source scan failed.');
  const archive = join(root, '.release', `${name}.tar.gz`);
  const temporaryArchive = join(build, 'archive.tar.gz');
  execFileSync('tar', ['--create', '--gzip', '--file', temporaryArchive, '--sort=name', '--mtime=@0',
    '--owner=0', '--group=0', '--numeric-owner', '-C', build, name]);
  renameSync(temporaryArchive, archive);
  chmodSync(archive, 0o600);
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  writePrivateFile(`${archive}.sha256`, `${digest}  ${name}.tar.gz\n`);
  console.log(`Created .release/${name}.tar.gz and its SHA-256 checksum from ${files.length} reviewed files.`);
} catch {
  console.error('Release build failed. Run npm run security, check file permissions, and confirm GNU tar is installed.');
  process.exitCode = 1;
}
