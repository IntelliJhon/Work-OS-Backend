import { pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

// Platform admins (migration 0037): these user accounts manage all workspaces (WhatsApp bots, sections).
// An account, not an email: signup doesn't verify email, so anyone could register with an admin's address.
export const platformAdmins = pgTable('platform_admins', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
