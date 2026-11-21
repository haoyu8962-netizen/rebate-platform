import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect } from 'vitest';
import {
  fixtureGit as git,
  removeDir,
  scratchDir,
  taskYaml,
  writeFiles,
} from '../../../../tools/ops/test-helpers.ts';

export const ROOT = resolve(import.meta.dirname, '../../../..');
export const TASK = 'CT-06zzzzzz';
export const LEDGER = `ops/tasks/${TASK}.yaml`;
const TEST_DIR = 'test/spec/ci/evidence-check-early';
export const NEW_TEST = `${TEST_DIR}/new.test.ts`;
export const NEW_TITLE = '[AC-CT-06#1] new test';
export const FROZEN_TEST = 'test/spec/identity/evidence-shape/frozen.test.ts';
export const KIT = 'test/spec/identity/evidence-shape/kit.ts';
export const MANIFEST = 'test-manifest.json';
const FROZEN_TITLE = '[AC-CT-06#2] checks the result';
const RESULT_ASSERTION = 'expect(result()).toBeGreaterThan(0);';

export const BLOCK_ENTRY = [
  `  - file: '${FROZEN_TEST}'`,
  `    test: '${FROZEN_TITLE}'`,
  '    reason: tighten_only',
  '    ruling: D10-2341',
  '    note: Tighten the assertion around the known fixture result.',
].join('\n');
export const SUPPORT_ENTRY = [
  `  - file: '${KIT}'`,
  '    scope: support',
  '    reason: tighten_only',
  '    ruling: D10-2341',
  '    note: Share setup data without changing the assertions.',
].join('\n');

export const FROZEN_SOURCE = [
  "import { expect, it } from 'vitest';",
  '',
  'function result() {',
  '  return 1;',
  '}',
  '',
  `it('${FROZEN_TITLE}', () => {`,
  `  ${RESULT_ASSERTION}`,
  '});',
  '',
].join('\n');
export const TIGHTER_BLOCK = FROZEN_SOURCE.replace(RESULT_ASSERTION, 'expect(result()).toBe(1);');
export const KIT_SOURCE = 'export const fixtureValue = 1;\n';

const roots: string[] = [];

export function cleanup(): void {
  for (const root of roots.splice(0)) removeDir(root);
}

type Fixture = { root: string; repo: string; base: string };

export function commit(repo: string, message: string): string {
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'commit.gpgSign=false', 'commit', '-qm', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

export function fixture(name: string): Fixture {
  const root = scratchDir(`evidence-shape-${name}`);
  roots.push(root);
  const repo = join(root, 'rule test worktree');
  writeFiles(repo, {
    'package.json': '{"private":true,"packageManager":"pnpm@10.33.1"}\n',
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'pnpm-workspace.yaml': 'packages: []\n',
    [FROZEN_TEST]: FROZEN_SOURCE,
    [KIT]: KIT_SOURCE,
    [MANIFEST]: '{}\n',
  });
  git(repo, ['init', '-q', '-b', 'main', '--object-format=sha1']);
  const base = commit(repo, 'baseline with frozen tests');
  git(repo, ['switch', '-qc', `task/${TASK}`]);
  return { root, repo, base };
}

export function writeLedger(repo: string, modifyExisting?: string): void {
  writeFiles(repo, {
    [LEDGER]: taskYaml({
      id: TASK,
      title: 'Evidence shape fixture',
      type: 'guard-change',
      refs: '[]',
      refs_hash: '{}',
      paths: "\n  - 'tools/ci/evidence-check.ts'",
      test_paths: `\n  - '${TEST_DIR}/**'`,
      impl: 'claude',
      tester: 'codex',
      ...(modifyExisting === undefined ? {} : { modify_existing: `\n${modifyExisting}` }),
    }),
  });
}

export function ruleTestCommit(
  repo: string,
  changes: Record<string, string> = {},
  modifyExisting?: string,
): string {
  writeLedger(repo, modifyExisting);
  writeFiles(repo, {
    [NEW_TEST]: [
      "import { expect, it } from 'vitest';",
      `it('${NEW_TITLE}', () => {`,
      '  expect(1).toBe(2);',
      '});',
      '',
    ].join('\n'),
    ...changes,
  });
  return commit(repo, 'rule tests');
}

export function removeLedger(repo: string): void {
  rmSync(join(repo, LEDGER));
}

export function earlyArgs(repo: string, base: string, spec: string): string[] {
  return ['--early', '--pr', repo, '--task', TASK, '--base', base, '--spec', spec];
}

export function evidence(args: string[]) {
  return spawnSync(process.execPath, [join(ROOT, 'tools/ci/evidence-check.ts'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

type ShapeReport = {
  task: string;
  base: string;
  spec: string;
  problems: string[];
  notes: string[];
};

export function checkShape(
  args: string[],
  status: 0 | 1,
  revisions: { base: string; spec: string },
): ShapeReport {
  const result = evidence([...args, '--json']);
  expect(result.status, result.stderr).toBe(status);
  expect(result.stdout.replace(/\r?\n$/u, '').split('\n')).toHaveLength(1);
  const report = JSON.parse(result.stdout) as ShapeReport;
  expect(report).toEqual({
    task: TASK,
    base: revisions.base,
    spec: revisions.spec,
    problems: expect.any(Array),
    notes: expect.any(Array),
  });
  return report;
}
