// Shared fixtures for the tools/ops unit tests. Scratch space lives under
// <repo>/.tmp/ (git-ignored), never under /tmp or $TMPDIR, and never in the
// real couli-runs directory.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { repoRoot } from '../lib/paths.ts';
import type { SpecSource } from './spec.ts';
import type { RiskReport } from './task.ts';

export const OPS_DIR = join(repoRoot(), 'tools', 'ops');

/**
 * Per-test time limit for cases that start child processes (node, git, bash).
 * They take one or two seconds alone; the default 5 seconds is too tight when
 * the whole workspace is being tested in parallel.
 */
export const CLI_TIMEOUT = 30_000;

/** A fresh directory under <repo>/.tmp/ops-tests/. Remove it with `rmSync` in afterAll. */
export function scratchDir(name: string): string {
  const dir = join(repoRoot(), '.tmp', 'ops-tests', `${name}-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

/** Git inside a fixture repository only; never touches the real repository's config or hooks. */
export function fixtureGit(cwd: string, args: string[]): string {
  const res = spawnSync(
    'git',
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

export type CliResult = { status: number; stdout: string; stderr: string };

/** Runs one of the tools/ops entry points the way the orchestrator does. */
export function runCli(
  script: string,
  args: string[],
  env: Record<string, string> = {},
): CliResult {
  const res = spawnSync(process.execPath, [join(OPS_DIR, script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    // The real board's JSON outgrew spawnSync's default 1 MiB buffer (1.16 MB on 2026-11-07), which
    // killed the child and reported status null (-1 here); 64 MiB leaves ample headroom.
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

export function memorySpec(files: Record<string, string>): SpecSource {
  return {
    list: (dir) =>
      Object.keys(files)
        .filter((f) => f.startsWith(`${dir}/`))
        .sort(),
    read: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`${path}: not in the synthetic spec`);
      return text;
    },
  };
}

export function fixedRisk(risk: RiskReport['risk']): (paths: readonly string[]) => RiskReport {
  return (paths) => ({
    risk,
    ask: false,
    paths: paths.map((path) => ({ path, risk, rule: null, protected: null })),
  });
}

export function taskYaml(fields: Record<string, string>): string {
  const base: Record<string, string> = {
    id: 'X1-01',
    repo: 'rebate-platform',
    title: 'sample task',
    type: 'impl',
    refs: '[BR-DEMO-01]',
    refs_hash: '\n  BR-DEMO-01: aaaa00000000',
    deps: '[]',
    paths: "\n  - 'packages/demo/src/**'",
    impl: 'codex',
    tester: 'claude',
    accept: "\n  - 'pnpm verify'",
    status: 'todo',
    pr: 'null',
  };
  const merged = { ...base, ...fields };
  return `${Object.entries(merged)
    .map(([k, v]) => (v.startsWith('\n') ? `${k}:${v}` : `${k}: ${v}`))
    .join('\n')}\n`;
}
