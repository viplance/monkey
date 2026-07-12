/**
 * Shared credential-shaped-text detection, used on both sides: the content
 * script redacts matches out of page text before it ever leaves the page
 * context (snapshot's textExcerpt), and the background worker uses the same
 * pattern to flag extracted text that looks credential-shaped. One pattern in
 * one place so the two checks can't drift apart.
 */

const CREDENTIAL_KEY_RE =
  /(password|passwd|api[_-]?key|secret[_-]?key|access[_-]?token|auth(?:orization)?[_-]?token|client[_-]?secret|private[_-]?key)(\s*[:=]\s*)(\S+)/gi;
const BEARER_RE = /(bearer\s+)([a-z0-9._-]{10,})/gi;

/** True if `text` contains a `key: value` / `key=value` pair or bearer token that looks like a credential. */
export function looksLikeCredentialContent(text: string): boolean {
  CREDENTIAL_KEY_RE.lastIndex = 0;
  BEARER_RE.lastIndex = 0;
  return CREDENTIAL_KEY_RE.test(text) || BEARER_RE.test(text);
}

/** Replace the value half of any credential-shaped `key: value` pair or bearer token with a redaction marker. */
export function redactCredentialContent(text: string): string {
  return text
    .replace(CREDENTIAL_KEY_RE, (_m, key, sep) => `${key}${sep}[redacted]`)
    .replace(BEARER_RE, (_m, prefix) => `${prefix}[redacted]`);
}
