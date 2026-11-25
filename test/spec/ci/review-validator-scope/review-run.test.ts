import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  FAKE_CLAUDE,
  TASK,
  installLoggedState,
  makeFixture,
  readJson,
  runScript,
  stubCalls,
  trustedState,
  trustedTaskState,
  writeStub,
} from '../../../../tools/agent/testing/fixture.ts';

it.each([
  {
    script: 'codex-run.sh',
    engine: 'codex',
    tester: 'claude',
    outputVar: 'FAKE_CODEX_OUTPUT_FILE',
  },
  {
    script: 'claude-run.sh',
    engine: 'claude-independent',
    tester: 'codex',
    outputVar: 'FAKE_CLAUDE_OUTPUT_FILE',
  },
])(
  '[AC-CT-06zzzzzzzf#7] $script 将校验码 3 转为 13，保留产出和轮次',
  { timeout: 60_000 },
  ({ script, engine, tester, outputVar }) => {
    const fx = makeFixture(`review-needs-human-${engine}`);
    try {
      writeStub(join(fx.trusted, 'tools', 'ops', 'task.ts'), 'task', [
        {
          when: ['show'],
          stdout: JSON.stringify({
            id: TASK,
            type: 'impl',
            risk: 'RV1',
            tester,
            paths: ['src/a.ts'],
          }),
        },
      ]);
      const messages = [
        'warning: findings[0] came from outside the task',
        'warning: 1 条 S0/S1 被判范围外，需人工核',
      ];
      writeStub(join(fx.trusted, 'tools', 'agent', 'validate-output.ts'), 'validate', [
        { exit: 3, stderr: messages.join('\n') },
      ]);
      const output = {
        verdict: 'fail',
        summary: 'One replay case needs review.',
        findings: [
          {
            severity: 'S1',
            file: 'contracts/openapi.yaml',
            line: 17,
            key: 'contracts/openapi.yaml#order#replay',
            rule: 'replay',
            scenario: 'An order replay can be accepted twice.',
            suggestion: 'Cover a replay in the rule test.',
          },
        ],
        out_of_scope: [],
        checklist: [],
      };
      const modelOutput = join(fx.root, 'model-review.json');
      writeFileSync(modelOutput, JSON.stringify(output));
      writeFileSync(join(fx.worktree, 'src', 'a.ts'), 'export const a = 2;\n');
      installLoggedState(fx);
      const bump = trustedState(fx, [
        'bump-attempt',
        TASK,
        'review',
        '--review-type',
        'spec-test',
        '--engine',
        engine,
      ]);
      expect(bump.status, bump.stderr).toBe(0);
      expect(trustedTaskState(fx)?.attempts['spec-test']).toBe(1);

      const result = runScript(
        script,
        ['review', TASK, '--base', fx.baseSha, '--review-type', 'spec-test'],
        fx.env,
        { COULI_CLAUDE_BIN: FAKE_CLAUDE, [outputVar]: modelOutput },
      );

      expect(stubCalls(fx, 'validate'), result.stderr).toHaveLength(1);
      expect(result.status, result.stderr).toBe(13);
      expect(result.stderr).toContain('需人工核');
      const meta = readJson(join(fx.run, 'meta.json'));
      expect(meta).toMatchObject({
        engine,
        exit_code: 13,
        validation: 'needs-human',
        validation_messages: messages,
      });
      expect(readJson(join(fx.run, 'meta.review.json'))).toMatchObject({
        exit_code: 13,
        validation: 'needs-human',
      });
      const reviewFile = join(fx.run, `review-${engine}.json`);
      expect(existsSync(reviewFile)).toBe(true);
      expect(readJson(reviewFile)).toEqual(output);
      expect(existsSync(`${reviewFile}.rejected`)).toBe(false);
      const state = trustedTaskState(fx);
      expect(state?.attempts['spec-test']).toBe(1);
      expect(state?.pending_bumps.at(-1)).toMatchObject({ engine, outcome: 'kept' });
    } finally {
      fx.cleanup();
    }
  },
);
