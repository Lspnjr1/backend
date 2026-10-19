import { describe, it, expect } from 'vitest';
import { resolveToUtc, formatInTimezone, InvalidTimezoneError } from '../timezone';

describe('resolveToUtc (issue #216)', () => {
  it('interprets a bare datetime with no timezone as UTC', () => {
    expect(resolveToUtc('2026-01-15T00:00:00').toISOString()).toBe('2026-01-15T00:00:00.000Z');
  });

  it('interprets a bare date-only value with no timezone as UTC midnight', () => {
    expect(resolveToUtc('2026-01-15').toISOString()).toBe('2026-01-15T00:00:00.000Z');
  });

  it('resolves a bare datetime against the given IANA timezone', () => {
    expect(resolveToUtc('2026-01-15T00:00:00', 'America/New_York').toISOString()).toBe(
      '2026-01-15T05:00:00.000Z'
    );
  });

  it('resolves a bare date-only value against the given IANA timezone', () => {
    expect(resolveToUtc('2026-01-15', 'America/New_York').toISOString()).toBe(
      '2026-01-15T05:00:00.000Z'
    );
  });

  it('accounts for daylight saving time (summer offset differs from winter)', () => {
    expect(resolveToUtc('2026-07-15T00:00:00', 'America/New_York').toISOString()).toBe(
      '2026-07-15T04:00:00.000Z'
    );
    expect(resolveToUtc('2026-01-15T00:00:00', 'America/New_York').toISOString()).toBe(
      '2026-01-15T05:00:00.000Z'
    );
  });

  it('ignores the timezone hint when the value already has an explicit Z offset', () => {
    expect(resolveToUtc('2026-01-15T00:00:00Z', 'America/New_York').toISOString()).toBe(
      '2026-01-15T00:00:00.000Z'
    );
  });

  it('ignores the timezone hint when the value already has an explicit numeric offset', () => {
    expect(resolveToUtc('2026-01-15T00:00:00-05:00', 'Asia/Tokyo').toISOString()).toBe(
      '2026-01-15T05:00:00.000Z'
    );
  });

  it('handles a positive-offset timezone (ahead of UTC)', () => {
    expect(resolveToUtc('2026-01-15T00:00:00', 'Asia/Tokyo').toISOString()).toBe(
      '2026-01-14T15:00:00.000Z'
    );
  });

  it('rejects an unrecognized IANA timezone', () => {
    expect(() => resolveToUtc('2026-01-15T00:00:00', 'Not/AZone')).toThrow(InvalidTimezoneError);
  });
});

describe('formatInTimezone (issue #216)', () => {
  const instant = new Date('2026-01-15T05:00:00Z');

  it('returns the plain UTC ISO string when no timezone is given', () => {
    expect(formatInTimezone(instant)).toBe('2026-01-15T05:00:00.000Z');
  });

  it("formats with the requested timezone's offset", () => {
    expect(formatInTimezone(instant, 'America/New_York')).toBe('2026-01-15T00:00:00-05:00');
  });

  it('formats a positive-offset timezone correctly', () => {
    expect(formatInTimezone(instant, 'Asia/Tokyo')).toBe('2026-01-15T14:00:00+09:00');
  });

  it('round-trips through resolveToUtc and back for the same timezone', () => {
    // 2026-03-10 is already past that year's US DST start (March 8), so
    // America/New_York is at its summer offset (EDT, -04:00) here.
    const resolved = resolveToUtc('2026-03-10T09:30:00', 'America/New_York');
    const formatted = formatInTimezone(resolved, 'America/New_York');
    expect(formatted).toBe('2026-03-10T09:30:00-04:00');
  });

  it('rejects an unrecognized IANA timezone', () => {
    expect(() => formatInTimezone(instant, 'Not/AZone')).toThrow(InvalidTimezoneError);
  });
});
