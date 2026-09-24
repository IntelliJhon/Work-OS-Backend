import { pgTable, timestamp, uuid, varchar, boolean, uniqueIndex, integer } from 'drizzle-orm/pg-core';

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).notNull().unique(),
  plan: varchar('plan', { length: 50 }).default('starter').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  deletedAt: timestamp('deleted_at'),

  // Voice notes: the single verified WhatsApp number allowed to send voice notes for this workspace.
  // Only verified numbers occupy the unique slot, so an unverified entry can't block another workspace.
  voicePhone: varchar('voice_phone', { length: 20 }).unique(),
  voicePhoneVerifiedAt: timestamp('voice_phone_verified_at'),
  voicePhoneUserId: uuid('voice_phone_user_id'), // FK to users.id is defined in migration 0028 (avoids circular import)

  // Pending verification state (number entered in Settings, OTP sent, not yet confirmed)
  voicePhonePending: varchar('voice_phone_pending', { length: 20 }),
  voicePhoneOtpHash: varchar('voice_phone_otp_hash', { length: 64 }),
  voicePhoneOtpExpiresAt: timestamp('voice_phone_otp_expires_at'),
  voicePhoneOtpSentAt: timestamp('voice_phone_otp_sent_at'),
  voicePhoneOtpAttempts: integer('voice_phone_otp_attempts').default(0).notNull(),
});
