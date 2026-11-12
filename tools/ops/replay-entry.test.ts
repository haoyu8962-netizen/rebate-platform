// CT-06zzzzza (D10-1372, QA-03 prerequisite): the run entry of the replay tests. A Vitest config
// test/vitest.replay.config.ts (real PostgreSQL: the global setup of the integration config;
// include replay/**/*.test.ts; passWithNoTests stays false, as the repository guard requires —
// D10-1389: while test/replay holds no scenario, CI's verify-replay skips the run instead) and a
// `test:replay` script of @couli/spec-tests that runs it. Only additions: the existing scripts of test/ and the
// root verify / verify:fast are unchanged, and neither runs the replay tests.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { repoRoot } from '../lib/paths.ts';

type TestBlock = {
  include?: string[];
  exclude?: string[];
  globalSetup?: string | string[];
  passWithNoTests?: boolean;
  allowOnly?: boolean;
  retry?: number;
};

const read = (path: string): string => readFileSync(join(repoRoot(), path), 'utf8');

async function loadConfig(path: string): Promise<{ test?: TestBlock }> {
  const file = join(repoRoot(), path);
  expect(existsSync(file), `${path} exists`).toBe(true);
  const mod = (await import(pathToFileURL(file).href)) as { default: unknown };
  expect(typeof mod.default, `${path} exports a config object`).toBe('object');
  return mod.default as { test?: TestBlock };
}

/** The scripts of test/package.json on main before CT-06zzzzza. */
const MAIN_TEST_SCRIPTS: Record<string, string> = {
  test: 'vitest run',
  'test:int': 'PROP_RUNS=${PROP_RUNS:-2000} vitest run --config vitest.integration.config.ts',
  'test:browser': 'vitest run --config vitest.browser.config.ts',
  'test:smoke': 'vitest run --config vitest.build-smoke.config.ts',
  'test:longrun': 'vitest run --config vitest.longrun.config.ts',
};

it('[CT-06zzzzza] test/vitest.replay.config.ts includes exactly replay/**/*.test.ts and keeps passWithNoTests false (D10-1389)', async () => {
  const replay = await loadConfig('test/vitest.replay.config.ts');
  expect(replay.test?.include).toEqual(['replay/**/*.test.ts']);
  // Strictly false (not merely unset): an empty run fails, as for every other config.
  expect(replay.test?.passWithNoTests).toBe(false);
});

it('[CT-06zzzzza] test/vitest.replay.config.ts has the global setup of test/vitest.integration.config.ts (the test-database base)', async () => {
  const replay = await loadConfig('test/vitest.replay.config.ts');
  const int = await loadConfig('test/vitest.integration.config.ts');
  expect(int.test?.globalSetup).toEqual(['../packages/db/src/testing/global-setup.ts']);
  expect(replay.test?.globalSetup).toEqual(int.test?.globalSetup);
});

it('[CT-06zzzzza] the integration config is unchanged: its include and global setup as on main', async () => {
  const int = await loadConfig('test/vitest.integration.config.ts');
  expect(int.test?.include).toEqual([
    'spec/**/*.int.test.ts',
    'acceptance/**/*.test.ts',
    'smoke/**/*.int.test.ts',
  ]);
  expect(int.test?.passWithNoTests).toBe(false);
});

it('[CT-06zzzzza] test/package.json has test:replay running vitest with vitest.replay.config.ts; the other scripts are unchanged', () => {
  const pkg = JSON.parse(read('test/package.json')) as { scripts: Record<string, string> };
  const replay = pkg.scripts['test:replay'];
  expect(replay, 'test/package.json has a test:replay script').toBeDefined();
  expect(replay ?? '').toMatch(/\bvitest run\b/);
  expect(replay ?? '').toMatch(/--config[ =]vitest\.replay\.config\.ts\b/);
  const rest = Object.fromEntries(
    Object.entries(pkg.scripts).filter(([name]) => name !== 'test:replay'),
  );
  expect(rest).toEqual(MAIN_TEST_SCRIPTS);
});

it('[CT-06zzzzza] the root verify and verify:fast do not run the replay tests', () => {
  const root = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  expect(root.scripts['verify:fast'] ?? '').not.toContain('test:replay');
  expect(root.scripts['verify'] ?? '').not.toContain('test:replay');
  expect(root.scripts['verify:fast'] ?? '').not.toContain('vitest.replay.config');
  expect(root.scripts['verify'] ?? '').not.toContain('vitest.replay.config');
  // test:int runs each package's test:int, which in test/ is not the replay config.
  expect(root.scripts['test:int']).toBe('turbo run test:int --env-mode=loose');
});
