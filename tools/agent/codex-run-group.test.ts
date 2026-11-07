// Tests for the process-group supervision of codex-run.sh (规划/11 §2.2 看门狗, §2.4 超时) and
// for `selfcheck`. Fake codex binary only; the real codex is never started.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  type Fixture,
  isAlive,
  makeFixture,
  observed,
  readJson,
  runScript,
  TASK,
} from './testing/fixture.ts';

const LONG = { timeout: 60_000 };
const fixtures: Fixture[] = [];

function fixture(name: string): Fixture {
  const fx = makeFixture(name);
  fixtures.push(fx);
  return fx;
}

afterEach(() => {
  for (const fx of fixtures.splice(0)) fx.cleanup();
});

function codexRun(fx: Fixture, args: readonly string[], extraEnv: Record<string, string> = {}) {
  return runScript('codex-run.sh', args, fx.env, extraEnv);
}

it('timeout kills the whole process group; a late -o file is not accepted', LONG, () => {
  const fx = fixture('hang');
  const started = Date.now();
  const res = codexRun(fx, ['impl', TASK], {
    FAKE_CODEX_SCENARIO: 'hang',
    COULI_CODEX_TIMEOUT_SECS: '2',
  });
  expect(res.status, res.stderr).toBe(124);
  expect(Date.now() - started).toBeLessThan(30_000);

  const facts = observed(fx);
  const leader = Number(facts['pid']);
  const grandchild = Number(facts['grandchild']);
  expect(leader).toBeGreaterThan(1);
  expect(grandchild).toBeGreaterThan(1);
  // The grandchild ignores TERM, so it only disappears when the GROUP is killed.
  expect(isAlive(leader)).toBe(false);
  expect(isAlive(grandchild)).toBe(false);

  const meta = readJson(join(fx.run, 'meta.json'));
  expect(meta).toMatchObject({
    exit_code: 124,
    timed_out: true,
    idle_killed: false,
    has_output: false,
    group_gone: true,
  });
  // The grandchild wrote the -o file after TERM arrived: it must not count as output.
  expect(existsSync(join(fx.run, 'impl.json'))).toBe(false);
  expect(readFileSync(join(fx.run, 'impl.json.rejected'), 'utf8')).toContain('late');
});

it('inactivity watchdog kills the group when the event stream stops growing', LONG, () => {
  const fx = fixture('idle');
  const res = codexRun(fx, ['impl', TASK], {
    FAKE_CODEX_SCENARIO: 'hang',
    COULI_CODEX_IDLE_SECS: '2',
    COULI_CODEX_TIMEOUT_SECS: '40',
  });
  expect(res.status, res.stderr).toBe(124);
  const facts = observed(fx);
  expect(isAlive(Number(facts['pid']))).toBe(false);
  expect(isAlive(Number(facts['grandchild']))).toBe(false);
  expect(readJson(join(fx.run, 'meta.json'))).toMatchObject({
    exit_code: 124,
    timed_out: false,
    idle_killed: true,
    has_output: false,
  });
});

it(
  'processes left behind by a finished run are removed and the output is not trusted',
  LONG,
  () => {
    const fx = fixture('stragglers');
    const res = codexRun(fx, ['impl', TASK], { FAKE_CODEX_SCENARIO: 'stragglers' });
    // The group had to be cleaned up by force: whatever is in `-o` is not the model's answer.
    expect(res.status, res.stderr).toBe(10);
    expect(isAlive(Number(observed(fx)['grandchild']))).toBe(false);
    expect(readJson(join(fx.run, 'meta.json'))).toMatchObject({
      exit_code: 10,
      has_output: false,
      stragglers_killed: true,
      group_gone: true,
    });
    expect(existsSync(join(fx.run, 'impl.json'))).toBe(false);
    expect(existsSync(join(fx.run, 'impl.json.rejected'))).toBe(true);
  },
);

it('a descendant that escaped the group with setsid is ended and the run is rejected', LONG, () => {
  const fx = fixture('escape');
  const res = codexRun(fx, ['impl', TASK], { FAKE_CODEX_SCENARIO: 'escape-setsid' });
  expect(res.status, res.stderr).toBe(10);
  const escaped = Number(readFileSync(join(fx.log, 'escaped.pid'), 'utf8').trim());
  expect(escaped).toBeGreaterThan(1);
  expect(isAlive(escaped)).toBe(false);
  expect(readJson(join(fx.run, 'meta.json'))).toMatchObject({
    exit_code: 10,
    has_output: false,
    group_gone: true,
    escaped_killed: 1,
    descendants_left: 0,
  });
  // The escaped process never got to rewrite the worktree.
  expect(readFileSync(join(fx.worktree, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
  expect(existsSync(join(fx.run, 'impl.json'))).toBe(false);
});

it(
  'CPU activity without new events keeps the run alive; neither alone kills it early',
  LONG,
  () => {
    const fx = fixture('cpu-busy');
    // A busy descendant (no events written for 5 seconds, longer than the 3 s idle window) must
    // not be taken for inactivity. The window leaves room for a descendant that gets only a
    // small share of a loaded CI runner (the CPU step is 0.25 s).
    const res = codexRun(fx, ['impl', TASK], {
      FAKE_CODEX_SCENARIO: 'busy-then-finish',
      COULI_CODEX_IDLE_SECS: '3',
      COULI_CODEX_TIMEOUT_SECS: '40',
    });
    expect(res.status, res.stderr).toBe(0);
    expect(readJson(join(fx.run, 'meta.json'))).toMatchObject({
      exit_code: 0,
      idle_killed: false,
      has_output: true,
    });
  },
);

it('stopping the wrapper stops the codex process group as well', LONG, async () => {
  const fx = fixture('abort');
  const child = spawn('bash', [join(fx.trusted, 'tools', 'agent', 'codex-run.sh'), 'impl', TASK], {
    env: { ...fx.env, FAKE_CODEX_SCENARIO: 'hang' },
    stdio: 'ignore',
  });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const deadline = Date.now() + 20_000;
  while (observed(fx)['grandchild'] === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const facts = observed(fx);
  expect(facts['grandchild']).toBeDefined();
  child.kill('SIGTERM');
  expect(await exited).toBe(10);
  expect(isAlive(Number(facts['pid']))).toBe(false);
  expect(isAlive(Number(facts['grandchild']))).toBe(false);
  expect(readJson(join(fx.run, 'meta.json'))).toMatchObject({ aborted: true, has_output: false });
});

it(
  'a supervisor that dies without reporting still leaves no codex process behind',
  LONG,
  async () => {
    const fx = fixture('supervisor-killed');
    const child = spawn(
      'bash',
      [join(fx.trusted, 'tools', 'agent', 'codex-run.sh'), 'impl', TASK],
      {
        env: { ...fx.env, FAKE_CODEX_SCENARIO: 'hang' },
        stdio: 'ignore',
      },
    );
    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', (code) => resolve(code)),
    );
    const deadline = Date.now() + 20_000;
    while (observed(fx)['grandchild'] === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const facts = observed(fx);
    expect(facts['grandchild']).toBeDefined();
    // The supervisor is the parent of the codex process-group leader.
    const supervisor = Number(facts['ppid']);
    expect(supervisor).toBeGreaterThan(1);
    process.kill(supervisor, 'SIGKILL');
    expect(await exited).toBe(10);
    expect(isAlive(Number(facts['pid']))).toBe(false);
    expect(isAlive(Number(facts['grandchild']))).toBe(false);
    expect(readJson(join(fx.run, 'meta.json'))).toMatchObject({
      has_output: false,
      group_gone: true,
    });
    expect(existsSync(join(fx.run, 'impl.json'))).toBe(false);
  },
);

it(
  'selfcheck verifies flags, the group kill and prints both argvs without starting a turn',
  LONG,
  () => {
    const fx = fixture('selfcheck');
    const res = codexRun(fx, ['selfcheck']);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toContain('codex version: codex-cli 0.0.0-fake');
    expect(res.stdout).toContain(
      'ok    process-group kill: exit 124, no process of the group left',
    );
    expect(res.stdout).toContain('workspace-write');
    expect(res.stdout).toContain('model_reasoning_effort="high"');
    expect(res.stdout).toContain('model_reasoning_effort="medium"');
    expect(res.stdout).toContain('selfcheck: ok');
    expect(existsSync(join(fx.log, 'argv.nul'))).toBe(false);

    const broken = codexRun(fx, ['selfcheck'], { FAKE_CODEX_SCENARIO: 'help-missing-flag' });
    expect(broken.status).toBe(1);
    expect(broken.stdout).toContain('FAIL  codex exec --help does not list --ignore-rules');
  },
);
