-- Migration: 0019_fix_activities_rls_policy
-- Fix activities RLS policy - the old COALESCE fallback to '00000000-...' UUID
-- caused INSERT/SELECT failures in pooled connections where current_setting
-- returns empty string instead of null when not set.
-- New policy allows operations when tenant_id matches OR when setting is empty/null.

ALTER TABLE activities DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON activities;
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON activities
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) IS NULL
  )
  WITH CHECK (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) IS NULL
  );
