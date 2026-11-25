import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const promptFile = new URL('../../../../tools/agent/prompts/review-spec-test.md', import.meta.url);

function ruleSection(heading: RegExp): string {
  const sections = readFileSync(promptFile, 'utf8').split(/\n(?=##+ )/);
  const section = sections.find((part) => heading.test(part.split('\n')[0] ?? ''));
  expect(section, `缺少可信提示词章节 ${heading}`).toBeDefined();
  return (section ?? '').replace(/\s+/g, ' ');
}

it('[AC-CT-06zzzzzzzg#4] companion tests still need to detect wrong implementations', () => {
  const rule = ruleSection(/companion test|伴随测试/i);
  expect(rule).toMatch(/companion test task|伴随测试单/i);
  expect(rule).toMatch(/main(?:line| branch)?\b|主干/i);
  expect(rule).toMatch(/\b(?:green|pass(?:ing)?)\b|为绿|通过/i);
  expect(rule).toMatch(
    /(?:\bno\b|not|skip|waiv|exempt|without)[^.]{0,80}red\b|red\b[^.]{0,60}(?:not required|does not apply)|不[^。]{0,40}先红/i,
  );
  expect(rule).toMatch(/mutation probe|变异探针/i);
  expect(rule).toMatch(/wrong implementation|incorrect implementation|错误实现/i);
  expect(rule).toMatch(/D10-2317/);
});

it('[AC-CT-06zzzzzzzg#5] a confirmation round reviews only new and changed declarations', () => {
  const rule = ruleSection(/confirmation round|确认轮/i);
  expect(rule).toMatch(/Confirmation round: yes/i);
  for (const field of ['red_exempt', 'red_exempt_outside', 'renames', 'expected_values']) {
    expect(rule).toMatch(new RegExp(`\\b${field}\\b`));
  }
  expect(rule).toMatch(/\bonly\b|limited to|仅|只/i);
  expect(rule).toMatch(/trusted (?:task )?ledger|可信台账/i);
  expect(rule).toMatch(/\b(?:added|new)\b|新增/i);
  expect(rule).toMatch(/\b(?:changed|modified|updated)\b|改动|修改/i);
  expect(rule).toMatch(/\bthis round\b|本轮/i);
  expect(rule).toMatch(/\b(?:each|one by one|entry by entry)\b|逐条/i);
  expect(rule).toMatch(
    /(?:unconfirmed|cannot confirm|do not confirm)[^.]{0,120}\bS1\b|不确认[^。]{0,40}S1/i,
  );
  expect(rule).toMatch(/(?:other|remaining|unrelated) tests|其余测试|其他测试/i);
  expect(rule).toMatch(/out_of_scope/);
});

it('[AC-CT-06zzzzzzzg#6] the S1 rule heading cites approval 184', () => {
  const heading = readFileSync(promptFile, 'utf8')
    .split('\n')
    .find((line) => /^##+ /.test(line) && line.includes('S1') && line.includes('D10-2317'));
  expect(heading ?? '').toMatch(/\b184\b/);
});
