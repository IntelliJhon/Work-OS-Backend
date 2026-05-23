import { pgTable, timestamp, uuid, jsonb, text, index, pgEnum } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { projects } from './projects';
import { phases } from './phases';
import { users } from './users';

export const gateStatusEnum = pgEnum('gate_status', ['pending', 'approved', 'rejected', 'remediation_required', 'resubmitted']);

export const qualityGates = pgTable('quality_gates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  phaseId: uuid('phase_id').references(() => phases.id, { onDelete: 'cascade' }).notNull(),
  criteria: jsonb('criteria').notNull(),
  approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
  approvedAt: timestamp('approved_at'),
  status: gateStatusEnum('status').notNull().default('pending'),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => {
  return {
    projectIdx: index('idx_gates_project_id').on(table.projectId),
    phaseIdx: index('idx_gates_phase_id').on(table.phaseId),
  };
});
