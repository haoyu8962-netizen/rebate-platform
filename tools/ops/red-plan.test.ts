// The plan of the isolated red run (Codex review CR2-04).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { matchesAny } from '../lib/glob.ts';
import { repoRoot } from '../lib/paths.ts';
import { loadRedProjects, planRed, type RedProject } from './red-plan.ts';

const projects = loadRedProjects();

/** The string array literals in a source text, in order. */
function arrays(source: string): string[][] {
  return [...source.matchAll(/\[([^\]]*)\]/g)].map((m) =>
    [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1] ?? ''),
  );
}

it('[CR2-04] the project table mirrors the include rules of the trusted Vitest configs', () => {
  const read = (path: string): string => readFileSync(join(repoRoot(), path), 'utf8');
  const shared = read('vitest.shared.ts');
  // unitConfig: default include src/**/*.test.ts, integration files and the caller's extra
  // exclusions excluded.
  expect(shared).toContain(
    "  include: string[] = ['src/**/*.test.ts'],\n  exclude: string[] = [],",
  );
  expect(shared).toContain("exclude: [...BASE_EXCLUDE, '**/*.int.test.ts', ...exclude],");
  const byName = new Map(projects.map((p) => [p.name, p]));
  // test/vitest.config.ts: include, then the extra exclusions (the browser and build smoke rule
  // tests).
  const unit = arrays(read('test/vitest.config.ts'));
  expect(unit[0]).toEqual(byName.get('spec-unit')?.include);
  expect(['**/*.int.test.ts', ...(unit[1] ?? [])]).toEqual(byName.get('spec-unit')?.exclude);
  expect(arrays(read('test/vitest.integration.config.ts'))[0]).toEqual(
    byName.get('spec-int')?.include,
  );
  expect(read('packages/testing/vitest.config.ts')).toContain('unitConfig()');
  expect(byName.get('testing-unit')?.include).toEqual(['src/**/*.test.ts']);
  expect(byName.get('spec-unit')?.exclude).toEqual([
    '**/*.int.test.ts',
    'spec/**/*.browser.test.{ts,tsx}',
    'spec/**/*.smoke.test.ts',
  ]);
  // Other packages do not exclude browser files: one put there runs in the unit tier and fails
  // there instead of being skipped in silence.
  expect(byName.get('testing-unit')?.exclude).toEqual(['**/*.int.test.ts']);
  expect(byName.get('spec-int')).toMatchObject({
    config: 'vitest.integration.config.ts',
    database: true,
    browser: false,
  });

  // F1-01j: the browser project. Its config takes spec/**/*.browser.test.{ts,tsx} through
  // browserConfig (no exclude beyond the shared one) and is what `test:browser` runs.
  const browserSource = read('test/vitest.browser.config.ts');
  expect(arrays(browserSource)[0]).toEqual(byName.get('spec-browser')?.include);
  expect(browserSource).toContain('browserConfig({');
  expect(shared).toMatch(/export function browserConfig\([\s\S]*?exclude: \[\.\.\.BASE_EXCLUDE\],/);
  expect(byName.get('spec-browser')).toEqual({
    name: 'spec-browser',
    dir: 'test',
    config: 'vitest.browser.config.ts',
    include: ['spec/**/*.browser.test.{ts,tsx}'],
    exclude: [],
    database: false,
    browser: true,
  });
  const pkg = JSON.parse(read('test/package.json')) as { scripts: Record<string, string> };
  expect(pkg.scripts['test:browser']).toBe('vitest run --config vitest.browser.config.ts');

  // F1-01k: the build smoke project. Node tests (smokeConfig) against the builds of the
  // globalSetup; `test:smoke` runs it.
  const smokeSource = read('test/vitest.build-smoke.config.ts');
  expect(arrays(smokeSource)[0]).toEqual(byName.get('build-smoke')?.include);
  expect(arrays(smokeSource)[1]).toEqual(['../tools/ops/build-smoke/global-setup.ts']);
  expect(smokeSource).toContain('smokeConfig({');
  expect(shared).toMatch(/export function smokeConfig\([\s\S]*?exclude: \[\.\.\.BASE_EXCLUDE\],/);
  expect(byName.get('build-smoke')).toEqual({
    name: 'build-smoke',
    dir: 'test',
    config: 'vitest.build-smoke.config.ts',
    include: ['spec/**/*.smoke.test.ts'],
    exclude: [],
    database: false,
    browser: true,
  });
  expect(pkg.scripts['test:smoke']).toBe('vitest run --config vitest.build-smoke.config.ts');
  // The projects that need Chromium, in the order verify-container.sh --browser runs them.
  expect(projects.filter((p) => p.browser).map((p) => p.name)).toEqual([
    'spec-browser',
    'build-smoke',
  ]);
  // `pnpm verify` runs both after the integration tests; verify:fast runs neither.
  const root = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  expect(root.scripts['verify']).toContain(
    'pnpm --filter @couli/spec-tests run test:browser && pnpm --filter @couli/spec-tests run test:smoke',
  );
  expect(root.scripts['verify:fast']).not.toMatch(/test:(?:browser|smoke)/);
});

it('[CR2-04] acceptance and packages/testing files get their own entry; a file without one fails', () => {
  const plan = planRed(
    [
      'test/spec/money/split.test.ts',
      'test/properties/money/sum.test.ts',
      'test/spec/db/ledger.int.test.ts',
      'test/acceptance/order.test.ts',
      'packages/testing/src/arb.test.ts',
      'db/invariants/ledger.test.ts',
    ],
    projects,
  );
  expect(plan.groups).toEqual([
    {
      name: 'spec-unit',
      dir: 'test',
      config: 'vitest.config.ts',
      database: false,
      browser: false,
      files: ['spec/money/split.test.ts', 'properties/money/sum.test.ts'],
    },
    {
      name: 'spec-int',
      dir: 'test',
      config: 'vitest.integration.config.ts',
      database: true,
      browser: false,
      files: ['spec/db/ledger.int.test.ts', 'acceptance/order.test.ts'],
    },
    {
      name: 'testing-unit',
      dir: 'packages/testing',
      config: 'vitest.config.ts',
      database: false,
      browser: false,
      files: ['src/arb.test.ts'],
    },
  ]);
  // test/replay/** has its own entry since CT-06zzzzza (the replay project, tests below).
  expect(plan.unrunnable).toEqual(['db/invariants/ledger.test.ts']);
});

it('[F1-01j] spec browser rule tests (.ts, .tsx) go to spec-browser only; elsewhere the unit tier takes them', () => {
  const plan = planRed(
    [
      'test/spec/frontend/browser-env/environment.browser.test.ts',
      'test/spec/frontend/browser-env/card.browser.test.tsx',
      'test/spec/frontend/browser-env/tokens.test.ts',
      'test/properties/ui/layout.browser.test.ts',
      'packages/testing/src/dom.browser.test.ts',
    ],
    projects,
  );
  expect(plan.groups).toEqual([
    {
      name: 'spec-browser',
      dir: 'test',
      config: 'vitest.browser.config.ts',
      database: false,
      browser: true,
      files: [
        'spec/frontend/browser-env/environment.browser.test.ts',
        'spec/frontend/browser-env/card.browser.test.tsx',
      ],
    },
    {
      name: 'spec-unit',
      dir: 'test',
      config: 'vitest.config.ts',
      database: false,
      browser: false,
      files: ['spec/frontend/browser-env/tokens.test.ts', 'properties/ui/layout.browser.test.ts'],
    },
    {
      name: 'testing-unit',
      dir: 'packages/testing',
      config: 'vitest.config.ts',
      database: false,
      browser: false,
      files: ['src/dom.browser.test.ts'],
    },
  ]);
  // Outside test/spec/ a browser file is not skipped: the unit tier runs it (and it fails there).
  expect(plan.unrunnable).toEqual([]);
});

it('[F1-01k] spec build smoke rule tests go to build-smoke only; elsewhere the unit tier takes them', () => {
  const plan = planRed(
    [
      'test/spec/frontend/build-smoke/entries.smoke.test.ts',
      'test/spec/frontend/build-smoke/sizes.test.ts',
      'test/properties/ui/budget.smoke.test.ts',
    ],
    projects,
  );
  expect(plan.groups).toEqual([
    {
      name: 'build-smoke',
      dir: 'test',
      config: 'vitest.build-smoke.config.ts',
      database: false,
      browser: true,
      files: ['spec/frontend/build-smoke/entries.smoke.test.ts'],
    },
    {
      name: 'spec-unit',
      dir: 'test',
      config: 'vitest.config.ts',
      database: false,
      browser: false,
      files: ['spec/frontend/build-smoke/sizes.test.ts', 'properties/ui/budget.smoke.test.ts'],
    },
  ]);
  expect(plan.unrunnable).toEqual([]);
});

// --- CT-06zzzzza (D10-1372): the replay project ---------------------------------------------------
// QA-03a puts its replay scenarios under test/replay/, which none of the five projects took, so
// red-plan failed and the red run could not start. A sixth project, `replay`, takes exactly
// test/replay/**/*.test.ts with the replay config (real PostgreSQL); the five are unchanged.

/** The five projects as they are on main before CT-06zzzzza, field for field. */
const MAIN_PROJECTS: RedProject[] = [
  {
    name: 'spec-unit',
    dir: 'test',
    config: 'vitest.config.ts',
    include: ['properties/**/*.test.ts', 'spec/**/*.test.ts'],
    exclude: ['**/*.int.test.ts', 'spec/**/*.browser.test.{ts,tsx}', 'spec/**/*.smoke.test.ts'],
    database: false,
    browser: false,
  },
  {
    name: 'spec-int',
    dir: 'test',
    config: 'vitest.integration.config.ts',
    include: ['spec/**/*.int.test.ts', 'acceptance/**/*.test.ts', 'smoke/**/*.int.test.ts'],
    exclude: [],
    database: true,
    browser: false,
  },
  {
    name: 'spec-browser',
    dir: 'test',
    config: 'vitest.browser.config.ts',
    include: ['spec/**/*.browser.test.{ts,tsx}'],
    exclude: [],
    database: false,
    browser: true,
  },
  {
    name: 'build-smoke',
    dir: 'test',
    config: 'vitest.build-smoke.config.ts',
    include: ['spec/**/*.smoke.test.ts'],
    exclude: [],
    database: false,
    browser: true,
  },
  {
    name: 'testing-unit',
    dir: 'packages/testing',
    config: 'vitest.config.ts',
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.int.test.ts'],
    database: false,
    browser: false,
  },
];

const REPLAY_PROJECT: RedProject = {
  name: 'replay',
  dir: 'test',
  config: 'vitest.replay.config.ts',
  include: ['replay/**/*.test.ts'],
  exclude: [],
  database: true,
  browser: false,
};

/** The projects whose dir, include and exclude take `file` (planRed takes the first of them). */
function takers(file: string): string[] {
  return projects
    .filter((p) => {
      if (!file.startsWith(`${p.dir}/`)) return false;
      const rel = file.slice(p.dir.length + 1);
      return matchesAny(rel, p.include) && !matchesAny(rel, p.exclude);
    })
    .map((p) => p.name);
}

it('[CT-06zzzzza] red-projects.json has a replay project: test, vitest.replay.config.ts, replay/**/*.test.ts only, database, no browser', () => {
  const replay = projects.filter((p) => p.name === 'replay');
  expect(replay, 'exactly one project named replay').toHaveLength(1);
  // `exclude` is not named by the task; an empty list is the only value that takes nothing away.
  expect(replay[0]).toMatchObject({
    name: 'replay',
    dir: 'test',
    config: 'vitest.replay.config.ts',
    include: ['replay/**/*.test.ts'],
    database: true,
    browser: false,
  });
  expect(replay[0]?.include).toEqual(['replay/**/*.test.ts']);
  expect(replay[0]?.exclude ?? []).toEqual([]);
});

it('[CT-06zzzzza] the five existing projects are unchanged, field for field and in their order; replay is the only addition', () => {
  expect(projects.filter((p) => p.name !== 'replay')).toEqual(MAIN_PROJECTS);
  expect(projects.map((p) => p.name).sort()).toEqual(
    [...MAIN_PROJECTS.map((p) => p.name), 'replay'].sort(),
  );
  // The Chromium projects and their order (verify-container.sh --browser) are unchanged.
  expect(projects.filter((p) => p.browser).map((p) => p.name)).toEqual([
    'spec-browser',
    'build-smoke',
  ]);
  // The database projects: spec-int and replay.
  expect(
    projects
      .filter((p) => p.database)
      .map((p) => p.name)
      .sort(),
  ).toEqual(['replay', 'spec-int']);
});

it('[CT-06zzzzza] the replay project mirrors test/vitest.replay.config.ts (include) and the config file exists', async () => {
  const path = join(repoRoot(), 'test', 'vitest.replay.config.ts');
  expect(existsSync(path), 'test/vitest.replay.config.ts exists').toBe(true);
  const config = ((await import(pathToFileURL(path).href)) as { default: unknown }).default as {
    test?: { include?: string[] };
  };
  expect(config.test?.include).toEqual(projects.find((p) => p.name === 'replay')?.include);
  expect(config.test?.include).toEqual(REPLAY_PROJECT.include);
});

it('[CT-06zzzzza] test/replay/** test files go to the replay group only, whatever their sub-directory or suffix', () => {
  const files = [
    'test/replay/orders.test.ts',
    'test/replay/scenario-1/follow-estimate-receive.test.ts',
    'test/replay/scenarios/jd/deep/settle.test.ts',
    'test/replay/driver/clock.int.test.ts',
  ];
  for (const f of files) expect(takers(f), f).toEqual(['replay']);
  const plan = planRed(files, projects);
  expect(plan.unrunnable).toEqual([]);
  expect(plan.groups).toEqual([
    {
      name: 'replay',
      dir: 'test',
      config: 'vitest.replay.config.ts',
      database: true,
      browser: false,
      files: files.map((f) => f.slice('test/'.length)),
    },
  ]);
});

it('[CT-06zzzzza] files under test/replay/ that are not *.test.ts are taken by no project', () => {
  const files = [
    'test/replay/README.md',
    'test/replay/scenario-1/provenance.json',
    'test/replay/driver/run.ts',
    'test/replay/scenario-1/orders.test.tsx',
  ];
  for (const f of files) expect(takers(f), f).toEqual([]);
  expect(planRed(files, projects)).toEqual({ groups: [], unrunnable: files });
});

it('[CT-06zzzzza] the replay project takes nothing outside test/replay/: the claims of the five are unchanged', () => {
  const outside = [
    'test/spec/money/split.test.ts',
    'test/properties/money/sum.test.ts',
    'test/spec/db/ledger.int.test.ts',
    'test/acceptance/order.test.ts',
    'test/smoke/boot.int.test.ts',
    'test/spec/frontend/x.browser.test.tsx',
    'test/spec/frontend/entries.smoke.test.ts',
    'packages/testing/src/arb.test.ts',
    'test/spec/union/replay/recording.test.ts',
    'test/replayed/orders.test.ts',
  ];
  const before = planRed(outside, MAIN_PROJECTS);
  expect(planRed(outside, projects)).toEqual(before);
  for (const f of outside) expect(takers(f), f).not.toContain('replay');
  // A file under test/replay/ is one no main project took: the replay project fills a gap only.
  expect(planRed(['test/replay/orders.test.ts'], MAIN_PROJECTS).unrunnable).toEqual([
    'test/replay/orders.test.ts',
  ]);
});

it('[CT-06zzzzza] a mixed plan keeps spec-int and replay as two database groups', () => {
  const plan = planRed(
    ['test/spec/db/ledger.int.test.ts', 'test/replay/orders.test.ts', 'test/spec/money/a.test.ts'],
    projects,
  );
  expect(plan.unrunnable).toEqual([]);
  expect(plan.groups.map((g) => [g.name, g.database, g.files])).toEqual([
    ['spec-int', true, ['spec/db/ledger.int.test.ts']],
    ['replay', true, ['replay/orders.test.ts']],
    ['spec-unit', false, ['spec/money/a.test.ts']],
  ]);
});
