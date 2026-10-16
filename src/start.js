import { lstatSync } from 'node:fs';
import { PublicError, publicMessage, errorCode } from './errors.js';

process.umask(0o077);
try {
  try {
    const env = lstatSync('.env');
    if (!env.isFile() || (env.mode & 0o077)) throw new PublicError('Keep .env private: use a regular file and run chmod 600 .env.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await import('./main.js');
} catch (error) {
  console.error(`${publicMessage(error)} (code=${errorCode(error)})`);
  process.exitCode = 1;
}
