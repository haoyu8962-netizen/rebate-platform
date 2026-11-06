-- Up Migration
-- Deprecate app.devices.user_id (FU-DEVICES-USER-ID-COLUMN; orchestrator ruling D10-730, device
-- ownership per D10-571 / D10-585). Task B1-02zzb.
-- Production never writes the column: registration inserts NULL and nothing updates it; which user
-- a device belongs to is read from app.sessions. The column is kept for now (several frozen tests
-- still read and write it) and is to be dropped later (FU-DEVICES-USER-ID-DROP, not scheduled).
-- Compatibility: no shape change. The column, its foreign key devices_user_fkey, the other
-- constraints and couli_app's table-level grants of 0005 stay as they are.
-- Recovery: restore from backup; no down migration. To undo by hand:
--   GRANT SELECT (user_id) ON app.devices TO couli_readonly; COMMENT ON COLUMN app.devices.user_id IS NULL;
--
-- This migration does two things:
-- - COMMENT ON COLUMN marks user_id deprecated.
-- - couli_readonly loses the column-level SELECT (user_id) granted in 0013 (0013 replaced the
--   table-level SELECT of 0005 with per-column grants); its SELECT on every other devices column
--   except install_secret_cipher stays. No other role's privileges change.
--
-- Timeouts: catalog-only statements on app.devices (comment and column ACL), no table scan or
-- rewrite; 5s lock wait so a blocked deploy fails fast, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

COMMENT ON COLUMN app.devices.user_id IS
  '已弃用（deprecated）：生产不写（注册时插入 NULL，之后不更新）；设备归属以 app.sessions 为准（D10-571 / D10-730）；待删（FU-DEVICES-USER-ID-DROP）。';

REVOKE SELECT (user_id) ON app.devices FROM couli_readonly;
