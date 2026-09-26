import crypto from 'crypto';
import { env } from '../../config/env';

/**
 * AES-256-GCM for secrets stored in the database (e.g. a workspace's WhatsApp access token).
 * Format: base64(iv).base64(authTag).base64(ciphertext). Key: SECRETS_ENCRYPTION_KEY (32 bytes, hex or base64).
 */

const loadKey = (): Buffer => {
  const raw = env.SECRETS_ENCRYPTION_KEY;
  if (!raw) throw new Error('SECRETS_ENCRYPTION_KEY is not set');
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('SECRETS_ENCRYPTION_KEY must be 32 bytes (64 hex characters)');
  return key;
};

export const isEncryptionConfigured = (): boolean => {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
};

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((b) => b.toString('base64')).join('.');
}

export function decryptSecret(stored: string): string {
  const [iv, tag, data] = stored.split('.').map((part) => Buffer.from(part, 'base64'));
  if (!iv || !tag || !data) throw new Error('Malformed encrypted secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** "abcd…wxyz" for showing that a secret is set without revealing it. */
export const maskSecret = (plain: string): string =>
  plain.length <= 8 ? '••••' : `${plain.slice(0, 4)}…${plain.slice(-4)}`;
