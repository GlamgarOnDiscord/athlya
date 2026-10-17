-- Rollback for 0038_studios_runtime.sql (issues #224, #117).
DROP POLICY IF EXISTS "studios_admin_update_own" ON "studios";
REVOKE UPDATE ("name", "brand_color") ON "studios" FROM athlya_app;
DROP FUNCTION IF EXISTS studio_id_by_slug(text);
