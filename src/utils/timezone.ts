/**
 * Timezone conversion helpers for date-range queries (issue #216).
 *
 * Payment/tip date filters accept an optional IANA `timezone` alongside
 * `minDate`/`maxDate`. When a caller sends a bare wall-clock value with no
 * UTC offset (e.g. "2026-01-15T00:00:00" or "2026-01-15"), that value means
 * "midnight in the caller's timezone," not "midnight UTC" — the two can
 * differ by up to 14 hours, which is enough to silently drop or include an
 * extra day's worth of rows at either edge of the requested range. A value
 * that already carries an explicit offset (e.g. "...-05:00" or "...Z") is
 * left untouched: it's unambiguous on its own, and `timezone` only
 * disambiguates what would otherwise be guessed as UTC.
 *
 * No third-party timezone library is used: `Intl.DateTimeFormat` with the
 * requested IANA zone is sufficient for both directions (local -> UTC and
 * UTC -> local) and already ships with Node.
 */

/** Matches a trailing UTC offset ("Z", "+05:00", "-0500") on an ISO string. */
const HAS_EXPLICIT_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

export class InvalidTimezoneError extends Error {}

function assertValidTimezone(timeZone: string): void {
  try {
    Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new InvalidTimezoneError(`Unknown IANA timezone: ${timeZone}`);
  }
}

/**
 * Interpret `dateStr`'s wall-clock components as local time in `timeZone`,
 * returning the equivalent UTC `Date`. If `dateStr` already carries an
 * explicit offset, it is parsed as-is and `timeZone` is not consulted —
 * an explicit offset always wins over an ambient timezone hint.
 */
export function resolveToUtc(dateStr: string, timeZone?: string): Date {
  if (HAS_EXPLICIT_OFFSET.test(dateStr)) {
    return new Date(dateStr);
  }
  if (!timeZone) {
    // No offset and no timezone hint: default to UTC, not the server
    // process's local zone — `new Date("2026-01-15T00:00:00")` resolves
    // against `TZ`/the host's local zone, which is exactly the ambiguity
    // this issue exists to remove.
    return new Date(dateStr.includes('T') ? `${dateStr}Z` : `${dateStr}T00:00:00Z`);
  }
  assertValidTimezone(timeZone);

  // Parse the wall-clock components as if they were UTC, then measure how
  // far that guess is from the real offset of `timeZone` at that instant,
  // and correct by the difference.
  const naiveUtc = new Date(dateStr.includes('T') ? `${dateStr}Z` : `${dateStr}T00:00:00Z`);
  if (Number.isNaN(naiveUtc.getTime())) {
    return naiveUtc;
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(naiveUtc).reduce<Record<string, string>>((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  const asUtcIfLocalMatchedWallClock = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const offsetMs = asUtcIfLocalMatchedWallClock - naiveUtc.getTime();
  return new Date(naiveUtc.getTime() - offsetMs);
}

/**
 * Format a UTC `Date` as an ISO-8601-like string with `timeZone`'s wall-clock
 * offset, e.g. "2026-01-15T00:00:00-05:00". Falls back to the plain UTC ISO
 * string when no timezone is requested.
 */
export function formatInTimezone(date: Date, timeZone?: string): string {
  if (!timeZone) return date.toISOString();
  assertValidTimezone(timeZone);

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  const asUtcIfLocalMatchedWallClock = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const offsetMs = asUtcIfLocalMatchedWallClock - date.getTime();
  const sign = offsetMs >= 0 ? '+' : '-';
  const absMinutes = Math.round(Math.abs(offsetMs) / 60_000);
  const offsetHours = String(Math.floor(absMinutes / 60)).padStart(2, '0');
  const offsetMinutes = String(absMinutes % 60).padStart(2, '0');

  return (
    `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}` +
    `${sign}${offsetHours}:${offsetMinutes}`
  );
}
