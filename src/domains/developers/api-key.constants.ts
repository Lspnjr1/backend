/**
 * Prefix on every raw developer API key (issue #213), shared between the
 * service that mints keys and the auth middleware that needs to recognize
 * one without parsing it as a JWT first.
 */
export const API_KEY_PREFIX = 'dsk_live_';
