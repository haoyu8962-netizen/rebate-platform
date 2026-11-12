// Unit tests for the parts of verify-container.sh that need neither Docker nor the network: usage,
// refusals and the --dry-run plan (commit, tree). The container path itself is exercised by
// tools/ops/verify-container.selftest.sh (run by hand, see tools/ops/README.md).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      expect(res.stderr).toContain('--base applies to --red only');
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
