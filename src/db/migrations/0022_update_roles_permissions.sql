UPDATE roles
SET permissions = permissions || '{"project.read": true, "task.read": true}'::jsonb
WHERE name IN ('Developer', 'Scrum Master', 'Viewer');
