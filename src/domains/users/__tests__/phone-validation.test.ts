import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { UpdateUserProfileSchema } from '../user.types';

const validCases: Array<[unknown, string]> = [
  ['+14155552671', '+14155552671'], // US, international format
  ['(415) 555-2671', '+14155552671'], // US, local format
  ['415-555-2671', '+14155552671'], // US, local format
  ['+44 7912 345678', '+447912345678'], // UK (EU)
  ['+49 89 123456', '+4989123456'], // Germany (EU)
  ['+81 3-1234-5678', '+81312345678'], // Japan (international)
  ['+55 11 912345678', '+5511912345678'], // Brazil (international)
];

const invalidCases: Array<unknown> = [
  '+1',
  '12345',
  'not-a-phone',
  '',
  '   ',
  '+1234567890123456',
];

describe('phone number validation (#195)', () => {
  it.each(validCases)('accepts and normalizes %s to E.164 %s', (input, expected) => {
    const result = UpdateUserProfileSchema.parse({ phoneNumber: input });
    expect(result.phoneNumber).toBe(expected);
  });

  it.each(invalidCases)('rejects invalid phone number %j', (input) => {
    expect(() => UpdateUserProfileSchema.parse({ phoneNumber: input })).toThrow(ZodError);
  });

  it('leaves the phone number absent when not provided', () => {
    const result = UpdateUserProfileSchema.parse({ name: 'Ada' });
    expect(result.phoneNumber).toBeUndefined();
  });

  it('clears the phone number when null is provided', () => {
    const result = UpdateUserProfileSchema.parse({ phoneNumber: null });
    expect(result.phoneNumber).toBeNull();
  });

  it('rejects empty string instead of treating it as a clear', () => {
    expect(() => UpdateUserProfileSchema.parse({ phoneNumber: '' })).toThrow(ZodError);
  });
});
