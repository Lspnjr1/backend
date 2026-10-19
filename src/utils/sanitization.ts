import { MEMO_MAX_LENGTH } from '../lib/stellar/validation';

/**
 * Centralized text sanitization for user-provided fields.
 *
 * The backend must never trust client-side escaping: any string that can be
 * stored and later rendered (tip messages, creator bios, team names/descriptions,
 * memos included in emails/webhooks) is stripped of HTML and dangerous scripts
 * at the validation boundary, then truncated to its documented maximum length
 * before it ever reaches the database.
 *
 * This implementation is DOM-free so it runs safely in Node without a browser
 * or jsdom dependency; it is the "similar" alternative to DOMPurify called out
 * in the issue.
 */

// Control characters that have no place in user input (allows \t \n \r).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// Matches opening/closing HTML tags, including self-closing and void tags.
const HTML_TAGS = /<\/?[a-z][a-z0-9]*[^>]*>/gi;
// Dangerous URL schemes that can execute script when rendered as a link.
const DANGEROUS_SCHEMES = /(javascript|vbscript|data)\s*:/gi;
// Inline event handler attributes (onclick=, onerror=, onload=, ...).
const EVENT_HANDLERS = /\bon[a-z]+\s*=/gi;

/** Documented maximum lengths for user-provided text fields. */
export const TEXT_LIMITS = {
  /** Tip message / description. */
  TIP_MESSAGE: 500,
  /** Creator biography. */
  BIO: 500,
  /** Team name. */
  TEAM_NAME: 60,
  /** Team description. */
  TEAM_DESCRIPTION: 280,
  /** Stellar text memo, enforced as UTF-8 bytes elsewhere. */
  MEMO: MEMO_MAX_LENGTH,
} as const;

/**
 * Strips HTML tags, dangerous URL schemes, inline event handlers and control
 * characters from `text`, returning plain text. Leading/trailing whitespace is
 * trimmed. Internal whitespace is preserved.
 */
export function stripHtml(text: unknown): string {
  if (typeof text !== 'string') {
    return String(text ?? '');
  }

  let value = text.replace(CONTROL_CHARS, '');
  value = value.replace(HTML_TAGS, '');
  value = value.replace(DANGEROUS_SCHEMES, '');
  value = value.replace(EVENT_HANDLERS, '');

  return value.trim();
}

/**
 * Truncates `text` to `maxLength` characters. Returns the input unchanged when
 * it is already within the limit.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}

export interface SanitizeTextOptions {
  /** Maximum length (characters) to truncate to. */
  maxLength?: number;
  /** Collapse runs of whitespace (including newlines) into single spaces. */
  collapseWhitespace?: boolean;
}

/**
 * Sanitizes user-provided text: strips HTML/dangerous content, trims, optionally
 * collapses whitespace, and truncates to `maxLength`. This is the function used
 * at the schema boundary so only cleaned text is stored.
 */
export function sanitizeText(text: unknown, options: SanitizeTextOptions = {}): string {
  const { maxLength, collapseWhitespace = false } = options;
  let value = stripHtml(text);

  if (collapseWhitespace) {
    value = value.replace(/\s+/g, ' ');
  }

  value = value.trim();

  if (typeof maxLength === 'number') {
    value = truncate(value, maxLength);
  }

  return value;
}
