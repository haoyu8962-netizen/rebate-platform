// Unit tests for the parts of verify-container.sh that need neither Docker nor the network: usage,
// refusals and the --dry-run plan (commit, tree). The container path itself is exercised by
// tools/ops/verify-container.selftest.sh (run by hand, see tools/ops/README.md).
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { repoRoot } from '../lib/paths.ts';
import {
  CLI_TIMEOUT,
  fixtureGit,
  OPS_DIR,
  removeDir,
  scratchDir,
  writeFiles,
} from './test-helpers.ts';

const SCRIPT = join(OPS_DIR, 'verify-container.sh');

let base = '';
let runs = '';

function fixture(name: string, verify: string): string {
  const dir = join(base, name);
  writeFiles(dir, {
    'package.json': `${JSON.stringify({ name, private: true, scripts: { verify } }, null, 2)}\n`,
    'pnpm-workspace.yaml': 'packages: []\n',
  });
  return dir;
}

function run(args: string[], env: Record<string, string> = {}) {
  // CT-06zzzzu: a COULI_VERIFY_MEMORY of the machine running these tests (the LAN test machine
  // sets one) must not reach the cases that expect it unset; a case that needs it passes it here.
  const inherited: NodeJS.ProcessEnv = { ...process.env };
  Reflect.deleteProperty(inherited, 'COULI_VERIFY_MEMORY');
  const res = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...inherited, COULI_RUNS: runs, COULI_TRUSTED_ROOT: repoRoot(), ...env },
  });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

/** The --dry-run plan without its `memory` field, which the [CT-06zzzzu] tests check on their own. */
function planWithoutMemory(stdout: string): Record<string, unknown> {
  const plan = JSON.parse(stdout) as Record<string, unknown>;
  Reflect.deleteProperty(plan, 'memory');
  return plan;
}

beforeAll(() => {
  base = scratchDir('verify');
  runs = join(base, 'runs');
});
afterAll(() => removeDir(base));

it(
  'the scripts are valid bash',
  () => {
    for (const file of [
      'verify-container.sh',
      'verify-container.selftest.sh',
      'verify-image/entrypoint.sh',
    ]) {
      expect(spawnSync('bash', ['-n', join(OPS_DIR, file)]).status).toBe(0);
    }
  },
  CLI_TIMEOUT,
);

it('the image default pnpm version equals the root packageManager', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as {
    packageManager: string;
  };
  const dockerfile = readFileSync(join(OPS_DIR, 'verify-image', 'Dockerfile'), 'utf8');
  expect(dockerfile).toContain(`ARG PNPM_VERSION=${pkg.packageManager.replace('pnpm@', '')}\n`);
  expect(dockerfile).toContain('FROM node:24-bookworm-slim\n');
  expect(dockerfile).toContain('USER node\n');
  expect(dockerfile).not.toMatch(/corepack enable/);
});

it('[F1-01j] the image default playwright version equals the one of pnpm-lock.yaml', () => {
  const lock = readFileSync(join(repoRoot(), 'pnpm-lock.yaml'), 'utf8');
  // The packages and snapshots sections both carry the `playwright@<version>:` key.
  const keys = [...lock.matchAll(/^ {2}playwright@([^:(]+)[^\n]*:$/gm)].map((m) => m[1]);
  const versions = new Set(keys);
  expect([...versions]).toHaveLength(1);
  const version = [...versions][0] ?? '';
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  const dockerfile = readFileSync(join(OPS_DIR, 'verify-image', 'Dockerfile'), 'utf8');
  expect(dockerfile).toContain(`ARG PLAYWRIGHT_VERSION=${version}\n`);
  // The test package pins the same release (F1-01i).
  const spec = JSON.parse(readFileSync(join(repoRoot(), 'test', 'package.json'), 'utf8')) as {
    devDependencies: Record<string, string>;
  };
  expect(spec.devDependencies['playwright']).toBe(version);
  // Installed where the read-only, non-root container finds it; only the headless shell (what
  // Playwright launches for headless Chromium); Chinese fonts with a built font cache. The
  // install runs before the switch to the non-root user.
  expect(dockerfile).toContain('ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright\n');
  expect(dockerfile).toContain(
    'npx -y "playwright@${PLAYWRIGHT_VERSION}" install --with-deps --only-shell chromium;',
  );
  expect(dockerfile).toContain('fonts-noto-cjk');
  expect(dockerfile).toContain('fc-cache -f;');
  expect(dockerfile).toContain('chmod -R a+rX /ms-playwright;');
  expect(dockerfile.indexOf('install --with-deps')).toBeLessThan(dockerfile.indexOf('USER node\n'));
});

it(
  'refuses bad usage and worktrees under the temp directories',
  () => {
    expect(run([]).status).toBe(2);
    expect(run(['../x', '--dry-run']).stderr).toContain('invalid task id');
    expect(run(['V1-01', '--bogus']).status).toBe(2);
    expect(run(['V1-01', '--worktree', join(base, 'missing'), '--dry-run']).stderr).toContain(
      'worktree does not exist',
    );
    const ok = fixture('usage', 'true');
    for (const pair of [
      ['--fast', '--red'],
      ['--fast', '--browser'],
      ['--browser', '--red'],
    ]) {
      const res = run(['V1-01', '--worktree', ok, ...pair, '--dry-run']);
      expect(res.stderr).toContain('at most one of --fast, --red and --browser');
    }
    for (const extra of [[], ['--browser']]) {
      const res = run(['V1-01', '--worktree', ok, ...extra, '--base', 'main', '--dry-run']);
      // CT-06zzzzv: --base now serves --related as well.
      expect(res.stderr).toContain('--base applies to --red and --related only');
    }
    const inTmp = mkdtempSync(join(tmpdir(), 'couli-verify-test-'));
    try {
      writeFileSync(join(inTmp, 'package.json'), '{"scripts":{"verify":"true"}}\n');
      const res = run(['V1-01', '--worktree', inTmp, '--dry-run']);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('refusing a worktree under');
    } finally {
      rmSync(inTmp, { recursive: true, force: true });
    }
    // Nothing was recorded for the refused runs.
    expect(existsSync(join(runs, 'V1-01'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it('[CT-06zxg] the host-services lock wait follows the time limit like RuntimeMaxSec (D10-382)', () => {
  const text = readFileSync(SCRIPT, 'utf8');
  expect(text).toContain('local lock_wait=$((MAX_TIMEOUT_SECS * 2 + 1800))');
  expect(text).toContain('flock -w "$lock_wait" 9');
  expect(text).toContain('RuntimeMaxSec=$((TIMEOUT_SECS * 2 + 1800))');
  expect(text).not.toContain('flock -w 3600');
});

it(
  '[CT-06zzza] COULI_VERIFY_VITEST_MAX_WORKERS defaults to 2 and must be an integer 1..32',
  () => {
    const ok = fixture('workers', 'true');
    for (const value of ['0', '33', 'x', '1.5', '-1']) {
      const bad = run(['V1-01', '--worktree', ok, '--dry-run'], {
        COULI_VERIFY_VITEST_MAX_WORKERS: value,
      });
      expect(bad.status, value).toBe(2);
      expect(bad.stderr, value).toContain(
        'COULI_VERIFY_VITEST_MAX_WORKERS must be an integer 1..32',
      );
    }
    for (const value of ['1', '8', '32']) {
      expect(
        run(['V1-01', '--worktree', ok, '--dry-run'], { COULI_VERIFY_VITEST_MAX_WORKERS: value })
          .stderr,
        value,
      ).not.toContain('COULI_VERIFY_VITEST_MAX_WORKERS must be');
    }
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).toContain('VITEST_WORKERS="${COULI_VERIFY_VITEST_MAX_WORKERS:-2}"');
    expect(text).toContain('VITEST_ENV=(-e "VITEST_MAX_WORKERS=$VITEST_WORKERS")');
    expect(existsSync(join(runs, 'V1-01'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06v] the time limit defaults to 3600 s (CT-06zxf) and may not go beyond 3600 s',
  () => {
    const ok = fixture('limit', 'true');
    const over = run(['V1-01', '--worktree', ok, '--dry-run'], {
      COULI_VERIFY_TIMEOUT_SECS: '3601',
    });
    expect(over.status).toBe(2);
    expect(over.stderr).toContain('COULI_VERIFY_TIMEOUT_SECS is capped at 3600');
    expect(
      run(['V1-01', '--worktree', ok, '--dry-run'], { COULI_VERIFY_TIMEOUT_SECS: '0' }).stderr,
    ).toContain('must be a positive integer');
    for (const value of ['3600', '2400', '5']) {
      expect(
        run(['V1-01', '--worktree', ok, '--dry-run'], { COULI_VERIFY_TIMEOUT_SECS: value }).stderr,
      ).not.toContain('capped at');
    }
    // The script's own numbers: default 3600 (CT-06zxf, D10-372), cap 3600 (the switch may lower it).
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).toContain('MAX_TIMEOUT_SECS=3600');
    expect(text).toContain('DEFAULT_TIMEOUT_SECS=3600');
    expect(text).toContain('TIMEOUT_SECS="${COULI_VERIFY_TIMEOUT_SECS:-$DEFAULT_TIMEOUT_SECS}"');
    expect(existsSync(join(runs, 'V1-01'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzc] PROP_RUNS stays a positive integer with no default here; test:int holds the 2000 of the CI integration job (D10-499)',
  () => {
    const ok = fixture('prop-runs', 'true');
    for (const value of ['0', '-1', '1.5', '007', 'many']) {
      const res = run(['V1-06', '--worktree', ok, '--dry-run'], { PROP_RUNS: value });
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('PROP_RUNS must be a positive integer');
    }
    // Empty counts as unset.
    for (const value of ['', '7', '100000']) {
      const res = run(['V1-06', '--worktree', ok, '--dry-run'], { PROP_RUNS: value });
      expect(res.status, res.stderr).toBe(0);
    }
    // The pure property tests keep the 10000 of @couli/testing (规划/11 §4.2): no default here.
    expect(readFileSync(SCRIPT, 'utf8')).not.toContain('DEFAULT_PROP_RUNS');
    // Every test:int defaults to 2000 and yields to the caller, on the vitest command itself.
    for (const dir of ['test', join('apps', 'api'), join('packages', 'db')]) {
      const pkg = JSON.parse(readFileSync(join(repoRoot(), dir, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      };
      expect(pkg.scripts['test:int']).toContain(
        'PROP_RUNS=${PROP_RUNS:-2000} vitest run --config vitest.integration.config.ts',
      );
    }
    // The same number as the verify-int job (D10-210).
    const ci = readFileSync(join(repoRoot(), '.github', 'workflows', 'ci.yml'), 'utf8');
    // CT-06zzb: verify-int is split into shards (CT-06zzzj: turbo streams its log); CT-06zzzzq: six
    // jobs verify-int-1 … -6 shard @couli/spec-tests, and the lightest one also runs the other
    // packages' test:int unsharded. Every one of these commands carries the same env.
    const intCommands = [
      ...[1, 2, 3, 4, 5, 6].map(
        (i) =>
          `pnpm test:int --log-order=stream --filter=@couli/spec-tests -- --shard=${String(i)}/6`,
      ),
      "pnpm test:int --log-order=stream --filter='!@couli/spec-tests'",
    ];
    for (const command of intCommands) {
      expect(ci).toContain(
        `      - run: ${command}\n        env:\n          TEST_REDIS_URL: redis://127.0.0.1:6379/0\n          PROP_RUNS: '2000'\n`,
      );
    }
    expect(ci).not.toContain('pnpm test:int --log-order=stream -- --shard=');
    expect(existsSync(join(runs, 'V1-06'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  '[CR-01] there is no host fallback: --host is refused for verify and verify:fast alike',
  () => {
    const dir = fixture('host', 'node -e "process.exit(0)"');
    for (const extra of [[], ['--fast']]) {
      const res = run(['V1-02', '--worktree', dir, '--host', ...extra]);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('--host is no longer accepted');
      expect(res.stderr).toContain('hand the run to CI');
    }
    expect(existsSync(join(runs, 'V1-02'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  'refuses to run from a checkout that is not the trusted root',
  () => {
    const res = run(['V1-03', '--worktree', fixture('untrusted', 'true'), '--dry-run'], {
      COULI_TRUSTED_ROOT: base,
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('run this script from the trusted root');
  },
  CLI_TIMEOUT,
);

it(
  '--dry-run names the commit and the tree of the worktree as it would be verified',
  () => {
    const repo = fixture('dry', 'node -e "process.exit(0)"');
    fixtureGit(repo, ['init', '-q', '-b', 'main']);
    fixtureGit(repo, ['add', '-A']);
    fixtureGit(repo, ['commit', '-q', '-m', 'fixture']);
    const head = fixtureGit(repo, ['rev-parse', 'HEAD']);
    const headTree = fixtureGit(repo, ['rev-parse', 'HEAD^{tree}']);

    const plan = run(['V1-05', '--worktree', repo, '--dry-run']);
    expect(plan.status, plan.stderr).toBe(0);
    expect(planWithoutMemory(plan.stdout)).toEqual({
      script: 'verify',
      commit: head,
      tree: headTree,
    });

    // Uncommitted work changes the tree, not the commit; the real index stays untouched.
    writeFileSync(join(repo, 'new-file.txt'), 'uncommitted\n');
    const dirty = JSON.parse(run(['V1-05', '--worktree', repo, '--fast', '--dry-run']).stdout) as {
      script: string;
      commit: string;
      tree: string;
    };
    expect(dirty.script).toBe('verify:fast');
    expect(dirty.commit).toBe(head);
    expect(dirty.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(dirty.tree).not.toBe(headTree);
    expect(fixtureGit(repo, ['status', '--porcelain'])).toBe('?? new-file.txt');
    const browser = run(['V1-05', '--worktree', repo, '--browser', '--dry-run']);
    expect(browser.status, browser.stderr).toBe(0);
    expect(planWithoutMemory(browser.stdout)).toEqual({
      script: 'browser',
      commit: head,
      tree: dirty.tree,
    });
    // No run directory and no result for a plan.
    expect(existsSync(join(runs, 'V1-05'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  '[CR-12] --red needs the task in the trusted ledger and stops before anything runs',
  () => {
    const repo = fixture('red', 'node -e "process.exit(0)"');
    fixtureGit(repo, ['init', '-q', '-b', 'main']);
    fixtureGit(repo, ['add', '-A']);
    fixtureGit(repo, ['commit', '-q', '-m', 'fixture']);
    const res = run(['V9-99', '--worktree', repo, '--red', '--base', 'main', '--dry-run']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("cannot list the task's rule-test files");
    expect(existsSync(join(runs, 'V9-99'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  '[CR3-01] --red for B1-02b (legacy ledger, no test_paths): the old scope gives it files to run',
  () => {
    // The real trusted ledger: B1-02b is on tools/guard/legacy-tasks.json and has no test_paths.
    const repo = fixture('red-legacy', 'node -e "process.exit(0)"');
    fixtureGit(repo, ['init', '-q', '-b', 'main']);
    fixtureGit(repo, ['add', '-A']);
    fixtureGit(repo, ['commit', '-q', '-m', 'fixture']);
    writeFiles(repo, {
      'test/spec/identity/devices.test.ts': "it('[BR-ID-05] x', () => {});\n",
      'test/spec/identity/devices.int.test.ts': "it('[BR-ID-05] y', () => {});\n",
      'apps/api/src/modules/identity/devices.ts': 'export {};\n',
    });
    const res = run(['B1-02b', '--worktree', repo, '--red', '--base', 'main', '--dry-run']);
    expect(res.status, res.stderr).toBe(0);
    const plan = JSON.parse(res.stdout) as {
      red_files: string[];
      red_plan: { name: string; files: string[] }[];
    };
    expect(plan.red_files).toEqual([
      'test/spec/identity/devices.int.test.ts',
      'test/spec/identity/devices.test.ts',
    ]);
    expect(plan.red_plan.map((g) => `${g.name}: ${g.files.join(' ')}`)).toEqual([
      'spec-int: spec/identity/devices.int.test.ts',
      'spec-unit: spec/identity/devices.test.ts',
    ]);
  },
  CLI_TIMEOUT,
);

it(
  '[F1-01j] --red --dry-run: a browser rule test is planned for spec-browser, marked browser',
  () => {
    const repo = fixture('red-browser', 'node -e "process.exit(0)"');
    fixtureGit(repo, ['init', '-q', '-b', 'main']);
    fixtureGit(repo, ['add', '-A']);
    fixtureGit(repo, ['commit', '-q', '-m', 'fixture']);
    writeFiles(repo, {
      'test/spec/identity/devices.browser.test.ts': "it('[BR-ID-05] z', () => {});\n",
    });
    const res = run(['B1-02b', '--worktree', repo, '--red', '--base', 'main', '--dry-run']);
    expect(res.status, res.stderr).toBe(0);
    const plan = JSON.parse(res.stdout) as { red_plan: unknown[] };
    expect(plan.red_plan).toEqual([
      {
        name: 'spec-browser',
        dir: 'test',
        config: 'vitest.browser.config.ts',
        database: false,
        browser: true,
        files: ['spec/identity/devices.browser.test.ts'],
      },
    ]);
  },
  CLI_TIMEOUT,
);

// CT-06zzzzt (FU-RED-RUNS-TEST-GUARD, D10-1235 / D10-1283 ②): --red runs the trusted test-guard
// against its base before anything else, as guard-git does in CI. A fixture repository on `main`
// (committed `baseFiles`), with `head` written on top and `removed` deleted, both uncommitted.
// B1-02b (legacy ledger) gives test/spec/identity/** to the red run, as in [CR3-01].
function redRepo(
  name: string,
  baseFiles: Record<string, string>,
  head: Record<string, string>,
  removed: string[] = [],
): string {
  const repo = fixture(name, 'node -e "process.exit(0)"');
  writeFiles(repo, baseFiles);
  fixtureGit(repo, ['init', '-q', '-b', 'main']);
  fixtureGit(repo, ['add', '-A']);
  fixtureGit(repo, ['commit', '-q', '-m', 'fixture']);
  writeFiles(repo, head);
  for (const rel of removed) rmSync(join(repo, rel));
  return repo;
}

// Two static findings of test-guard in a new rule-test file: describe() (rule-tests-top-level-it,
// the #3120 case) on line 2 and a focused test (no-skip-only) on line 3. The focus modifier is
// spelt in two pieces so that test-guard does not flag this file itself.
const STATIC_PROBLEMS = {
  'test/spec/identity/devices.test.ts': [
    "import { describe, it } from 'vitest';",
    "describe('devices', () => {",
    '  it.' + 'only' + "('[BR-ID-05] x', () => {});",
    '});',
    '',
  ].join('\n'),
};

type RedDryPlan = {
  red_files?: string[];
  test_guard?: { findings: number; add_only_violations: number };
};

it(
  '[CT-06zzzzt] --red: static test-guard findings stop the run before anything runs (exit 2, every finding listed)',
  () => {
    const repo = redRepo('red-tg-findings', {}, STATIC_PROBLEMS);
    const res = run(['B1-02b', '--worktree', repo, '--red', '--base', 'main', '--dry-run']);
    expect(res.status, res.stderr).toBe(2);
    // No plan is printed: the run stops before the dry-run plan.
    expect(res.stdout).toBe('');
    const head = res.stderr
      .split('\n')
      .find((l) => l.startsWith('verify-container: test-guard (trusted, against main):'));
    expect(head, res.stderr).toBeDefined();
    // The count of findings is in the message.
    expect(head).toMatch(/\b2\b/);
    // Each finding is listed.
    expect(res.stderr).toContain('test/spec/identity/devices.test.ts');
    expect(res.stderr).toContain('no-skip-only');
    expect(res.stderr).toContain('rule-tests-top-level-it');
    // Never "add-only": the owner label does not let these through.
    expect(res.stderr).not.toContain('add-only finding(s)');
    expect(existsSync(join(runs, 'B1-02b'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzt] --red --dry-run: a clean test-guard goes on, the plan carries test_guard with zero counts',
  () => {
    const repo = redRepo(
      'red-tg-clean',
      {},
      { 'test/spec/identity/devices.test.ts': "it('[BR-ID-05] x', () => {});\n" },
    );
    const res = run(['B1-02b', '--worktree', repo, '--red', '--base', 'main', '--dry-run']);
    expect(res.status, res.stderr).toBe(0);
    const plan = JSON.parse(res.stdout) as RedDryPlan;
    expect(plan.red_files).toEqual(['test/spec/identity/devices.test.ts']);
    expect(plan.test_guard).toEqual({ findings: 0, add_only_violations: 0 });
    expect(res.stderr).not.toContain('add-only finding(s)');
    expect(res.stderr).not.toContain('test-guard (trusted');
    expect(existsSync(join(runs, 'B1-02b'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzt] --red: add-only findings alone (changed frozen test assets) are noted on stderr and the run goes on; with a static finding too it stops',
  () => {
    const frozen = {
      'test/spec/identity/sessions.test.ts': "it('[BR-ID-05] a', () => {});\n",
      'test/spec/identity/tokens.test.ts': "it('[BR-ID-05] b', () => {});\n",
    };
    // One frozen file modified, one deleted: two add-only violations, no static finding.
    const repo = redRepo(
      'red-tg-add-only',
      frozen,
      {
        'test/spec/identity/sessions.test.ts': "it('[BR-ID-05] a changed', () => {});\n",
        'test/spec/identity/devices.test.ts': "it('[BR-ID-05] x', () => {});\n",
      },
      ['test/spec/identity/tokens.test.ts'],
    );
    const res = run(['B1-02b', '--worktree', repo, '--red', '--base', 'main', '--dry-run']);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toContain(
      'verify-container: test-guard: 2 add-only finding(s) (changed frozen test assets): CI lets them through only with the owner approval label',
    );
    expect(res.stderr).not.toContain('test-guard (trusted');
    const plan = JSON.parse(res.stdout) as RedDryPlan;
    expect(plan.red_files).toContain('test/spec/identity/devices.test.ts');
    expect(plan.test_guard).toEqual({ findings: 0, add_only_violations: 2 });

    // The same branch with a static finding as well: the findings decide, exit 2.
    writeFiles(repo, STATIC_PROBLEMS);
    const both = run(['B1-02b', '--worktree', repo, '--red', '--base', 'main', '--dry-run']);
    expect(both.status, both.stderr).toBe(2);
    expect(both.stdout).toBe('');
    expect(both.stderr).toContain('verify-container: test-guard (trusted, against main):');
    expect(existsSync(join(runs, 'B1-02b'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzt] --red: a test-guard that cannot run (no JSON) stops the run with exit 2 naming test-guard',
  () => {
    const repo = redRepo(
      'red-tg-broken',
      {},
      { 'test/spec/identity/devices.test.ts': "it('[BR-ID-05] x', () => {});\n" },
    );
    // A file test-guard must read but cannot: it ends with an internal error (EACCES) and prints
    // no JSON; red-check --print-expected still lists the file (it only reads git).
    const locked = join(repo, 'test', 'spec', 'identity', 'locked.test.ts');
    writeFileSync(locked, "it('[BR-ID-05] y', () => {});\n");
    chmodSync(locked, 0o000);
    try {
      const res = run(['B1-02b', '--worktree', repo, '--red', '--base', 'main', '--dry-run']);
      expect(res.status, res.stderr).toBe(2);
      expect(res.stdout).toBe('');
      const line = res.stderr.split('\n').find((l) => l.startsWith('verify-container:')) ?? '';
      expect(line, res.stderr).toContain('test-guard');
      // The first lines of test-guard's stderr are quoted.
      expect(res.stderr).toContain('EACCES');
      expect(existsSync(join(runs, 'B1-02b'))).toBe(false);
    } finally {
      chmodSync(locked, 0o644);
    }
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzt] test-guard runs for --red only: verify, --fast and --browser dry-runs are unchanged',
  () => {
    const repo = redRepo('red-tg-other-modes', {}, STATIC_PROBLEMS);
    for (const extra of [[], ['--fast'], ['--browser']]) {
      const res = run(['B1-02b', '--worktree', repo, ...extra, '--dry-run']);
      expect(res.status, `${extra.join(' ')}: ${res.stderr}`).toBe(0);
      const plan = JSON.parse(res.stdout) as Record<string, unknown>;
      // CT-06zzzzu added memory to every dry-run plan; test_guard stays --red only.
      expect(Object.keys(plan).sort(), extra.join(' ')).toEqual([
        'commit',
        'memory',
        'script',
        'tree',
      ]);
      expect(res.stderr, extra.join(' ')).not.toContain('test-guard');
    }
    expect(existsSync(join(runs, 'B1-02b'))).toBe(false);
  },
  CLI_TIMEOUT,
);

// --- CT-06zzzzu (FU-VERIFY-CONTAINER-MEMORY, D10-1219 / D10-1283 ③): COULI_VERIFY_MEMORY --------

/** A committed fixture repository (the plan then names its commit and tree). */
function committedFixture(name: string): string {
  const repo = fixture(name, 'node -e "process.exit(0)"');
  fixtureGit(repo, ['init', '-q', '-b', 'main']);
  fixtureGit(repo, ['add', '-A']);
  fixtureGit(repo, ['commit', '-q', '-m', 'fixture']);
  return repo;
}

/** A committed fixture with one rule test of B1-02b (as [CR3-01]), so that --red has a plan. */
function redFixture(name: string): string {
  const repo = committedFixture(name);
  writeFiles(repo, { 'test/spec/identity/devices.test.ts': "it('[BR-ID-05] x', () => {});\n" });
  return repo;
}

const MEMORY_MODES: { name: string; task: string; args: (wt: string) => string[] }[] = [
  { name: 'verify', task: 'V1-07', args: (wt) => ['--worktree', wt] },
  { name: 'verify:fast', task: 'V1-07', args: (wt) => ['--worktree', wt, '--fast'] },
  { name: 'browser', task: 'V1-07', args: (wt) => ['--worktree', wt, '--browser'] },
  {
    name: 'red',
    task: 'B1-02b',
    args: (wt) => ['--worktree', wt, '--red', '--base', 'main'],
  },
];

it(
  '[CT-06zzzzu] --dry-run: memory is null when COULI_VERIFY_MEMORY is unset or empty',
  () => {
    const plain = committedFixture('memory-unset');
    const red = redFixture('memory-unset-red');
    for (const mode of MEMORY_MODES) {
      const wt = mode.name === 'red' ? red : plain;
      for (const env of [{}, { COULI_VERIFY_MEMORY: '' }]) {
        const res = run([mode.task, ...mode.args(wt), '--dry-run'], env);
        expect(res.status, `${mode.name} ${res.stderr}`).toBe(0);
        const plan = JSON.parse(res.stdout) as Record<string, unknown>;
        expect(plan['script'], mode.name).toBe(mode.name);
        expect(Object.keys(plan), mode.name).toContain('memory');
        expect(plan['memory'], mode.name).toBeNull();
      }
    }
    expect(existsSync(join(runs, 'V1-07'))).toBe(false);
    expect(existsSync(join(runs, 'B1-02b'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzu] --dry-run: memory is the value of COULI_VERIFY_MEMORY when it is valid',
  () => {
    const plain = committedFixture('memory-set');
    const red = redFixture('memory-set-red');
    for (const mode of MEMORY_MODES) {
      const wt = mode.name === 'red' ? red : plain;
      const res = run([mode.task, ...mode.args(wt), '--dry-run'], { COULI_VERIFY_MEMORY: '9g' });
      expect(res.status, `${mode.name} ${res.stderr}`).toBe(0);
      const plan = JSON.parse(res.stdout) as Record<string, unknown>;
      expect(plan['script'], mode.name).toBe(mode.name);
      expect(plan['memory'], mode.name).toBe('9g');
    }
    // The other valid forms: megabytes, and up to six digits.
    for (const value of ['12g', '512m', '1m', '999999m', '100000g']) {
      const res = run(['V1-07', '--worktree', plain, '--dry-run'], { COULI_VERIFY_MEMORY: value });
      expect(res.status, `${value} ${res.stderr}`).toBe(0);
      expect((JSON.parse(res.stdout) as Record<string, unknown>)['memory'], value).toBe(value);
    }
    expect(existsSync(join(runs, 'V1-07'))).toBe(false);
  },
  CLI_TIMEOUT,
);

const BAD_MEMORY = [
  '9',
  '9G',
  '0g',
  '9gb',
  '-1g',
  ' 9g',
  '9g ',
  '9.5g',
  'g',
  '09g',
  '1234567g',
  '9k',
];

it(
  '[CT-06zzzzu] an invalid COULI_VERIFY_MEMORY stops a --dry-run with exit 2, naming the variable',
  () => {
    const plain = committedFixture('memory-bad-dry');
    const red = redFixture('memory-bad-dry-red');
    for (const value of BAD_MEMORY) {
      for (const mode of MEMORY_MODES) {
        const wt = mode.name === 'red' ? red : plain;
        const res = run([mode.task, ...mode.args(wt), '--dry-run'], { COULI_VERIFY_MEMORY: value });
        expect(res.status, `${mode.name} '${value}'`).toBe(2);
        expect(res.stderr, `${mode.name} '${value}'`).toContain('COULI_VERIFY_MEMORY');
        expect(res.stdout, `${mode.name} '${value}'`).toBe('');
      }
    }
    expect(existsSync(join(runs, 'V1-07'))).toBe(false);
    expect(existsSync(join(runs, 'B1-02b'))).toBe(false);
  },
  CLI_TIMEOUT * 2,
);

it(
  '[CT-06zzzzu] an invalid COULI_VERIFY_MEMORY stops a real run before any docker call and any run directory',
  () => {
    // A stub docker first on PATH records every call; nothing may reach it.
    const bin = join(base, 'memory-bin');
    const calls = join(base, 'memory-docker-calls.txt');
    writeFiles(bin, {
      docker: '#!/bin/sh\nprintf \'%s\\n\' "$*" >>"$COULI_TEST_DOCKER_CALLS"\nexit 1\n',
    });
    chmodSync(join(bin, 'docker'), 0o755);
    const ws = fixture('memory-bad-real', 'true');
    for (const value of ['9', '9G', '0g', '9gb', '-1g', ' 9g', '9.5g']) {
      for (const extra of [[], ['--fast'], ['--browser']]) {
        const res = run(['V1-08', '--worktree', ws, ...extra], {
          COULI_VERIFY_MEMORY: value,
          COULI_TEST_DOCKER_CALLS: calls,
          COULI_VERIFY_SLOT_DIR: join(base, 'memory-slot'),
          PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        });
        expect(res.status, `${extra.join(' ')} '${value}'`).toBe(2);
        expect(res.stderr, `${extra.join(' ')} '${value}'`).toContain('COULI_VERIFY_MEMORY');
        expect(existsSync(join(runs, 'V1-08')), `${extra.join(' ')} '${value}'`).toBe(false);
      }
    }
    expect(existsSync(calls)).toBe(false);
  },
  CLI_TIMEOUT * 2,
);

/**
 * The docker run commands of the script whose first line contains `head` (comment lines skipped),
 * each with its continuation lines joined into one string.
 */
function dockerRuns(text: string, head: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    i += 1;
    if (line.trimStart().startsWith('#') || !line.includes(head)) continue;
    let cmd = line;
    while (cmd.endsWith('\\') && i < lines.length) {
      cmd = `${cmd.slice(0, -1)} ${lines[i] ?? ''}`;
      i += 1;
    }
    out.push(cmd);
  }
  return out;
}

it('[CT-06zzzzu] only the containers that run tests get --memory and --memory-swap of one value', () => {
  const text = readFileSync(SCRIPT, 'utf8');
  // The array (or arrays) that carry the limit: --memory and --memory-swap from the same variable.
  const assigns = [
    ...text.matchAll(
      /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)\+?=\([^)\n]*--memory[ =]"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"[^)\n]*--memory-swap[ =]"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"/gm,
    ),
  ];
  expect(assigns.length).toBeGreaterThan(0);
  for (const m of assigns) expect(m[3], m[0]).toBe(m[2]);
  const names = [...new Set(assigns.map((m) => m[1] ?? ''))];
  // Expanded the set -u safe way, so that an empty array adds nothing on bash 3.2.
  const uses = (cmd: string) => names.some((n) => cmd.includes(`\${${n}[@]+"\${${n}[@]}"}`));
  const mentions = (cmd: string) =>
    names.some((n) => cmd.includes(`\${${n}[@]`)) || /(^|\s)--memory(-swap)?[\s=]/.test(cmd);

  // Test containers: --browser, --fast and the full verify (one line for both service modes) …
  const verifyRuns = dockerRuns(text, 'docker run --rm --name "$VERIFY_NAME"');
  expect(verifyRuns).toHaveLength(3);
  // … and the --red groups (red_container, with or without a database).
  const redRuns = dockerRuns(text, 'docker run --rm --name "$1"');
  expect(redRuns).toHaveLength(1);
  for (const cmd of [...verifyRuns, ...redRuns]) expect(uses(cmd), cmd).toBe(true);

  // pnpm fetch, PostgreSQL and Redis: never.
  const others = [
    ...dockerRuns(text, 'docker run --rm --name "$FETCH_NAME"'),
    ...dockerRuns(text, 'docker run -d --name "$PG_NAME"'),
    ...dockerRuns(text, 'docker run -d --name "$REDIS_NAME"'),
  ];
  expect(others).toHaveLength(3);
  for (const cmd of others) expect(mentions(cmd), cmd).toBe(false);
  // The image build neither.
  for (const cmd of dockerRuns(text, 'docker build ')) expect(mentions(cmd), cmd).toBe(false);
});

it('[CT-06zzzzu] the variable is documented in the script header and in tools/ops/README.md', () => {
  const header = readFileSync(SCRIPT, 'utf8').split('\nset -')[0] ?? '';
  expect(header).toMatch(/^#.*COULI_VERIFY_MEMORY/m);
  expect(readFileSync(join(OPS_DIR, 'README.md'), 'utf8')).toContain('COULI_VERIFY_MEMORY');
});

// --- CT-06zzzzv (FU-RED-RUNS-TEST-GUARD, D10-1292 step 1): --related ----------------------------
// `vitest related` on the PR head for the source files the branch changed (tools/ops/
// related-sources.ts). The fixture: `main` with one source and one frozen test, then a branch
// `task` that commits `changes` on top (related-sources diffs <base>...HEAD, commits only).

const RELATED_SOURCE = 'apps/api/src/modules/content/domain/config-registry.ts';
const RELATED_TEST = 'test/spec/content/config-items/registry.test.ts';

function relatedRepo(
  name: string,
  changes: Record<string, string>,
): { repo: string; head: string; tree: string; mainCommit: string } {
  const repo = fixture(name, 'node -e "process.exit(0)"');
  writeFiles(repo, {
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    [RELATED_SOURCE]: 'export const keys = [];\n',
    [RELATED_TEST]: "it('[BR-CONTENT-01] x', () => {});\n",
  });
  fixtureGit(repo, ['init', '-q', '-b', 'main']);
  fixtureGit(repo, ['add', '-A']);
  fixtureGit(repo, ['commit', '-q', '-m', 'fixture']);
  const mainCommit = fixtureGit(repo, ['rev-parse', 'HEAD']);
  fixtureGit(repo, ['checkout', '-q', '-b', 'task']);
  writeFiles(repo, changes);
  fixtureGit(repo, ['add', '-A']);
  fixtureGit(repo, ['commit', '-q', '-m', 'task']);
  return {
    repo,
    head: fixtureGit(repo, ['rev-parse', 'HEAD']),
    tree: fixtureGit(repo, ['rev-parse', 'HEAD^{tree}']),
    mainCommit,
  };
}

it(
  '[CT-06zzzzv] --related --dry-run: the plan names script related, commit, tree, base and only the changed source files',
  () => {
    const fx = relatedRepo('related-dry', {
      [RELATED_SOURCE]: "export const keys = ['new.key'];\n",
      [RELATED_TEST]: "it('[BR-CONTENT-01] x changed', () => {});\n",
    });
    const res = run(['B1-02b', '--worktree', fx.repo, '--related', '--base', 'main', '--dry-run']);
    expect(res.status, res.stderr).toBe(0);
    const plan = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(plan).toMatchObject({
      script: 'related',
      commit: fx.head,
      tree: fx.tree,
      base: 'main',
      sources: [RELATED_SOURCE],
      memory: null,
    });
    // --red's fields stay --red's.
    expect(plan).not.toHaveProperty('red_files');
    expect(plan).not.toHaveProperty('test_guard');

    // Without --base: the merge base with main, as --red takes it.
    const noBase = run(['B1-02b', '--worktree', fx.repo, '--related', '--dry-run']);
    expect(noBase.status, noBase.stderr).toBe(0);
    expect(JSON.parse(noBase.stdout)).toMatchObject({
      script: 'related',
      base: fx.mainCommit,
      sources: [RELATED_SOURCE],
    });
    // No run directory for a plan.
    expect(existsSync(join(runs, 'B1-02b'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzv] --related --dry-run carries COULI_VERIFY_MEMORY as memory; an invalid value stops it with exit 2',
  () => {
    const fx = relatedRepo('related-memory', {
      [RELATED_SOURCE]: "export const keys = ['new.key'];\n",
    });
    const args = ['B1-02b', '--worktree', fx.repo, '--related', '--base', 'main', '--dry-run'];
    const ok = run(args, { COULI_VERIFY_MEMORY: '9g' });
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ script: 'related', memory: '9g' });
    for (const value of ['9G', '0g', '9gb']) {
      const bad = run(args, { COULI_VERIFY_MEMORY: value });
      expect(bad.status, value).toBe(2);
      expect(bad.stderr, value).toContain('COULI_VERIFY_MEMORY');
      expect(bad.stdout, value).toBe('');
    }
    expect(existsSync(join(runs, 'B1-02b'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzv] --related together with --fast, --red or --browser is a usage error',
  () => {
    const ok = fixture('related-usage', 'true');
    for (const other of ['--fast', '--red', '--browser']) {
      for (const pair of [
        ['--related', other],
        [other, '--related'],
      ]) {
        const res = run(['V1-10', '--worktree', ok, ...pair, '--dry-run']);
        expect(res.status, pair.join(' ')).toBe(2);
        expect(res.stderr, pair.join(' ')).toContain('at most one of');
        expect(res.stdout, pair.join(' ')).toBe('');
      }
    }
    expect(existsSync(join(runs, 'V1-10'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzv] --base is still refused for verify, --fast and --browser, with the new message',
  () => {
    const ok = fixture('related-base', 'true');
    for (const extra of [[], ['--fast'], ['--browser']]) {
      const res = run(['V1-10', '--worktree', ok, ...extra, '--base', 'main', '--dry-run']);
      expect(res.status, extra.join(' ')).toBe(2);
      expect(res.stderr, extra.join(' ')).toContain('--base applies to --red and --related only');
    }
    expect(existsSync(join(runs, 'V1-10'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzv] --related: a source path outside [A-Za-z0-9_./@-] stops the run with exit 2',
  () => {
    const fx = relatedRepo('related-bad-path', {
      'packages/money/src/名字.ts': 'export const n = 1;\n',
    });
    const res = run(['B1-02b', '--worktree', fx.repo, '--related', '--base', 'main', '--dry-run']);
    expect(res.status, res.stderr).toBe(2);
    expect(res.stdout).toBe('');
    // Refused for the path, not as an unknown option.
    expect(res.stderr).toMatch(/^verify-container: /m);
    expect(res.stderr).not.toContain('unknown option');
    expect(existsSync(join(runs, 'B1-02b'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzv] --related without a source change starts no container: related/<n>/related.json is skipped, result.json exit 0',
  () => {
    // Only a test file and a document changed: nothing for vitest related.
    const fx = relatedRepo('related-skip', {
      [RELATED_TEST]: "it('[BR-CONTENT-01] x changed', () => {});\n",
      'docs/a.md': '# a\n',
    });
    const bin = join(base, 'related-bin');
    const calls = join(base, 'related-docker-calls.txt');
    writeFiles(bin, {
      docker: '#!/bin/sh\nprintf \'%s\\n\' "$*" >>"$COULI_TEST_DOCKER_CALLS"\nexit 1\n',
    });
    chmodSync(join(bin, 'docker'), 0o755);
    const relatedRuns = join(base, 'related-runs');
    const env = {
      COULI_RUNS: relatedRuns,
      COULI_TEST_DOCKER_CALLS: calls,
      COULI_VERIFY_SLOT_DIR: join(base, 'related-slot'),
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
    };

    const dry = run(
      ['B1-02b', '--worktree', fx.repo, '--related', '--base', 'main', '--dry-run'],
      env,
    );
    expect(dry.status, dry.stderr).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({ script: 'related', sources: [] });
    expect(existsSync(join(relatedRuns, 'B1-02b'))).toBe(false);

    const res = run(['B1-02b', '--worktree', fx.repo, '--related', '--base', 'main'], env);
    expect(res.status, res.stderr).toBe(0);
    const vdir = join(relatedRuns, 'B1-02b', 'related', '1');
    const related = JSON.parse(readFileSync(join(vdir, 'related.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(related).toMatchObject({
      status: 'skipped',
      reason: 'no source change',
      base: 'main',
      commit: fx.head,
      sources: [],
    });
    const result = JSON.parse(readFileSync(join(vdir, 'result.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({
      mode: 'container',
      script: 'related',
      exit_code: 0,
      commit: fx.head,
    });
    // Same shape as the other modes' result.json.
    for (const key of ['tree', 'prop_seed', 'prop_runs', 'started_at', 'finished_at']) {
      expect(Object.keys(result), key).toContain(key);
    }
    // The snapshot (if any was made) is not kept.
    expect(existsSync(join(vdir, 'src'))).toBe(false);

    // A second run takes the next number; without --base the base is the merge base with main.
    const again = run(['B1-02b', '--worktree', fx.repo, '--related'], env);
    expect(again.status, again.stderr).toBe(0);
    const second = JSON.parse(
      readFileSync(join(relatedRuns, 'B1-02b', 'related', '2', 'related.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(second).toMatchObject({ status: 'skipped', base: fx.mainCommit, sources: [] });

    // Docker was never called.
    expect(existsSync(calls)).toBe(false);
  },
  CLI_TIMEOUT,
);

// --- CT-06zzzzv round 2 (D10-1337): the real --related run against a stub docker ----------------
// A stub `docker` first on PATH records every call (JSON lines, with the environment handed to the
// container) and answers like a healthy daemon with the image and the store in place. The test
// container (`--name <prefix>-run-…`) writes into the directory mounted on /out what the case file
// STUB_RELATED_SPEC says ({ exit, files: { <name>: { text } | { symlink } | { fifo } | { dir } } })
// and exits with `exit`; related_judge on the host then reads vitest.exit, vitest.seconds and
// vitest-report.json from there.

const RELATED_STUB = String.raw`'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const env = {};
args.forEach((a, i) => {
  if (args[i - 1] !== '-e') return;
  const eq = a.indexOf('=');
  if (eq === -1) env[a] = process.env[a] ?? null;
  else env[a.slice(0, eq)] = a.slice(eq + 1);
});
fs.appendFileSync(process.env.STUB_DOCKER_LOG, JSON.stringify({ args, env }) + '\n');
function answer(text, code) {
  if (text !== '') fs.writeSync(1, text + '\n');
  process.exit(code);
}
if (args[0] === 'version') answer('28.0.1', 0);
const at = args.indexOf('--name');
const name = at === -1 ? '' : args[at + 1] || '';
if (args[0] === 'run' && /-run-/.test(name)) {
  const spec = process.env.STUB_RELATED_SPEC
    ? JSON.parse(fs.readFileSync(process.env.STUB_RELATED_SPEC, 'utf8'))
    : { exit: 0, files: {} };
  const mount = args.find((a, i) => args[i - 1] === '-v' && a.endsWith(':/out'));
  if (mount) {
    const out = mount.slice(0, -':/out'.length);
    for (const [file, how] of Object.entries(spec.files || {})) {
      const p = out + '/' + file;
      if (typeof how.text === 'string') fs.writeFileSync(p, how.text);
      else if (typeof how.symlink === 'string') fs.symlinkSync(how.symlink, p);
      else if (how.fifo) spawnSync('mkfifo', [p]);
      else if (how.dir) fs.mkdirSync(p);
    }
  }
  answer('', spec.exit ?? 0);
}
answer('', 0);
`;

type DockerCall = { args: string[]; env: Record<string, string | null> };
type StubbedRun = {
  status: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  calls: DockerCall[];
};
type OutFile = { text: string } | { symlink: string } | { fifo: true } | { dir: true };
type ContainerSpec = { exit?: number; files: Record<string, OutFile> };

let stubBin = '';
let stubRuns = 0;

function stubDocker(): string {
  if (stubBin !== '') return stubBin;
  stubBin = join(base, 'related-stub-bin');
  writeFiles(stubBin, { 'docker-stub.cjs': RELATED_STUB });
  const docker = join(stubBin, 'docker');
  writeFileSync(
    docker,
    `#!/bin/sh\nexec '${process.execPath}' '${join(stubBin, 'docker-stub.cjs')}' "$@"\n`,
  );
  chmodSync(docker, 0o755);
  return stubBin;
}

/**
 * Runs the script against the stub docker in its own process group; past `limitMs` the whole
 * group is killed (a host that reads a FIFO from out/ would hang) and timedOut is true.
 */
function runStubbed(
  args: string[],
  runsDir: string,
  spec: ContainerSpec | null,
  limitMs = 45_000,
): Promise<StubbedRun> {
  stubRuns += 1;
  const log = join(base, `related-calls-${String(stubRuns)}.jsonl`);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    'COULI_VERIFY_MEMORY',
    'PROP_RUNS',
    'PROP_SEED',
    'COULI_VERIFY_TIMEOUT_SECS',
    'COULI_VERIFY_HOST_SERVICES',
    'COULI_VERIFY_VITEST_MAX_WORKERS',
  ]) {
    Reflect.deleteProperty(env, name);
  }
  Object.assign(env, {
    PATH: `${stubDocker()}:${process.env['PATH'] ?? ''}`,
    COULI_RUNS: runsDir,
    COULI_TRUSTED_ROOT: repoRoot(),
    COULI_VERIFY_PREFIX: 'couli-reltest',
    COULI_VERIFY_SLOT_DIR: join(runsDir, 'slot'),
    STUB_DOCKER_LOG: log,
  });
  if (spec !== null) {
    const specFile = join(base, `related-spec-${String(stubRuns)}.json`);
    writeFileSync(specFile, JSON.stringify(spec));
    env['STUB_RELATED_SPEC'] = specFile;
  }
  return new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT, ...args], { env, detached: true, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-(child.pid ?? 0), 'SIGKILL');
      } catch {
        // already gone
      }
    }, limitMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const calls = existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter((l) => l !== '')
            .map((l) => JSON.parse(l) as DockerCall)
        : [];
      resolve({ status: code ?? -1, stdout, stderr, timedOut, calls });
    });
  });
}

/** The test container's docker run (the one named <prefix>-run-…). */
function testContainer(calls: readonly DockerCall[]): DockerCall | undefined {
  return calls.find((c) => {
    const at = c.args.indexOf('--name');
    return c.args[0] === 'run' && at !== -1 && /-run-/.test(c.args[at + 1] ?? '');
  });
}

const RUN_ROOT = '/work/repo';

type ReportTest = { ancestors?: string[]; title: string; status: string };
type ReportFile = { rel: string; status: string; tests: ReportTest[]; message?: string };

/** A Vitest `--reporter=json` report as the container writes it (paths under /work/repo). */
function vitestReport(files: ReportFile[]): string {
  const all = files.flatMap((f) => f.tests);
  return JSON.stringify({
    numTotalTests: all.length,
    numFailedTests: all.filter((t) => t.status === 'failed').length,
    numPassedTests: all.filter((t) => t.status === 'passed').length,
    success: all.every((t) => t.status !== 'failed'),
    testResults: files.map((f) => ({
      name: `${RUN_ROOT}/${f.rel}`,
      status: f.status,
      message: f.message ?? '',
      assertionResults: f.tests.map((t) => ({
        ancestorTitles: t.ancestors ?? [],
        title: t.title,
        fullName: [...(t.ancestors ?? []), t.title].join(' '),
        status: t.status,
      })),
    })),
  });
}

const GREEN_REPORT = vitestReport([
  {
    rel: RELATED_TEST,
    status: 'passed',
    tests: [
      { ancestors: ['registry'], title: '[BR-CONTENT-01] lists every key', status: 'passed' },
      { title: '[BR-CONTENT-01] keys are unique', status: 'passed' },
    ],
  },
  {
    rel: 'apps/api/src/modules/content/domain/config-registry.test.ts',
    status: 'passed',
    tests: [{ title: 'loads', status: 'passed' }],
  },
]);

const RED_REPORT = vitestReport([
  {
    rel: RELATED_TEST,
    status: 'failed',
    tests: [
      { ancestors: ['registry'], title: '[BR-CONTENT-01] lists every key', status: 'failed' },
      { title: '[BR-CONTENT-01] keys are unique', status: 'passed' },
    ],
  },
]);

function out(vitestExit: string, report: string | null, seconds = '12'): ContainerSpec {
  const files: Record<string, OutFile> = {
    'vitest.exit': { text: `${vitestExit}\n` },
    'vitest.seconds': { text: `${seconds}\n` },
  };
  if (report !== null) files['vitest-report.json'] = { text: report };
  return { exit: 0, files };
}

/** A workspace the container path accepts, with `main` and a branch `task` that changed a source. */
function relatedWorkspace(
  name: string,
  changes: Record<string, string> = { [RELATED_SOURCE]: "export const keys = ['new.key'];\n" },
  edit?: (repo: string) => void,
): { repo: string; head: string } {
  const root = JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as {
    packageManager: string;
  };
  const repo = join(base, name);
  writeFiles(repo, {
    'package.json': `${JSON.stringify(
      { name, private: true, packageManager: root.packageManager, scripts: { verify: 'true' } },
      null,
      2,
    )}\n`,
    'pnpm-workspace.yaml': 'packages: []\n',
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    [RELATED_SOURCE]: 'export const keys = [];\n',
    [RELATED_TEST]: "it('[BR-CONTENT-01] x', () => {});\n",
    'packages/money/src/old.ts': 'export const old = 1;\n',
    'packages/money/src/before.ts':
      'export const before = 1;\nexport const twice = 2;\nexport const thrice = 3;\n',
  });
  fixtureGit(repo, ['init', '-q', '-b', 'main']);
  fixtureGit(repo, ['add', '-A']);
  fixtureGit(repo, ['commit', '-q', '-m', 'fixture']);
  fixtureGit(repo, ['checkout', '-q', '-b', 'task']);
  writeFiles(repo, changes);
  edit?.(repo);
  fixtureGit(repo, ['add', '-A']);
  fixtureGit(repo, ['commit', '-q', '-m', 'task']);
  return { repo, head: fixtureGit(repo, ['rev-parse', 'HEAD']) };
}

let relatedFx: { repo: string; head: string } | null = null;
function relatedFixture(): { repo: string; head: string } {
  relatedFx ??= relatedWorkspace('related-judge');
  return relatedFx;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

const RELATED_ARGS = (repo: string) => [
  'B1-02b',
  '--worktree',
  repo,
  '--related',
  '--base',
  'main',
];
const JUDGE_TIMEOUT = 120_000;

it(
  '[CT-06zzzzv] --related green: exit 0, related.json green with the counts, result.json written; the container is offline, mounts out/ and gets no VERIFY_SCRIPT',
  async () => {
    const fx = relatedFixture();
    const runsDir = join(base, 'rj-green');
    const res = await runStubbed(RELATED_ARGS(fx.repo), runsDir, out('0', GREEN_REPORT));
    expect(res.timedOut).toBe(false);
    expect(res.status, res.stderr).toBe(0);
    const vdir = join(runsDir, 'B1-02b', 'related', '1');
    expect(readJson(join(vdir, 'related.json'))).toMatchObject({
      status: 'green',
      base: 'main',
      commit: fx.head,
      sources: [RELATED_SOURCE],
      related_files: 2,
      tests: 3,
      duration_s: 12,
      over_cap: false,
      failed: [],
      load_errors: [],
      data_sources: [],
      removed_or_renamed: [],
      force_all: false,
    });
    expect(readJson(join(vdir, 'result.json'))).toMatchObject({
      mode: 'container',
      script: 'related',
      exit_code: 0,
      commit: fx.head,
    });
    // ⑤: the closing line carries the counts.
    expect(`${res.stdout}\n${res.stderr}`).toContain('2 file(s), 3 test(s)');

    const container = testContainer(res.calls);
    expect(container, JSON.stringify(res.calls.map((c) => c.args[0]))).toBeDefined();
    const args = container?.args ?? [];
    expect(args[args.indexOf('--network') + 1]).toBe('none');
    const mounts = args.filter((a, i) => args[i - 1] === '-v' && a.endsWith(':/out'));
    expect(mounts).toHaveLength(1);
    const real = realpathSync(runsDir);
    expect([`${runsDir}/B1-02b/related/1/out:/out`, `${real}/B1-02b/related/1/out:/out`]).toContain(
      mounts[0],
    );
    expect(Object.keys(container?.env ?? {})).not.toContain('VERIFY_SCRIPT');
    expect(args.some((a) => a.startsWith('VERIFY_SCRIPT'))).toBe(false);
  },
  JUDGE_TIMEOUT,
);

it(
  '[CT-06zzzzv] --related red: exit 1, every red test on stdout as "file > full name", related.json red, result.json exit 1',
  async () => {
    const fx = relatedFixture();
    const runsDir = join(base, 'rj-red');
    const res = await runStubbed(RELATED_ARGS(fx.repo), runsDir, out('1', RED_REPORT));
    expect(res.timedOut).toBe(false);
    expect(res.status, res.stderr).toBe(1);
    expect(res.stdout.split('\n')).toContain(
      `${RELATED_TEST} > registry > [BR-CONTENT-01] lists every key`,
    );
    expect(res.stdout).not.toContain('keys are unique');
    const vdir = join(runsDir, 'B1-02b', 'related', '1');
    expect(readJson(join(vdir, 'related.json'))).toMatchObject({
      status: 'red',
      failed: [{ file: RELATED_TEST, test: 'registry > [BR-CONTENT-01] lists every key' }],
    });
    expect(readJson(join(vdir, 'result.json'))).toMatchObject({ script: 'related', exit_code: 1 });
    expect(`${res.stdout}\n${res.stderr}`).toContain('1 file(s), 2 test(s)');
  },
  JUDGE_TIMEOUT,
);

it(
  '[CT-06zzzzv] --related with sources but no related test: exit 0, related.json no_related_tests, "0 file(s), 0 test(s)"',
  async () => {
    const fx = relatedFixture();
    const runsDir = join(base, 'rj-none');
    const res = await runStubbed(RELATED_ARGS(fx.repo), runsDir, out('0', vitestReport([])));
    expect(res.timedOut).toBe(false);
    expect(res.status, res.stderr).toBe(0);
    const vdir = join(runsDir, 'B1-02b', 'related', '1');
    expect(readJson(join(vdir, 'related.json'))).toMatchObject({
      status: 'no_related_tests',
      sources: [RELATED_SOURCE],
      related_files: 0,
      tests: 0,
    });
    expect(readJson(join(vdir, 'result.json'))).toMatchObject({ script: 'related', exit_code: 0 });
    expect(`${res.stdout}\n${res.stderr}`).toContain('0 file(s), 0 test(s)');
  },
  JUDGE_TIMEOUT,
);

// Exit 2 and no result.json: nothing trustworthy came out of the container.
const outsideDir = () => join(base, 'related-outside');
const ENV_ERRORS: { what: string; spec: () => ContainerSpec; limitMs?: number }[] = [
  { what: 'the container exits non-zero', spec: () => ({ ...out('0', GREEN_REPORT), exit: 3 }) },
  {
    what: 'vitest.exit is missing',
    spec: () => {
      const s = out('0', GREEN_REPORT);
      Reflect.deleteProperty(s.files, 'vitest.exit');
      return s;
    },
  },
  { what: 'vitest.exit is 124 (time limit)', spec: () => out('124', GREEN_REPORT) },
  { what: 'the report is missing', spec: () => out('0', null) },
  { what: 'the report is not the expected shape', spec: () => out('1', '{"testResults":"x"}') },
  { what: 'the report is not JSON', spec: () => out('1', '{ not json') },
  { what: 'Vitest exited 1 but the report has nothing red', spec: () => out('1', GREEN_REPORT) },
  // ②: out/ is written by untrusted code; the host reads only regular files there.
  {
    what: 'vitest.exit is a symbolic link (to a file that says 0)',
    spec: () => {
      writeFiles(outsideDir(), { 'exit-zero': '0\n' });
      return {
        exit: 0,
        files: {
          'vitest.exit': { symlink: join(outsideDir(), 'exit-zero') },
          'vitest.seconds': { text: '12\n' },
          'vitest-report.json': { text: GREEN_REPORT },
        },
      };
    },
  },
  {
    what: 'vitest.exit is a FIFO (the host must not hang)',
    limitMs: 20_000,
    spec: () => ({
      exit: 0,
      files: {
        'vitest.exit': { fifo: true },
        'vitest.seconds': { text: '12\n' },
        'vitest-report.json': { text: GREEN_REPORT },
      },
    }),
  },
  {
    what: 'vitest.exit is a directory',
    spec: () => ({
      exit: 0,
      files: {
        'vitest.exit': { dir: true },
        'vitest.seconds': { text: '12\n' },
        'vitest-report.json': { text: GREEN_REPORT },
      },
    }),
  },
  {
    what: 'vitest.seconds is a symbolic link',
    spec: () => {
      writeFiles(outsideDir(), { seconds: '12\n' });
      return {
        exit: 0,
        files: {
          'vitest.exit': { text: '0\n' },
          'vitest.seconds': { symlink: join(outsideDir(), 'seconds') },
          'vitest-report.json': { text: GREEN_REPORT },
        },
      };
    },
  },
  {
    what: 'the report is a symbolic link (to a green report)',
    spec: () => {
      writeFiles(outsideDir(), { 'green.json': GREEN_REPORT });
      return {
        exit: 0,
        files: {
          'vitest.exit': { text: '0\n' },
          'vitest.seconds': { text: '12\n' },
          'vitest-report.json': { symlink: join(outsideDir(), 'green.json') },
        },
      };
    },
  },
];

ENV_ERRORS.forEach((c, i) => {
  it(
    `[CT-06zzzzv] --related: ${c.what} → exit 2, no result.json, never green`,
    async () => {
      const fx = relatedFixture();
      const runsDir = join(base, `rj-env-${String(i)}`);
      const res = await runStubbed(RELATED_ARGS(fx.repo), runsDir, c.spec(), c.limitMs);
      expect(res.timedOut, 'the run hung and was killed').toBe(false);
      expect(res.status, res.stderr).toBe(2);
      const vdir = join(runsDir, 'B1-02b', 'related', '1');
      expect(existsSync(join(vdir, 'result.json'))).toBe(false);
      // The test container did run (the error is about what it left behind).
      expect(testContainer(res.calls)).toBeDefined();
      if (existsSync(join(vdir, 'related.json'))) {
        expect(readJson(join(vdir, 'related.json'))['status']).not.toBe('green');
      }
    },
    JUDGE_TIMEOUT,
  );
});

it(
  '[CT-06zzzzv] --related red: a test name with a newline and ESC is one escaped line on stdout; related.json keeps it whole',
  async () => {
    const fx = relatedFixture();
    const runsDir = join(base, 'rj-control');
    const title = 'two\nlines \u001b[31mred';
    const report = vitestReport([
      { rel: RELATED_TEST, status: 'failed', tests: [{ title, status: 'failed' }] },
    ]);
    const res = await runStubbed(RELATED_ARGS(fx.repo), runsDir, out('1', report));
    expect(res.timedOut).toBe(false);
    expect(res.status, res.stderr).toBe(1);
    expect(res.stdout).not.toContain('\u001b');
    const printed = res.stdout.split('\n').filter((l) => l.startsWith(`${RELATED_TEST} > `));
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('two\\nlines ');
    expect(printed[0]).toMatch(/\\(x1b|u001b)\[31mred/i);
    expect(res.stdout.split('\n').some((l) => l.startsWith('lines '))).toBe(false);
    const related = readJson(join(runsDir, 'B1-02b', 'related', '1', 'related.json'));
    expect(related['failed']).toEqual([{ file: RELATED_TEST, test: title }]);
  },
  JUDGE_TIMEOUT,
);

it(
  '[CT-06zzzzv] --related red with 201 red tests: stdout has exactly 200 of them and "… and 1 more in related.json"',
  async () => {
    const fx = relatedFixture();
    const runsDir = join(base, 'rj-many');
    const tests = Array.from({ length: 201 }, (_, i) => ({
      title: `t${String(i).padStart(3, '0')}`,
      status: 'failed',
    }));
    const res = await runStubbed(
      RELATED_ARGS(fx.repo),
      runsDir,
      out('1', vitestReport([{ rel: RELATED_TEST, status: 'failed', tests }])),
    );
    expect(res.timedOut).toBe(false);
    expect(res.status, res.stderr).toBe(1);
    const lines = res.stdout.split('\n');
    expect(lines.filter((l) => l.startsWith(`${RELATED_TEST} > `))).toHaveLength(200);
    expect(lines).toContain('… and 1 more in related.json');
    const related = readJson(join(runsDir, 'B1-02b', 'related', '1', 'related.json'));
    expect(related['failed']).toHaveLength(201);
  },
  JUDGE_TIMEOUT,
);

it(
  '[CT-06zzzzv] --related records data_sources, removed_or_renamed and force_all in related.json (selection unchanged)',
  async () => {
    const fx = relatedWorkspace(
      'related-classes',
      {
        [RELATED_SOURCE]: "export const keys = ['new.key'];\n",
        'db/seeds/0001_config-defaults.sql': 'select 1;\n',
        'apps/api/package.json': '{"name":"api","private":true}\n',
      },
      (repo) => {
        fixtureGit(repo, ['rm', '-q', 'packages/money/src/old.ts']);
        fixtureGit(repo, ['mv', 'packages/money/src/before.ts', 'packages/money/src/after.ts']);
      },
    );
    const runsDir = join(base, 'rj-classes');
    const res = await runStubbed(RELATED_ARGS(fx.repo), runsDir, out('0', GREEN_REPORT));
    expect(res.timedOut).toBe(false);
    expect(res.status, res.stderr).toBe(0);
    const related = readJson(join(runsDir, 'B1-02b', 'related', '1', 'related.json'));
    expect(related['force_all']).toBe(true);
    expect(related['data_sources']).toEqual(
      expect.arrayContaining(['db/seeds/0001_config-defaults.sql']),
    );
    for (const f of (related['data_sources'] as string[] | undefined) ?? []) {
      expect(f).not.toMatch(/\.ts$/);
    }
    expect([...((related['removed_or_renamed'] as string[] | undefined) ?? [])].sort()).toEqual([
      'packages/money/src/before.ts',
      'packages/money/src/old.ts',
    ]);
    // Recorded only: the sources handed to vitest related still include the changed TS file.
    expect(related['sources']).toEqual(expect.arrayContaining([RELATED_SOURCE]));
    expect(related['status']).toBe('green');
  },
  JUDGE_TIMEOUT,
);

it(
  '[CT-06zzzzv] --related --dry-run counts the uncommitted and untracked source files of the tree that runs',
  () => {
    const repo = fixture('related-dirty', 'node -e "process.exit(0)"');
    writeFiles(repo, {
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      [RELATED_SOURCE]: 'export const keys = [];\n',
      [RELATED_TEST]: "it('[BR-CONTENT-01] x', () => {});\n",
    });
    fixtureGit(repo, ['init', '-q', '-b', 'main']);
    fixtureGit(repo, ['add', '-A']);
    fixtureGit(repo, ['commit', '-q', '-m', 'fixture']);
    fixtureGit(repo, ['checkout', '-q', '-b', 'task']);
    // Nothing committed on the branch: one tracked source changed, one new source file.
    writeFiles(repo, {
      [RELATED_SOURCE]: "export const keys = ['new.key'];\n",
      'packages/money/src/new.ts': 'export const n = 1;\n',
    });
    const res = run(['B1-02b', '--worktree', repo, '--related', '--base', 'main', '--dry-run']);
    expect(res.status, res.stderr).toBe(0);
    const plan = JSON.parse(res.stdout) as { sources: string[]; tree: string };
    expect(plan.sources).toEqual([RELATED_SOURCE, 'packages/money/src/new.ts']);
    expect(plan.tree).not.toBe(fixtureGit(repo, ['rev-parse', 'HEAD^{tree}']));
    // The real index is untouched.
    // (Nothing staged: the uncommitted changes stay in the work tree only.)
    expect(fixtureGit(repo, ['diff', '--cached', '--name-only'])).toBe('');
    expect(existsSync(join(runs, 'B1-02b'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzv] --fast keeps its docker run: no /out mount, VERIFY_SCRIPT=verify:fast, offline',
  async () => {
    const root = JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as {
      packageManager: string;
    };
    const ws = join(base, 'related-fast');
    writeFiles(ws, {
      'package.json': `${JSON.stringify(
        { name: 'fast', private: true, packageManager: root.packageManager, scripts: {} },
        null,
        2,
      )}\n`,
      'pnpm-workspace.yaml': 'packages: []\n',
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    });
    const res = await runStubbed(
      ['V1-11', '--worktree', ws, '--fast'],
      join(base, 'rj-fast'),
      null,
    );
    expect(res.timedOut).toBe(false);
    expect(res.status, res.stderr).toBe(0);
    const container = testContainer(res.calls);
    expect(container).toBeDefined();
    const args = container?.args ?? [];
    expect(args.some((a) => a.endsWith(':/out'))).toBe(false);
    expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(container?.env['VERIFY_SCRIPT']).toBe('verify:fast');
    expect(args.slice(-2)).toEqual(['couli-verify-entrypoint', 'verify']);
  },
  JUDGE_TIMEOUT,
);

it('[CT-06zzzzv] tools/ops/README.md names the three related.json lists and no_related_tests', () => {
  const readme = readFileSync(join(OPS_DIR, 'README.md'), 'utf8');
  for (const word of ['data_sources', 'removed_or_renamed', 'force_all', 'no_related_tests']) {
    expect(readme, word).toContain(word);
  }
});
