-- Migration: 0020_disable_activities_sprints_rls
-- Disable Row Level Security on activities and sprints tables.
-- These tables previously had RLS policies that used set_config() session variables
-- which are unreliable with Neon's pooled connection string in transaction mode.
-- Tenant isolation is enforced at the application layer via:
--   1. JWT authentication (auth.middleware.ts) - validates tenant membership
--   2. withTenant() helper - scopes all DB queries to the authenticated tenant
--   3. All INSERTs include tenant_id from req.user.tenantId
-- Disabling RLS removes the duplicate (and broken) DB-level check.

ALTER TABLE activities DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON activities;

ALTER TABLE sprints DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON sprints;
