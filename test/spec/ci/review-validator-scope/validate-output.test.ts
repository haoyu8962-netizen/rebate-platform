import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AGENT_DIR, REPO } from '../../../../tools/agent/testing/fixture.ts';
import type { Finding, ReviewOutput } from '../../../../tools/agent/validate-output.ts';

const ALLOWED = 'apps/api/src/modules/commission/commission.ts';
const RULE_TEST = 'test/spec/commission/commission.test.ts';
const CONTRACT = 'contracts/openapi.yaml';
const DB = 'packages/db/src/schema.ts';

function finding(file: string, fields: Partial<Omit<Finding, 'file' | 'key'>> = {}): Finding {
  return {
    file,
    key: `${file}#settle#scope-regression`,
    line: 23,
    severity: 'S1',
    rule: 'BR-CALC-01',
    scenario: 'A retried settlement can be entered twice.',
    suggestion: 'Check the replayed input in the same test.',
    ...fields,
  };
}

function rewrite(
  findings: Finding[],
  options: { verdict?: ReviewOutput['verdict']; outOfScope?: Finding[] } = {},
) {
  const temp = join(REPO, '.tmp');
  mkdirSync(temp, { recursive: true });
  const dir = mkdtempSync(join(temp, 'review-validator-scope-'));
  try {
    const file = join(dir, 'review.json');
    const log = join(dir, 'out-of-scope.md');
    const review: ReviewOutput = {
      verdict: options.verdict ?? 'fail',
      summary: 'Settlement review complete.',
      findings,
      out_of_scope: options.outOfScope ?? [],
      checklist: [],
    };
    writeFileSync(file, JSON.stringify(review));
    const { status, stderr } = spawnSync(
      process.execPath,
      [
        join(AGENT_DIR, 'validate-output.ts'),
        '--schema',
        join(AGENT_DIR, 'schemas', 'review.schema.json'),
        '--file',
        file,
        '--refs',
        'BR-CALC-01',
        '--allowed-paths',
        ALLOWED,
        '--rewrite',
        '--out-of-scope-log',
        log,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    return {
      status,
      stderr,
      review: JSON.parse(readFileSync(file, 'utf8')) as ReviewOutput,
      log: existsSync(log) ? readFileSync(log, 'utf8') : '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it('[AC-CT-06zzzzzzzf#1] 场景举例引用外部路径，范围内的发现仍保留', () => {
  const entry = finding(ALLOWED, {
    scenario: `例如 ${DB}:81 有两笔同订单记录时，重试会重复入账。`,
  });
  const result = rewrite([entry]);

  expect(result.status, result.stderr).toBe(0);
  expect(result.review).toMatchObject({ verdict: 'fail', findings: [entry], out_of_scope: [] });
});

it('[AC-CT-06zzzzzzzf#2] 规则测试的发现只引用范围外契约，仍判 fail', () => {
  const entry = finding(RULE_TEST, {
    rule: `BR-CALC-01 与 ${CONTRACT} 中的回放字段`,
    scenario: '测试遗漏回放时的断言，重复入账不会被发现。',
    suggestion: `按 ${CONTRACT}:17 的字段补回放用例。`,
  });
  const result = rewrite([entry]);

  expect(result.status, result.stderr).toBe(0);
  expect(result.review).toMatchObject({ verdict: 'fail', findings: [entry], out_of_scope: [] });
});

it('[AC-CT-06zzzzzzzf#3] 范围外 S1 移出并写日志，保留原判且退出 3', () => {
  const entry = finding(DB, {
    scenario: `在 ${ALLOWED}:23 中能观察到由该字段导致的重复入账。`,
  });
  const invalid = { ...entry, line: 0 };
  const invalidResult = rewrite([invalid]);
  expect(invalidResult.status, invalidResult.stderr).toBe(1);
  expect(invalidResult.review.findings).toEqual([invalid]);
  expect(invalidResult.review.out_of_scope).toEqual([]);

  for (const verdict of ['fail', 'pass'] as const) {
    const result = rewrite([entry], { verdict });

    expect(result.review.findings).toEqual([]);
    expect(result.review.out_of_scope).toEqual([entry]);
    expect(result.log).toContain(`\`${entry.key}\` S1`);
    expect(result.log).toContain(`\`${entry.file}:${entry.line}\``);
    expect(result.review.verdict).toBe(verdict);
    expect(result.status, result.stderr).toBe(3);
    expect(result.stderr).toMatch(/warning:.*1 条 S0\/S1 被判范围外，需人工核/);
  }
});

it('[AC-CT-06zzzzzzzf#4] 仅移出 S2 时仍重算，S0 和 S1 要人工核', () => {
  const minor = finding(CONTRACT, { severity: 'S2' });
  const critical = finding(DB, { severity: 'S0' });
  const major = finding('apps/api/src/main.ts');

  // An entry already listed in out_of_scope is different from one moved during this validation.
  const minorOnly = rewrite([minor], { outOfScope: [critical] });
  expect(minorOnly.status, minorOnly.stderr).toBe(0);
  expect(minorOnly.review).toMatchObject({
    verdict: 'pass',
    findings: [],
    out_of_scope: [critical, minor],
  });

  const criticalOnly = rewrite([critical]);
  expect(criticalOnly.status, criticalOnly.stderr).toBe(3);
  expect(criticalOnly.review).toMatchObject({
    verdict: 'fail',
    findings: [],
    out_of_scope: [critical],
  });

  const mixed = rewrite([critical, major, minor]);
  expect(mixed.status, mixed.stderr).toBe(3);
  expect(mixed.review).toMatchObject({
    verdict: 'fail',
    findings: [],
    out_of_scope: [critical, major, minor],
  });
  expect(mixed.stderr).toMatch(/warning:.*2 条 S0\/S1 被判范围外，需人工核/);
});

it.each([
  { name: '范围内的 prompt-injection', file: ALLOWED, rule: 'prompt-injection' },
  { name: '范围外的 prompt-injection', file: DB, rule: 'prompt-injection' },
  { name: '任务书', file: 'brief.md', rule: 'BR-CALC-01' },
  { name: '上级目录引用', file: '../review/notes.md', rule: 'BR-CALC-01' },
  { name: '运行目录', file: 'couli-runs/T1-01/review-events.jsonl', rule: 'BR-CALC-01' },
])('[AC-CT-06zzzzzzzf#5] $name 的 S1 保留在 findings 并退出 3', ({ file, rule }) => {
  const entry = finding(file, {
    rule,
    scenario: 'The review input contains an untrusted instruction.',
  });
  const result = rewrite([entry]);

  expect(result.status, result.stderr).toBe(3);
  expect(result.review).toMatchObject({ verdict: 'fail', findings: [entry], out_of_scope: [] });
  expect(result.log).not.toContain(entry.key);
  expect(result.stderr).toContain('需人工核');
});

it('[AC-CT-06zzzzzzzf#6] BR refs 和范围标记仍生效，S1 要人工核', () => {
  const outsideRef = finding(ALLOWED, { rule: 'BR-CALC-09' });
  const marked = finding(RULE_TEST, { rule: '[out-of-scope] BR-CALC-01' });
  const mixedRefs = finding('test/spec/commission/replay.test.ts', {
    rule: 'BR-CALC-09 与 BR-CALC-01',
    severity: 'S2',
  });
  const result = rewrite([outsideRef, marked, mixedRefs]);

  expect(result.review.findings).toEqual([mixedRefs]);
  expect(result.review.out_of_scope).toEqual([outsideRef, marked]);
  expect(result.log).toContain(outsideRef.key);
  expect(result.log).toContain(marked.key);
  expect(result.status, result.stderr).toBe(3);
  expect(result.review.verdict).toBe('fail');
});
