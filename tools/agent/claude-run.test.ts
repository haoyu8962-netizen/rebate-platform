// Tests for claude-run.sh (owner decision 2026-10-21, ops/approvals.yaml id 36): rule tests and
// reviews by a fresh, independent Claude context when Codex is not available. They spawn bash with
// a fake claude selected through COULI_CLAUDE_BIN; the real claude is never started.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  FAKE_CLAUDE,
  type Fixture,
  gitIn,
  installLoggedState,
  makeFixture,
  observed,
  observedArgv,
  readJson,
  runScript,
  stubCalls,
  TASK,
  trustedState,
  trustedTaskState,
  writeFakeFormatters,
  writeStub,
} from './testing/fixture.ts';

const LONG = { timeout: 60_000 };
const fixtures: Fixture[] = [];

/** A fixture whose wrapper finds the fake claude (and no task ledger unless one is stubbed). */
function fixture(name: string): Fixture {
  const fx = makeFixture(`claude-${name}`);
  fx.env['COULI_CLAUDE_BIN'] = FAKE_CLAUDE;
  fixtures.push(fx);
  return fx;
}

const extraDirs: string[] = [];

afterEach(() => {
  for (const fx of fixtures.splice(0)) fx.cleanup();
  for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function claudeRun(fx: Fixture, args: readonly string[], extraEnv: Record<string, string> = {}) {
  return runScript('claude-run.sh', args, fx.env, extraEnv);
}

/** The trusted ledger as `task.ts show --json` prints it. */
function ledger(fx: Fixture, fields: Record<string, unknown>): void {
  writeStub(join(fx.trusted, 'tools', 'ops', 'task.ts'), 'task', [
    {
      when: ['show'],
      stdout: JSON.stringify({
        id: TASK,
        type: 'impl',
        risk: 'RV1',
        impl: 'claude',
        tester: 'claude-independent',
        paths: ['src/a.ts'],
        test_paths: ['test/spec/t1/**', 'test/{acceptance,properties}/t1/**'],
        refs: ['BR-CALC-01'],
        ...fields,
      }),
    },
  ]);
}

/** Decodes the `--dry-run` listing: one argument per line, `\n` and `\\` escaped. */
function decodeDryRun(stdout: string): string[] {
  return stdout
    .split('\n')
    .slice(0, -1)
    .map((line) => line.replace(/\\(\\|n)/g, (_, c: string) => (c === 'n' ? '\n' : '\\')));
}

/** The value after `flag` in an argv, and the values of a variadic flag up to the next option. */
function after(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

function variadic(argv: readonly string[], flag: string): string[] {
  const at = argv.indexOf(flag);
  const out: string[] = [];
  for (let i = at + 1; i > 0 && i < argv.length && !(argv[i] ?? '').startsWith('--'); i++) {
    out.push(argv[i] ?? '');
  }
  return out;
}

it(
  '[approvals 36] test phase: a fresh claude -p context with fixed tools, edit rules and the trusted schema',
  LONG,
  () => {
    const fx = fixture('impl');
    ledger(fx, {});
    const res = claudeRun(fx, ['impl', TASK]);
    expect(res.status, res.stderr).toBe(0);
    const argv = observedArgv(fx);
    // A new session every time: print mode, never resumed, nothing persisted, no configuration.
    expect(argv[0]).toBe('-p');
    for (const flag of [
      '--no-session-persistence',
      '--safe-mode',
      '--restricted',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--verbose',
      '--include-partial-messages',
    ]) {
      expect(argv).toContain(flag);
    }
    for (const flag of ['--resume', '-r', '--continue', '-c', '--fork-session', '--session-id']) {
      expect(argv).not.toContain(flag);
    }
    expect(after(argv, '--model')).toBe('claude-opus-5-5');
    expect(after(argv, '--output-format')).toBe('stream-json');
    expect(after(argv, '--permission-mode')).toBe('dontAsk');
    // #1046 r1 S0 / S1: no shell at all (no git, no pnpm exec on the host).
    expect(after(argv, '--tools')).toBe('Read,Grep,Glob,Edit,Write');
    expect(after(argv, '--json-schema')).toBe(
      readFileSync(
        join(fx.trusted, 'tools', 'agent', 'schemas', 'impl.schema.json'),
        'utf8',
      ).replace(/\n$/, ''),
    );
    // Edits only inside test_paths (braces expanded) and the skeleton paths; nothing else.
    const rules = variadic(argv, '--allowedTools');
    expect(rules).toEqual([
      'Read',
      'Grep',
      'Glob',
      'Edit(/test/spec/t1/**)',
      'Edit(/test/acceptance/t1/**)',
      'Edit(/test/properties/t1/**)',
      'Edit(/src/a.ts)',
    ]);
    // The prompt is the brief plus where the wrapper's git context is, last; claude starts in
    // the worktree with stdin closed and may read only the worktree and that directory.
    const context = join(fx.run, 'wrapper-impl', 'context');
    expect(after(argv, '--add-dir')).toBe(context);
    expect(argv.filter((a) => a === '--add-dir')).toHaveLength(1);
    const prompt = argv[argv.length - 1] ?? '';
    expect(
      prompt.startsWith(readFileSync(join(fx.run, 'brief.md'), 'utf8').replace(/\n+$/, '')),
    ).toBe(true);
    expect(prompt).toContain(`You have no shell. Git status, log and diff`);
    expect(prompt).toContain(context);
    for (const file of [
      'README.txt',
      'git-status.txt',
      'git-log.txt',
      'git-diff.patch',
      'untracked.txt',
    ]) {
      expect(existsSync(join(context, file)), file).toBe(true);
    }
    expect(observed(fx)).toMatchObject({ cwd: fx.worktree, stdin: 'devnull', wrapper: '1' });
    // Same run directory and meta.json as codex-run.sh, recorded as the independent Claude engine.
    const meta = readJson(join(fx.run, 'meta.impl.json'));
    expect(meta).toMatchObject({
      mode: 'impl',
      phase: 'test',
      engine: 'claude-independent',
      model: 'claude-opus-5-5',
      exit_code: 0,
      agent_exit: 0,
      has_output: true,
      validation: 'ok',
      last_event: 'result.success',
      thread_id: '5e55f4ke-0000-4000-8000-000000000001',
      timeout_secs: 1800,
      idle_secs: 300,
    });
    expect(meta).not.toHaveProperty('codex_exit');
    expect(meta).not.toHaveProperty('codex_version');
    expect(readJson(join(fx.run, 'impl.json'))).toMatchObject({ task_done: true });
    // The Codex token ledger is not written for a Claude call.
    expect(stubCalls(fx, 'usage')).toEqual([]);
  },
);

it(
  '[approvals 36] review: read-only tools, the review output under its own name, engine recorded',
  LONG,
  () => {
    const fx = fixture('review');
    ledger(fx, { risk: 'RV2', tester: 'codex' });
    writeFileSync(join(fx.worktree, 'src', 'a.ts'), 'export const a = 2;\n');
    const outputFile = join(fx.root, 'money-review.json');
    writeFileSync(
      outputFile,
      JSON.stringify({
        verdict: 'pass',
        summary: 'nothing found',
        findings: [],
        out_of_scope: [],
        checklist: [
          'rounding',
          'sign',
          'idempotency',
          'concurrency',
          'partial_refund',
          'clock',
          'app_id',
        ].map((item) => ({ item, status: 'na', file: 'src/a.ts', line: 1, note: 'n/a' })),
      }),
    );
    const res = claudeRun(fx, ['review', TASK, '--base', fx.baseSha], {
      FAKE_CLAUDE_OUTPUT_FILE: outputFile,
    });
    expect(res.status, res.stderr).toBe(0);
    const argv = observedArgv(fx);
    // #1046 r1 S0: read-only means no Bash at all, so `git log --output=<file>` (or any other
    // writing git option) cannot be reached: no Bash tool, no Bash rule, no writing tool.
    expect(after(argv, '--tools')).toBe('Read,Grep,Glob');
    expect(variadic(argv, '--allowedTools')).toEqual(['Read', 'Grep', 'Glob']);
    expect(
      argv
        .slice(0, -1)
        .some((a) => /^Bash/.test(a) || (a.startsWith('--output') && a !== '--output-format')),
    ).toBe(false);
    // What git would have said is in the context directory instead.
    const context = join(fx.run, 'wrapper-review', 'context');
    expect(after(argv, '--add-dir')).toBe(context);
    expect(readFileSync(join(context, 'git-diff.patch'), 'utf8')).toContain('+export const a = 2;');
    expect(readFileSync(join(context, 'spec', 'MISSING.txt'), 'utf8')).toContain('not available');
    // RV2 defaults to the money review; the prompt is the trusted file plus the context block,
    // which says who wrote what.
    const prompt = argv[argv.length - 1] ?? '';
    expect(
      prompt.startsWith(
        readFileSync(join(fx.trusted, 'tools/agent/prompts/review-money.md'), 'utf8'),
      ),
    ).toBe(true);
    expect(prompt).toContain('generated by claude-run.sh');
    expect(prompt).toContain('independent Claude context (claude-independent)');
    expect(prompt).toContain('ledger rule-test author: codex');
    expect(existsSync(join(fx.run, 'review-claude-independent.json'))).toBe(true);
    expect(existsSync(join(fx.run, 'review-codex.json'))).toBe(false);
    expect(readJson(join(fx.run, 'meta.review.json'))).toMatchObject({
      mode: 'review',
      review_type: 'money',
      engine: 'claude-independent',
      exit_code: 0,
      validation: 'ok',
    });
    // Only the test phase formats files (D10-292).
    expect(readJson(join(fx.run, 'meta.review.json'))).not.toHaveProperty('test_format');
  },
);

it(
  '[approvals 36] a usage limit or rejected rate limit gives exit 11; quoted text does not',
  LONG,
  () => {
    const fx = fixture('limit');
    ledger(fx, {});
    const limited = claudeRun(fx, ['impl', TASK], { FAKE_CLAUDE_SCENARIO: 'usage-limit' });
    expect(limited.status).toBe(11);
    expect(readJson(join(fx.run, 'meta.impl.json'))).toMatchObject({
      exit_code: 11,
      capacity_error: true,
      has_output: false,
      last_event: 'result.error',
    });
    const quoted = claudeRun(fx, ['impl', TASK], { FAKE_CLAUDE_SCENARIO: 'quoting-limit' });
    expect(quoted.status).toBe(10);
    expect(readJson(join(fx.run, 'meta.impl.json'))).toMatchObject({ capacity_error: false });
    // The previous call's files went to attempts/<n>/.
    expect(existsSync(join(fx.run, 'attempts', '1', 'meta.json'))).toBe(true);
  },
);

it(
  '[approvals 36] no final result, or a result without structured output, gives exit 10',
  LONG,
  () => {
    const fx = fixture('noresult');
    ledger(fx, {});
    for (const scenario of ['no-result', 'no-structured-output']) {
      const res = claudeRun(fx, ['impl', TASK], { FAKE_CLAUDE_SCENARIO: scenario });
      expect(res.status, scenario).toBe(10);
      expect(existsSync(join(fx.run, 'impl.json')), scenario).toBe(false);
      expect(readJson(join(fx.run, 'meta.impl.json'))).toMatchObject({
        has_output: false,
        validation: 'not-run',
      });
    }
  },
);

it('[approvals 36] a review that leaves a file in the working tree gives exit 12', LONG, () => {
  const fx = fixture('dirty');
  ledger(fx, {});
  const res = claudeRun(fx, ['review', TASK, '--base', fx.baseSha], {
    FAKE_CLAUDE_SCENARIO: 'write-untracked',
  });
  expect(res.status).toBe(12);
  expect(readJson(join(fx.run, 'meta.review.json'))['position_changed']).toEqual(['worktree']);
  expect(existsSync(join(fx.run, 'review-claude-independent.json'))).toBe(false);
  // #1046 r1 S1: a second edit of a file that was already modified (same `git status`) is seen.
  writeFileSync(join(fx.worktree, 'src', 'a.ts'), 'export const a = 2;\n');
  rmSync(join(fx.worktree, 'rogue-review.txt'));
  const rewrite = claudeRun(fx, ['review', TASK, '--base', fx.baseSha], {
    FAKE_CLAUDE_SCENARIO: 'rewrite-modified',
  });
  expect(rewrite.status).toBe(12);
  expect(readJson(join(fx.run, 'meta.review.json'))['position_changed']).toEqual(['worktree']);
  // An untouched worktree with a modified file passes.
  writeFileSync(join(fx.worktree, 'src', 'a.ts'), 'export const a = 2;\n');
  expect(claudeRun(fx, ['review', TASK, '--base', fx.baseSha]).status).toBe(0);
});

it(
  '[approvals 36] Codex is refused the spec-test review of rule tests Codex wrote, whatever the ledger says',
  LONG,
  () => {
    const fx = fixture('own-tests');
    ledger(fx, { tester: 'claude-independent' });
    const args = ['review', TASK, '--base', fx.baseSha, '--review-type', 'spec-test', '--dry-run'];
    const codexRun = () => runScript('codex-run.sh', args, fx.env);
    // Only independent Claude calls wrote tests: Codex may review them.
    const meta = (engine?: string) =>
      JSON.stringify({
        mode: 'impl',
        phase: 'test',
        ...(engine === undefined ? {} : { engine }),
        started_at: 'x',
        finished_at: 'x',
        exit_code: 0,
      });
    writeFileSync(join(fx.run, 'meta.impl.json'), meta('claude-independent'));
    expect(codexRun().status).toBe(0);
    // A test-phase call of Codex (recorded, or older without engine) in the run directory: refused.
    mkdirSync(join(fx.run, 'attempts', '1'), { recursive: true });
    writeFileSync(join(fx.run, 'attempts', '1', 'meta.json'), meta());
    const own = codexRun();
    expect(own.status).toBe(2);
    expect(own.stderr).toContain('Codex wrote rule tests of this task');
    writeFileSync(join(fx.run, 'attempts', '1', 'meta.json'), meta('codex'));
    expect(codexRun().status).toBe(2);
    // The independent Claude review of the same tests is fine.
    expect(claudeRun(fx, args).status).toBe(0);
  },
);

it(
  '[approvals 36] each runner checks the failure breakers of its own engine before the call',
  LONG,
  () => {
    const fx = fixture('breakers');
    ledger(fx, {});
    writeStub(join(fx.trusted, 'tools', 'ops', 'state.ts'), 'state', [
      {
        when: ['breakers', '--engine', 'claude-independent'],
        exit: 3,
        stderr: 'G7: 独立 Claude 连续 3 次调用没有产出',
      },
    ]);
    const refused = claudeRun(fx, ['impl', TASK]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('a failure breaker of T1-01 is open for claude-independent');
    expect(existsSync(join(fx.log, 'argv.nul'))).toBe(false);
    // Codex asks for its own engine, whatever a caller counted the round with.
    runScript('codex-run.sh', ['impl', TASK, '--dry-run'], fx.env);
    expect(stubCalls(fx, 'state').filter((c) => c[1] === 'breakers')).toEqual([
      ['state', 'breakers', TASK, '--engine', 'claude-independent'],
      ['state', 'breakers', TASK, '--engine', 'codex'],
    ]);
    // Any other failure of state.ts is no refusal.
    writeStub(join(fx.trusted, 'tools', 'ops', 'state.ts'), 'state', [{ exit: 2 }]);
    expect(claudeRun(fx, ['impl', TASK]).status).toBe(0);
  },
);

it("[approvals 36] Codex keeps the caller's working directory and its argv", LONG, () => {
  const fx = fixture('codex-cwd');
  const res = runScript('codex-run.sh', ['impl', TASK], fx.env);
  expect(res.status, res.stderr).toBe(0);
  expect(observed(fx)['cwd']).toBe(realpathSync(process.cwd()));
  const argv = observedArgv(fx);
  expect(argv.slice(0, 3)).toEqual(['exec', '-C', fx.worktree]);
  expect(argv).not.toContain('--add-dir');
  expect(readJson(join(fx.run, 'meta.impl.json'))).toMatchObject({
    engine: 'codex',
    model: 'gpt-6-astra',
  });
});

it(
  '[approvals 36] refused: other phases, a ledger that does not name claude-independent, resumed or bypassed sessions',
  LONG,
  () => {
    const fx = fixture('refuse');
    ledger(fx, {});
    for (const phase of ['handover', 'impl']) {
      const res = claudeRun(fx, ['impl', TASK, '--phase', phase, '--dry-run']);
      expect(res.status, phase).toBe(2);
      expect(res.stderr).toContain('writes rule tests only');
    }
    ledger(fx, { tester: 'codex' });
    const codexTester = claudeRun(fx, ['impl', TASK, '--dry-run']);
    expect(codexTester.status).toBe(2);
    expect(codexTester.stderr).toContain('not claude-independent');
    ledger(fx, { test_paths: [] });
    expect(claudeRun(fx, ['impl', TASK, '--dry-run']).stderr).toContain('has no test_paths');
    for (const value of ['--continue', 'bypassPermissions', '--dangerously-skip-permissions']) {
      const res = claudeRun(fx, ['impl', TASK, '--worktree', value]);
      expect(res.status, value).toBe(2);
    }
    // A replacement claude is for test fixtures only.
    const real = claudeRun(fx, ['impl', TASK, '--dry-run'], { COULI_AGENT_TEST: '0' });
    expect(real.status).toBe(2);
    expect(real.stderr).toContain('COULI_CLAUDE_BIN is set but COULI_AGENT_TEST=1 is not');
    expect(existsSync(join(fx.log, 'argv.nul'))).toBe(false);
  },
);

it(
  '[approvals 36] spec-test review of any known author; an unknown author is refused',
  LONG,
  () => {
    const fx = fixture('spec');
    const args = ['review', TASK, '--base', fx.baseSha, '--review-type', 'spec-test', '--dry-run'];
    for (const tester of ['codex', 'claude', 'claude-independent']) {
      ledger(fx, { tester });
      const res = claudeRun(fx, args);
      expect(res.status, `${tester}: ${res.stderr}`).toBe(0);
    }
    ledger(fx, { tester: undefined });
    const unknown = claudeRun(fx, args);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('the rule-test author is unknown');
    // A Codex handover implementation may be reviewed by an independent Claude context.
    writeStub(join(fx.trusted, 'tools', 'ops', 'state.ts'), 'state', [
      { when: ['get'], stdout: JSON.stringify({ implementer: 'codex' }) },
    ]);
    ledger(fx, { risk: 'RV1' });
    expect(claudeRun(fx, ['review', TASK, '--base', fx.baseSha, '--dry-run']).status).toBe(0);
  },
);

it(
  '[approvals 36] the account is CLAUDE_INDEPENDENT_CONFIG_DIR; API keys never reach the child',
  LONG,
  () => {
    const fx = fixture('account');
    ledger(fx, {});
    // Outside the repository, the trusted root and the run-state directory (the fixture lives in
    // REPO/.tmp, so the account directory cannot).
    const account = realpathSync(mkdtempSync(join(tmpdir(), 'couli-claude-account-')));
    extraDirs.push(account);
    const res = claudeRun(fx, ['impl', TASK], {
      CLAUDE_INDEPENDENT_CONFIG_DIR: account,
      ANTHROPIC_API_KEY: 'sk-test-not-a-key',
    });
    expect(res.status, res.stderr).toBe(0);
    expect(observed(fx)).toMatchObject({ config_dir: account, api_key: '' });
    expect(readJson(join(fx.run, 'meta.impl.json'))).toMatchObject({ config_dir: account });
    // Unset: the caller's CLAUDE_CONFIG_DIR is kept.
    const inherited = claudeRun(fx, ['impl', TASK], { CLAUDE_CONFIG_DIR: account });
    expect(inherited.status, inherited.stderr).toBe(0);
    expect(observed(fx)).toMatchObject({ config_dir: account });
    // Relative, missing, inside the run-state directory or the repository: refused before claude
    // starts.
    for (const bad of ['relative/dir', join(account, 'missing'), fx.run, fx.trusted]) {
      expect(
        claudeRun(fx, ['impl', TASK, '--dry-run'], { CLAUDE_INDEPENDENT_CONFIG_DIR: bad }).status,
        bad,
      ).toBe(2);
    }
  },
);

it('[approvals 36] codex-run.sh ignores AGENT_ENGINE from the environment', LONG, () => {
  const fx = fixture('engine-env');
  const res = runScript('codex-run.sh', ['impl', TASK, '--dry-run'], fx.env, {
    AGENT_ENGINE: 'claude-independent',
  });
  expect(res.status, res.stderr).toBe(0);
  const argv = decodeDryRun(res.stdout);
  expect(argv[1]).toBe('exec');
  expect(argv).toContain('gpt-6-astra');
});

it('[approvals 36] selfcheck reads claude --help and starts no Claude turn', LONG, () => {
  const fx = fixture('selfcheck');
  const res = claudeRun(fx, ['selfcheck']);
  expect(res.status, res.stdout + res.stderr).toBe(0);
  expect(res.stdout).toContain('ok    claude --help lists --json-schema');
  expect(res.stdout).toContain('ok    prompt review-spec-test.md');
  expect(res.stdout).toContain('selfcheck: ok (no Claude turn was started)');
  expect(res.stdout).toContain('claude-opus-5-5');
  expect(existsSync(join(fx.log, 'argv.nul'))).toBe(false);
  const missing = claudeRun(fx, ['selfcheck'], { FAKE_CLAUDE_SCENARIO: 'help-missing-flag' });
  expect(missing.status).toBe(1);
  expect(missing.stdout).toContain('FAIL  claude --help does not list --json-schema');
});

it(
  '[D10-292] test phase: the handed-back test files are formatted and summarized in meta.json',
  LONG,
  () => {
    const fx = fixture('format');
    ledger(fx, {});
    writeFakeFormatters(fx.trusted);
    // Already there before the call: not this call's change, so not formatted.
    mkdirSync(join(fx.worktree, 'test', 'spec', 't1'), { recursive: true });
    const old = 'it("old", () => 1)\n';
    writeFileSync(join(fx.worktree, 'test', 'spec', 't1', 'old.test.ts'), old);
    const res = claudeRun(fx, ['impl', TASK], { FAKE_CLAUDE_SCENARIO: 'write-tests' });
    expect(res.status, res.stderr).toBe(0);
    const read = (rel: string) => readFileSync(join(fx.worktree, rel), 'utf8');
    expect(read('test/spec/t1/a.test.ts')).toBe("it('formats', () => expect(oldName).toBe(1));\n");
    expect(read('test/spec/t1/old.test.ts')).toBe(old);
    // The skeleton is in paths, not test_paths: left as written.
    expect(read('src/a.ts')).toBe('export const a = "skeleton"\n');
    const meta = readJson(join(fx.run, 'meta.impl.json'));
    expect(meta).toMatchObject({ exit_code: 0, has_output: true, validation: 'ok' });
    // Formatting by the wrapper is not a position change of the model.
    expect(meta['position_changed']).toEqual([]);
    expect(meta['test_format']).toEqual({
      ok: true,
      files: [
        {
          path: 'test/spec/t1/a.test.ts',
          changed: true,
          lines_before: 1,
          lines_after: 1,
          lines_added: 1,
          lines_removed: 1,
          format_only: true,
          eslint_fatal: null,
        },
      ],
      skipped: [{ path: 'src/a.ts', reason: 'outside the globs' }],
      restored: false,
      error: null,
    });
    expect(existsSync(join(fx.run, 'impl.json'))).toBe(true);
  },
);

it(
  '[D10-292] test phase: a change beyond formatting is no usable output and the files are restored',
  LONG,
  () => {
    const fx = fixture('format-bad');
    ledger(fx, {});
    writeFakeFormatters(fx.trusted);
    const res = claudeRun(fx, ['impl', TASK], {
      FAKE_CLAUDE_SCENARIO: 'write-tests',
      FAKE_PRETTIER: 'rename',
    });
    expect(res.status).toBe(10);
    expect(readFileSync(join(fx.worktree, 'test/spec/t1/a.test.ts'), 'utf8')).toBe(
      'it("formats", () => expect(oldName).toBe(1))\n',
    );
    const meta = readJson(join(fx.run, 'meta.impl.json'));
    expect(meta).toMatchObject({ exit_code: 10, has_output: false, validation: 'failed' });
    expect(meta['test_format']).toMatchObject({ ok: false, restored: true });
    expect((meta['validation_messages'] as string[]).join('\n')).toContain('test_format');
    expect(existsSync(join(fx.run, 'impl.json'))).toBe(false);
    expect(existsSync(join(fx.run, 'impl.json.rejected'))).toBe(true);
  },
);

it(
  '[CT-06zzzp] claude-run.sh: a refused call gives back its round as claude-independent',
  LONG,
  () => {
    const fx = fixture('release');
    writeStub(join(fx.trusted, 'tools', 'ops', 'state.ts'), 'state');
    ledger(fx, { tester: undefined });
    const res = claudeRun(fx, ['review', TASK, '--base', fx.baseSha, '--review-type', 'spec-test']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('the rule-test author is unknown');
    const calls = stubCalls(fx, 'state').filter((call) => call[1] === 'release');
    expect(calls).toHaveLength(1);
    const argv = calls[0] ?? [];
    expect(argv.slice(0, 4)).toEqual(['state', 'release', TASK, 'review']);
    expect(after(argv, '--review-type')).toBe('spec-test');
    expect(after(argv, '--engine')).toBe('claude-independent');
    expect(after(argv, '--reason') ?? '').not.toBe('');
    expect(existsSync(join(fx.log, 'argv.nul'))).toBe(false);
  },
);

it(
  '[CT-06zzzu] claude-run.sh: a direct exit 2 (no task brief) gives back the round as claude-independent, with the call id',
  LONG,
  () => {
    const fx = fixture('release-rest');
    installLoggedState(fx);
    ledger(fx, {});
    rmSync(join(fx.run, 'brief.md'));
    const engine = ['--engine', 'claude-independent'];
    const bump = trustedState(fx, ['bump-attempt', TASK, 'test', ...engine]);
    expect(bump.status, bump.stderr).toBe(0);
    expect(trustedTaskState(fx)?.attempts['test']).toBe(1);
    rmSync(join(fx.log, 'calls.log'), { force: true });
    const res = claudeRun(fx, ['impl', TASK]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('task brief missing or empty');
    const state = trustedTaskState(fx);
    expect(state?.attempts['test']).toBe(0);
    expect(state?.pending_bumps).toEqual([
      expect.objectContaining({ kind: 'test', engine: 'claude-independent', outcome: 'refused' }),
    ]);
    const call = String(state?.pending_bumps[0]?.['call'] ?? '');
    expect(call).not.toBe('');
    expect(call.startsWith('-')).toBe(false);
    const calls = stubCalls(fx, 'state').filter((c) => c[1] === 'release');
    expect(calls).toHaveLength(1);
    const argv = calls[0] ?? [];
    expect(argv.slice(0, 4)).toEqual(['state', 'release', TASK, 'test']);
    expect(after(argv, '--engine')).toBe('claude-independent');
    expect(after(argv, '--call')).toBe(call);
    expect(existsSync(join(fx.log, 'argv.nul'))).toBe(false);
  },
);

/** The first line the wrapper logged to stderr that holds every one of `words`, if any. */
function logLine(stderr: string, ...words: string[]): string | undefined {
  return stderr.split('\n').find((line) => words.every((word) => line.includes(word)));
}

/** CT-06zzzw: the round line, `full review` and the reason a full review prompt lacks. */
function missingRoundFacts(prompt: string, round: number, reason: string): string[] {
  const facts: [string, boolean][] = [
    [`This review round: ${round}`, new RegExp(`This review round: ${round}(?!\\d)`).test(prompt)],
    ['full review', prompt.includes('full review')],
    [reason, prompt.includes(reason)],
  ];
  return facts.filter(([, found]) => !found).map(([fact]) => fact);
}

it(
  '[CT-06zzzw] claude-run.sh: no change since its own previous round is a full review, a change is incremental, --full forces a full review; impl --full is a usage error',
  LONG,
  () => {
    const fx = fixture('review-scope');
    ledger(fx, {});
    const review = ['review', TASK, '--review-type', 'general', '--base', fx.baseSha];
    const promptOf = (res: { stdout: string }): string => decodeDryRun(res.stdout).at(-1) ?? '';
    const metaFile = join(fx.run, 'meta.review.json');
    writeFileSync(join(fx.worktree, 'src', 'a.ts'), 'export const a = 2;\n');
    gitIn(fx.worktree, ['add', '-A']);
    gitIn(fx.worktree, ['commit', '-q', '-m', 'change']);
    // Round 1: nothing earlier.
    const run1 = claudeRun(fx, review);
    expect(run1.status, run1.stderr).toBe(0);
    expect(readJson(metaFile)).toMatchObject({
      engine: 'claude-independent',
      review_scope: 'full',
      full_reason: 'first-round',
      previous_output: null,
    });
    // Nothing changed since its own round 1: a full review of round 2, and the prompt says why.
    const why = 'no change since the previous round';
    const same = claudeRun(fx, [...review, '--dry-run']);
    expect(same.status, same.stderr).toBe(0);
    expect(promptOf(same)).not.toContain('### Previous review round');
    expect(logLine(same.stderr, why, 'full review (round 2)'), same.stderr).toBeDefined();
    expect(missingRoundFacts(promptOf(same), 2, why)).toEqual([]);
    // A change: incremental on its own round 1, the increment in its context directory.
    writeFileSync(join(fx.worktree, 'src', 'a.ts'), 'export const a = 3;\n');
    const changed = claudeRun(fx, [...review, '--dry-run']);
    expect(changed.status, changed.stderr).toBe(0);
    expect(promptOf(changed)).toContain(
      '- This review round: 2 (earlier usable general outputs found: 1)',
    );
    expect(promptOf(changed)).toContain(
      `- Previous review output: ${join(fx.run, 'review-claude-independent.json')}`,
    );
    expect(promptOf(changed)).toContain('git-diff-since-previous.patch in the context directory');
    // --full: a full review all the same, recorded for the flag; the round still counts.
    const forced = claudeRun(fx, [...review, '--full']);
    expect(forced.status, forced.stderr).toBe(0);
    const prompt = observedArgv(fx).at(-1) ?? '';
    expect(prompt).not.toContain('### Previous review round');
    expect(logLine(forced.stderr, '--full', 'full review (round 2)'), forced.stderr).toBeDefined();
    expect(missingRoundFacts(prompt, 2, '--full')).toEqual([]);
    expect(readJson(metaFile)).toMatchObject({
      engine: 'claude-independent',
      review_scope: 'full',
      full_reason: 'flag',
      previous_output: null,
    });
    writeFileSync(join(fx.worktree, 'src', 'a.ts'), 'export const a = 4;\n');
    const next = claudeRun(fx, [...review, '--dry-run']);
    expect(next.status, next.stderr).toBe(0);
    expect(promptOf(next)).toContain(
      '- This review round: 3 (earlier usable general outputs found: 2)',
    );
    // impl takes no --full (review only); the same call without it is accepted.
    rmSync(join(fx.log, 'argv.nul'), { force: true });
    for (const args of [
      ['impl', TASK, '--full'],
      ['impl', TASK, '--full', '--dry-run'],
    ]) {
      const res = claudeRun(fx, args);
      expect(res.status, args.join(' ')).toBe(2);
      expect(res.stderr, args.join(' ')).toContain('--full');
      expect(res.stdout, args.join(' ')).toBe('');
    }
    expect(existsSync(join(fx.log, 'argv.nul'))).toBe(false);
    expect(existsSync(join(fx.run, 'meta.impl.json'))).toBe(false);
    expect(claudeRun(fx, ['impl', TASK, '--dry-run']).status).toBe(0);
  },
);
