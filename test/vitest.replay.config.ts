import { integrationConfig } from '../vitest.shared.ts';

// Replay tests (test/replay/**/*.test.ts; 规划/11 §4.2, §4.5; CT-06zzzzza, D10-1372): recorded or
// synthetic external responses replayed into the system, against a real PostgreSQL — the global
// setup of vitest.integration.config.ts (TEST_PG_ADMIN_URL if set, otherwise Testcontainers).
// Run only by `test:replay` (CI job verify-replay; the red run's `replay` project), never by
// verify:fast or verify. passWithNoTests stays false (as in every config): while test/replay holds
// no scenario, CI's verify-replay skips the run instead (D10-1389).
export default integrationConfig({
  include: ['replay/**/*.test.ts'],
  globalSetup: ['../packages/db/src/testing/global-setup.ts'],
});
