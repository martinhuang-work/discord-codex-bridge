// Only deliberately written messages may leave the process. Library exceptions
// can contain request bodies, paths, or credentials and must stay out of Discord.
export class PublicError extends Error {}

export function publicMessage(error) {
  return error instanceof PublicError ? error.message : 'The request could not finish. Check the bot on the server and try again.';
}

export function errorCode(error) {
  const code = String(error?.code ?? 'unknown');
  return /^[A-Za-z0-9_-]{1,40}$/.test(code) ? code : 'unknown';
}
