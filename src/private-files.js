import { constants, openSync, closeSync, fstatSync, readSync, mkdirSync, lstatSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
    throw new Error('Private directory must be a real directory with mode 0700.');
  }
}

// Open first, then inspect the same descriptor: a symlink or a swapped path must
// never turn a context/state read into a read of an unrelated file. NONBLOCK also
// avoids hanging on a FIFO before fstat can reject it.
export function readPrivateFile(path, maxBytes) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('Private file must be a regular file with mode 0600.');
    if (stat.size > maxBytes) throw Object.assign(new Error('Private file exceeds its size limit.'), { code: 'EFBIG' });
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytes = readSync(fd, buffer, length, buffer.length - length, null);
      if (!bytes) break;
      length += bytes;
    }
    if (length > maxBytes) throw Object.assign(new Error('Private file exceeds its size limit.'), { code: 'EFBIG' });
    return buffer.subarray(0, length).toString('utf8');
  } finally { closeSync(fd); }
}

export function writePrivateFile(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
    renameSync(temporary, path);
  } finally {
    closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
