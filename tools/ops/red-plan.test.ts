// The plan of the isolated red run (Codex review CR2-04).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { matchesAny } from '../lib/glob.ts';
import { repoRoot } from '../lib/paths.ts';
import { loadRedProjects, planRed, type RedProject } from './red-plan.ts';
import { CLI_TIMEOUT, removeDir, runCli, scratchDir } from './test-helpers.ts';

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

// --- CT-06zzzzz: the project table of verify-container.sh --tests (verify-image/tests-projects.json) --
// Same format as red-projects.json: every red-projects.json project unchanged, then one project per
// Vitest config of the packages (apps/api and packages/db: unit and integration; apps/admin, apps/h5,
// packages/bridge-sdk, contracts-ts, domain, money, ui-tokens, tools: unit). include / exclude as
// the configs (with the defaults of unitConfig / integrationConfig in vitest.shared.ts), relative to
// `dir`; not test/vitest.longrun.config.ts. One file, one project. red-plan.ts --projects <file>
// picks the table (default red-projects.json: --red does not change). Project names are the
// implementation's: these tests find the projects by dir and config.

const TESTS_TABLE = join(repoRoot(), 'tools', 'ops', 'verify-image', 'tests-projects.json');
const RED_TABLE = join(repoRoot(), 'tools', 'ops', 'verify-image', 'red-projects.json');

/** Loaded inside each test: until the table exists only the CT-06zzzzz tests fail. */
function testsProjects(): RedProject[] {
  return loadRedProjects(TESTS_TABLE);
}

function tracked(...patterns: string[]): string[] {
  const res = spawnSync('git', ['-C', repoRoot(), 'ls-files', '-z', '--', ...patterns], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`git ls-files failed: ${res.stderr}`);
  return res.stdout.split('\0').filter((l) => l !== '');
}

/** Every project of `table` that takes `file` (planRed takes the first; the table must have one). */
function takers(file: string, table: readonly RedProject[]): RedProject[] {
  return table.filter((p) => {
    if (!file.startsWith(`${p.dir}/`)) return false;
    const rel = file.slice(p.dir.length + 1);
    return matchesAny(rel, p.include) && !matchesAny(rel, p.exclude);
  });
}

/** The package Vitest configs the --tests table must mirror (besides red-projects.json's). */
const PACKAGE_CONFIGS: { dir: string; config: string; database: boolean }[] = [
  { dir: 'apps/api', config: 'vitest.config.ts', database: false },
  { dir: 'apps/api', config: 'vitest.integration.config.ts', database: true },
  { dir: 'packages/db', config: 'vitest.config.ts', database: false },
  { dir: 'packages/db', config: 'vitest.integration.config.ts', database: true },
  { dir: 'apps/admin', config: 'vitest.config.ts', database: false },
  { dir: 'apps/h5', config: 'vitest.config.ts', database: false },
  { dir: 'packages/bridge-sdk', config: 'vitest.config.ts', database: false },
  { dir: 'packages/contracts-ts', config: 'vitest.config.ts', database: false },
  { dir: 'packages/domain', config: 'vitest.config.ts', database: false },
  { dir: 'packages/money', config: 'vitest.config.ts', database: false },
  { dir: 'packages/ui-tokens', config: 'vitest.config.ts', database: false },
  { dir: 'tools', config: 'vitest.config.ts', database: false },
];

function project(
  table: readonly RedProject[],
  dir: string,
  config: string,
): RedProject | undefined {
  return table.find((p) => p.dir === dir && p.config === config);
}

it('[CT-06zzzzz] tests-projects.json: every red-projects.json project unchanged, then one project per tracked Vitest config but the long-run one', () => {
  const table = testsProjects();
  // red-projects.json's projects, as they are, in their order (browser ones included).
  const red = loadRedProjects(RED_TABLE);
  expect(table.slice(0, red.length)).toEqual(red);
  // One project per tracked vitest*.config.ts, the long-run tier excepted; nothing else.
  const configs = tracked('*vitest*.config.ts')
    .filter((f) => f !== 'test/vitest.longrun.config.ts')
    .sort();
  expect(table.map((p) => `${p.dir}/${p.config}`).sort()).toEqual(configs);
  expect(table.some((p) => p.config.includes('longrun'))).toBe(false);
  for (const c of PACKAGE_CONFIGS) {
    expect(project(table, c.dir, c.config), `${c.dir}/${c.config}`).toBeDefined();
  }
  // Names and (dir, config) are unique; every name is a plain word (it names out/<name>.* files).
  expect(new Set(table.map((p) => p.name)).size).toBe(table.length);
  expect(new Set(table.map((p) => `${p.dir}/${p.config}`)).size).toBe(table.length);
  for (const p of table) expect(p.name, p.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
});

it('[CT-06zzzzz] tests-projects.json mirrors include / exclude / database of each package Vitest config (the vitest.shared.ts defaults included)', () => {
  const table = testsProjects();
  const read = (path: string): string => readFileSync(join(repoRoot(), path), 'utf8');
  const shared = read('vitest.shared.ts');
  // The defaults the bare calls rely on.
  expect(shared).toContain(
    "  include: string[] = ['src/**/*.test.ts'],\n  exclude: string[] = [],",
  );
  expect(shared).toContain("exclude: [...BASE_EXCLUDE, '**/*.int.test.ts', ...exclude],");
  expect(shared).toContain("include: opts.include ?? ['src/**/*.int.test.ts'],");
  expect(shared).toMatch(
    /export function integrationConfig\([\s\S]*?exclude: \[\.\.\.BASE_EXCLUDE\],/,
  );
  const list = (text: string | undefined): string[] =>
    text === undefined ? [] : [...text.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
  for (const c of PACKAGE_CONFIGS) {
    const where = `${c.dir}/${c.config}`;
    const source = read(where);
    const p = project(table, c.dir, c.config);
    expect(p, where).toBeDefined();
    expect(p?.database, where).toBe(c.database);
    expect(p?.browser, where).toBe(false);
    if (c.database) {
      const call = /integrationConfig\(\{([\s\S]*?)\}\)/.exec(source)?.[1];
      expect(call, where).toBeDefined();
      const include = /include:\s*(\[[^\]]*\])/.exec(call ?? '')?.[1];
      expect(p?.include, where).toEqual(
        include === undefined ? ['src/**/*.int.test.ts'] : list(include),
      );
      expect(p?.exclude, where).toEqual([]);
    } else {
      const call = /unitConfig\(\s*(\[[^\]]*\])?\s*(?:,\s*(\[[^\]]*\]))?\s*\)/.exec(source);
      expect(call, where).not.toBeNull();
      expect(p?.include, where).toEqual(
        call?.[1] === undefined ? ['src/**/*.test.ts'] : list(call[1]),
      );
      expect(p?.exclude, where).toEqual(['**/*.int.test.ts', ...list(call?.[2])]);
    }
  }
  // As the configs read today (a change to one of them must change the table too).
  expect(project(table, 'apps/admin', 'vitest.config.ts')?.include).toEqual([
    'src/**/*.test.{ts,tsx}',
  ]);
  expect(project(table, 'apps/h5', 'vitest.config.ts')?.include).toEqual([
    'src/**/*.test.{ts,tsx}',
  ]);
  expect(project(table, 'tools', 'vitest.config.ts')?.include).toEqual(['**/*.test.ts']);
  expect(project(table, 'apps/api', 'vitest.integration.config.ts')?.include).toEqual([
    'src/**/*.int.test.ts',
  ]);
});

it('[CT-06zzzzz] tests-projects.json: every tracked test file (infra/ aside) is taken by exactly one project; *.int.test.ts only by a database project, the others only by one without', () => {
  const table = testsProjects();
  const files = tracked('*.test.ts', '*.test.tsx').filter((f) => !f.startsWith('infra/'));
  expect(files.length).toBeGreaterThan(100);
  const problems: string[] = [];
  for (const f of files) {
    const t = takers(f, table);
    if (t.length !== 1) {
      problems.push(`${f}: ${String(t.length)} projects (${t.map((p) => p.name).join(', ')})`);
      continue;
    }
    const p = t[0] as RedProject;
    // test/acceptance and test/replay (the replay project, CT-06zzzzza) run in the integration
    // tier under any name.
    const integration =
      f.endsWith('.int.test.ts') ||
      f.startsWith('test/acceptance/') ||
      f.startsWith('test/replay/');
    if (p.database !== integration) problems.push(`${f}: database ${String(p.database)}`);
  }
  expect(problems).toEqual([]);
});

it("[CT-06zzzzz] tests-projects.json: a real test file of each package goes to that package's project (unit or integration); red-projects.json still has none for it", () => {
  const table = testsProjects();
  const red = loadRedProjects(RED_TABLE);
  for (const c of PACKAGE_CONFIGS) {
    const under = c.dir === 'tools' ? 'tools/' : `${c.dir}/src/`;
    const real = tracked(`${under}*.test.ts`, `${under}*.test.tsx`).filter(
      (f) => f.endsWith('.int.test.ts') === c.database,
    );
    const where = `${c.dir}/${c.config}`;
    expect(real.length, `${where}: a tracked test file`).toBeGreaterThan(0);
    const file = real[0] ?? '';
    const plan = planRed([file], table);
    expect(plan.unrunnable, file).toEqual([]);
    expect(plan.groups, file).toHaveLength(1);
    expect(plan.groups[0], file).toMatchObject({
      dir: c.dir,
      config: c.config,
      database: c.database,
      browser: false,
      files: [file.slice(c.dir.length + 1)],
    });
    // --red keeps its table.
    expect(planRed([file], red).unrunnable, file).toEqual([file]);
  }
});

it('[CT-06zzzzz] tests-projects.json: unit configs leave *.int.test.ts out; a .tsx test only where the config takes it; a file outside every config has none', () => {
  const table = testsProjects();
  const plan = planRed(
    [
      'apps/api/src/modules/a/a.test.ts',
      'apps/api/src/modules/a/a.int.test.ts',
      'packages/db/src/b.int.test.ts',
      'apps/admin/src/c.test.tsx',
      'apps/h5/src/d.test.tsx',
      'tools/ops/e.test.ts',
      'apps/api/src/f.test.tsx',
      'tools/ops/g.int.test.ts',
      'packages/money/h.test.ts',
      'infra/release-scan/i.test.ts',
    ],
    table,
  );
  const where = new Map(
    plan.groups.flatMap((g) => g.files.map((f) => [`${g.dir}/${f}`, g] as const)),
  );
  expect(where.get('apps/api/src/modules/a/a.test.ts')).toMatchObject({
    dir: 'apps/api',
    config: 'vitest.config.ts',
    database: false,
  });
  expect(where.get('apps/api/src/modules/a/a.int.test.ts')).toMatchObject({
    dir: 'apps/api',
    config: 'vitest.integration.config.ts',
    database: true,
  });
  expect(where.get('packages/db/src/b.int.test.ts')).toMatchObject({
    dir: 'packages/db',
    config: 'vitest.integration.config.ts',
    database: true,
  });
  expect(where.get('apps/admin/src/c.test.tsx')).toMatchObject({ dir: 'apps/admin' });
  expect(where.get('apps/h5/src/d.test.tsx')).toMatchObject({ dir: 'apps/h5' });
  expect(where.get('tools/ops/e.test.ts')).toMatchObject({ dir: 'tools', database: false });
  expect([...plan.unrunnable].sort()).toEqual([
    'apps/api/src/f.test.tsx',
    'infra/release-scan/i.test.ts',
    'packages/money/h.test.ts',
    'tools/ops/g.int.test.ts',
  ]);
});

// --- red-plan.ts --projects <file> ---------------------------------------------------------------------

let cliDir = '';
beforeAll(() => {
  cliDir = scratchDir('red-plan');
});
afterAll(() => removeDir(cliDir));

function expectedFile(name: string, files: string[]): string {
  const path = join(cliDir, name);
  writeFileSync(path, files.map((f) => `${f}\n`).join(''));
  return path;
}

it(
  '[CT-06zzzzz] red-plan CLI without --projects keeps red-projects.json (an apps/api test has no entry, exit 1)',
  () => {
    const spec = runCli('red-plan.ts', [
      '--expected',
      expectedFile('spec.txt', ['test/spec/a/b.test.ts']),
    ]);
    expect(spec.status, spec.stderr).toBe(0);
    expect(JSON.parse(spec.stdout)).toEqual({
      groups: [
        {
          name: 'spec-unit',
          dir: 'test',
          config: 'vitest.config.ts',
          database: false,
          browser: false,
          files: ['spec/a/b.test.ts'],
        },
      ],
    });
    const api = runCli('red-plan.ts', [
      '--expected',
      expectedFile('api.txt', ['apps/api/src/x.test.ts']),
    ]);
    expect(api.status).toBe(1);
    expect(api.stderr).toContain('apps/api/src/x.test.ts');
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] red-plan CLI --projects tests-projects.json plans apps/api unit and integration files and tools files',
  () => {
    const res = runCli('red-plan.ts', [
      '--expected',
      expectedFile('tests.txt', [
        'apps/api/src/x.test.ts',
        'apps/api/src/x.int.test.ts',
        'tools/ops/y.test.ts',
        'test/spec/a/b.test.ts',
      ]),
      '--projects',
      TESTS_TABLE,
    ]);
    expect(res.status, res.stderr).toBe(0);
    const groups = (JSON.parse(res.stdout) as { groups: Record<string, unknown>[] }).groups;
    expect(groups.map((g) => [g['dir'], g['config'], g['database'], g['files']])).toEqual([
      ['apps/api', 'vitest.config.ts', false, ['src/x.test.ts']],
      ['apps/api', 'vitest.integration.config.ts', true, ['src/x.int.test.ts']],
      ['tools', 'vitest.config.ts', false, ['ops/y.test.ts']],
      ['test', 'vitest.config.ts', false, ['spec/a/b.test.ts']],
    ]);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] red-plan CLI --projects <file> uses exactly that table; a missing or malformed table exits 2 naming it',
  () => {
    const table = join(cliDir, 'one.json');
    writeFileSync(
      table,
      JSON.stringify({
        projects: [
          {
            name: 'only-one',
            dir: 'lib',
            config: 'vitest.config.ts',
            include: ['**/*.test.ts'],
            exclude: [],
            database: false,
            browser: false,
          },
        ],
      }),
    );
    const res = runCli('red-plan.ts', [
      '--expected',
      expectedFile('one.txt', ['lib/a/b.test.ts']),
      '--projects',
      table,
    ]);
    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      groups: [
        {
          name: 'only-one',
          dir: 'lib',
          config: 'vitest.config.ts',
          database: false,
          browser: false,
          files: ['a/b.test.ts'],
        },
      ],
    });
    // Not in that table: a test/spec file has no entry there.
    const other = runCli('red-plan.ts', [
      '--expected',
      expectedFile('other.txt', ['test/spec/a/b.test.ts']),
      '--projects',
      table,
    ]);
    expect(other.status).toBe(1);

    const missing = join(cliDir, 'no-such-table.json');
    const gone = runCli('red-plan.ts', [
      '--expected',
      expectedFile('gone.txt', ['lib/a/b.test.ts']),
      '--projects',
      missing,
    ]);
    expect(gone.status).toBe(2);
    expect(gone.stdout).toBe('');
    expect(gone.stderr).toContain('no-such-table.json');

    const bad = join(cliDir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ projects: [{ name: 'x', dir: 'lib' }] }));
    const malformed = runCli('red-plan.ts', [
      '--expected',
      expectedFile('bad.txt', ['lib/a/b.test.ts']),
      '--projects',
      bad,
    ]);
    expect(malformed.status).toBe(2);
    expect(malformed.stdout).toBe('');
    expect(malformed.stderr).toContain('bad.json');
  },
  CLI_TIMEOUT,
);
