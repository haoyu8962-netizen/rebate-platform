import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { fixtureGit as git } from '../../../../tools/ops/test-helpers.ts';
import { FROZEN_TEST, checkShape, cleanup, earlyArgs, fixture, ruleTestCommit } from './kit.ts';

afterEach(cleanup);

it('[AC-CT-06#13] reports a frozen deletion without a modify_existing entry', () => {
  const { repo, base } = fixture('undeclared-delete');
  rmSync(join(repo, FROZEN_TEST));
  const spec = ruleTestCommit(repo);

  const report = checkShape(earlyArgs(repo, 'main', spec), 1, { base, spec });
  expect(report.problems).toContainEqual(expect.stringContaining(FROZEN_TEST));
});

it('[AC-CT-06#14] reports the original path of a frozen rename without a modify_existing entry', () => {
  const { repo, base } = fixture('undeclared-rename');
  const renamed = 'test/spec/identity/evidence-shape/renamed.test.ts';
  git(repo, ['mv', FROZEN_TEST, renamed]);
  const spec = ruleTestCommit(repo);

  const report = checkShape(earlyArgs(repo, 'main', spec), 1, { base, spec });
  expect(report.problems).toContainEqual(expect.stringContaining(FROZEN_TEST));
});
