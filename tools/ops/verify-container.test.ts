// Unit tests for the parts of verify-container.sh that need neither Docker nor the network: usage,
// refusals and the --dry-run plan (commit, tree). The container path itself is exercised by
// tools/ops/verify-container.selftest.sh (run by hand, see tools/ops/README.md).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const res = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, COULI_RUNS: runs, COULI_TRUSTED_ROOT: repoRoot(), ...env },
  });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
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
    expect(ci).toContain(
      "      - run: pnpm test:int\n        env:\n          TEST_REDIS_URL: redis://127.0.0.1:6379/0\n          PROP_RUNS: '2000'\n",
    );
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
    expect(JSON.parse(plan.stdout)).toEqual({ script: 'verify', commit: head, tree: headTree });

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
    expect(JSON.parse(browser.stdout)).toEqual({
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
