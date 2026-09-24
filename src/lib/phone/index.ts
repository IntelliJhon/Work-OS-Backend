import { env } from '../../config/env';

/**
 * Normalize a phone number to digits-only international format, e.g. "+91 98765-43210" -> "919876543210".
 * The same function must be used when saving a number AND when looking up an incoming sender,
 * otherwise "919876543210" and "+91 98765 43210" would not match.
 * Returns null if the result is not a plausible international number (8–15 digits, E.164 limit).
 */
export function normalizePhone(raw: unknown, defaultCountryCode: string = env.DEFAULT_COUNTRY_CODE): string | null {
  if (raw === null || raw === undefined) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;

  // International prefix "00" (e.g. 0091...)
  if (digits.startsWith('00')) digits = digits.slice(2);

  // Local trunk prefix "0" + 10-digit national number (e.g. 09876543210)
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);

  // Bare 10-digit national number -> prepend default country code
  if (digits.length === 10) digits = defaultCountryCode + digits;

  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

/** "919876543210" -> "+91 ••••••3210" for logs and non-admin display. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const countryCode = phone.length > 10 ? phone.slice(0, phone.length - 10) : '';
  return `${countryCode ? `+${countryCode} ` : ''}••••••${phone.slice(-4)}`;
}
