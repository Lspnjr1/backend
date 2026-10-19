import { z } from 'zod';
import { parsePhoneNumber } from 'libphonenumber-js';

/**
 * Parses a phone number with libphonenumber-js and returns its E.164
 * international representation (e.g. +14155552671). Numbers without an
 * international prefix are attempted against a default country (US) so
 * familiar local formats such as "(415) 555-2671" also work. Returns null
 * when the value cannot be parsed as a valid phone number.
 */
export const parsePhone = (value: string): string | null => {
  try {
    const phone = parsePhoneNumber(value);
    if (phone?.isValid()) return phone.number;
  } catch {
    // fall through to the default-country attempt below
  }
  try {
    const phone = parsePhoneNumber(value, 'US');
    if (phone?.isValid()) return phone.number;
  } catch {
    // invalid
  }
  return null;
};

/**
 * Validates a phone number with libphonenumber-js and normalizes it to
 * E.164 international format (e.g. +14155552671). An absent or `null` value
 * clears the stored number; an empty string is rejected.
 */
export const phoneSchema = z
  .string()
  .trim()
  .min(1, 'Phone number is required')
  .refine((value) => parsePhone(value) !== null, {
    message: 'Invalid phone number format',
  })
  .transform((value) => parsePhone(value)!)
  .optional()
  .nullable();

export type PhoneNumber = z.infer<typeof phoneSchema>;

/**
 * Profile updates deliberately exclude `email`: the address an account logs in
 * with is security sensitive and may only change through the email
 * verification flow (see `AuthService.sendVerificationEmail`), never a
 * profile PATCH/PUT (#49).
 */
export const UpdateUserProfileSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name must not be empty')
    .max(100, 'Name must be at most 100 characters')
    .optional(),
  bio: z.string().trim().max(500, 'Bio must be at most 500 characters').optional(),
  phoneNumber: phoneSchema,
});

export const UpdateUserSettingsSchema = z.object({
  notificationsEnabled: z.boolean().optional(),
  emailDigest: z.enum(['daily', 'weekly', 'never']).optional(),
});

/**
 * Password change (distinct from the forgot/reset flow): the caller must prove
 * ownership by supplying the current password alongside the new one.
 */
export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z
      .string()
      .min(8, 'New password must be at least 8 characters')
      .max(128, 'New password must be at most 128 characters'),
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'New password must be different from the current password',
    path: ['newPassword'],
  });

/**
 * Shape guard for the avatar payload. The MIME type and decoded size are
 * enforced by `decodeAvatarDataUrl` in `avatar.storage.ts`.
 */
export const UpdateAvatarRequestSchema = z.object({
  image: z.string().min(1, 'Avatar image is required'),
});

export const RequestEmailChangeSchema = z.object({
  newEmail: z.string().trim().email('Invalid email format').toLowerCase(),
});

export const VerifyEmailChangeSchema = z.object({
  token: z.string().trim().min(1, 'Verification token is required'),
});

export type UpdateUserProfileRequest = z.infer<typeof UpdateUserProfileSchema>;
export type UpdateUserSettingsRequest = z.infer<typeof UpdateUserSettingsSchema>;
export type ChangePasswordRequest = z.infer<typeof ChangePasswordSchema>;
export type UpdateAvatarRequest = z.infer<typeof UpdateAvatarRequestSchema>;
export type RequestEmailChangeRequest = z.infer<typeof RequestEmailChangeSchema>;
export type VerifyEmailChangeRequest = z.infer<typeof VerifyEmailChangeSchema>;

export interface UserProfileResponse {
  id: string;
  email: string;
  name: string | null;
  bio: string | null;
  phoneNumber: string | null;
  avatar: string | null;
  role: string;
  verified: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UserSettingsResponse {
  userId: string;
  notificationsEnabled: boolean;
  emailDigest: string;
}

export interface ChangePasswordResponse {
  success: boolean;
  message: string;
}

export interface ProfileChangeResponse {
  id: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  sensitive: boolean;
  createdAt: string;
}

export interface PaginatedProfileChanges {
  changes: ProfileChangeResponse[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface UserTransactionHistoryResponse {
  id: string;
  amount: number;
  status: string;
  creatorId: string;
  creatorName: string;
  message: string | null;
  createdAt: string;
}

export interface PaginatedTransactions {
  transactions: UserTransactionHistoryResponse[];
  items?: UserTransactionHistoryResponse[];
  data?: UserTransactionHistoryResponse[];
  total: number;
  page: number;
  pageSize: number;
  totalPages?: number;
  hasNext?: boolean;
  hasPrev?: boolean;
}
