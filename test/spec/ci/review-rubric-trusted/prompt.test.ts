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
  const companionContext = 'Task kind: companion test task (test-change, no implementation paths)';
  const redFirstExemption =
    /\bred[- ]first\b[`*_]*\s+(?:is (?:not (?:required|applicable)|waived)|does not apply)|\b(?:no|skip|waive|exempt(?:ed)? from|not subject to|do not (?:apply|require|enforce)(?: the)?) [`*_]*red[- ]first\b|不(?:按|要求|走|做|适用)先红|先红(?:豁免|不适用|不作要求)/i;
  const keepsRedFirst = [
    `When the review context says \`${companionContext}\`, the implementation is already on main and the tests are green there.`,
    'Its rule tests must go red first on the base; nothing else is required.',
    'Use the D10-2317 mutation probe to check whether the tests catch a wrong implementation.',
  ].join(' ');
  expect(keepsRedFirst).not.toMatch(redFirstExemption);

  const rule = ruleSection(/companion test|伴随测试/i);
  const sentences = rule.split(/[.!?。！？]/);
  const trigger = sentences.find((sentence) => sentence.includes(companionContext));
  expect(trigger ?? '').toMatch(/\b(?:review )?context\b|(?:评审)?上下文/i);
  expect(rule).toMatch(/main(?:line| branch)?\b|主干/i);
  expect(rule).toMatch(/\b(?:green|pass(?:ing)?)\b|为绿|通过/i);
  const waivesRedFirst = sentences.some((sentence) => redFirstExemption.test(sentence));
  expect(waivesRedFirst, rule).toBe(true);
  expect(rule).toMatch(/mutation probe|变异探针/i);
  expect(rule).toMatch(/wrong implementation|incorrect implementation|错误实现/i);
  expect(rule).toMatch(/D10-2317/);
});

it('[AC-CT-06zzzzzzzg#5] a confirmation round reviews only new and changed declarations', () => {
  const rule = ruleSection(/confirmation round|确认轮/i);
  expect(rule).toMatch(/Confirmation round: yes/i);
  const fields = ['red_exempt', 'red_exempt_outside', 'renames', 'expected_values'];
  const requiredFields = fields.map((field) => new RegExp(`\\b${field}\\b`));
  const fieldPattern = `\\b(?:${fields.join('|')})\\b`;
  const limitBeforeFields = /(?:\bonly\b|limited to|仅|只).{0,90}/;
  const limitAfterFields = /[`*_]*(?:\s+(?:entries|declarations))?\s+only\b/;
  const scopeLimit = new RegExp(
    `${limitBeforeFields.source}${fieldPattern}|${fieldPattern}${limitAfterFields.source}`,
    'i',
  );
  const clauses = rule.split(/[.!?。！？;；]/);
  const declarations = clauses.find((clause) => {
    return scopeLimit.test(clause) && requiredFields.every((field) => field.test(clause));
  });
  expect(declarations ?? '').toMatch(/\b(?:added|new)\b|新增/i);
  expect(declarations ?? '').toMatch(/\b(?:changed|modified|updated)\b|改动|修改/i);
  expect(declarations ?? '').toMatch(/\bthis round\b|本轮/i);
  expect(rule).toMatch(/trusted (?:task )?ledger|可信台账/i);
  expect(rule).toMatch(/\b(?:each|one by one|entry by entry)\b|逐条/i);
  expect(rule).toMatch(
    /(?:unconfirmed|cannot confirm|do not confirm)[^.]{0,120}\bS1\b|不确认[^。]{0,40}S1/i,
  );
  const excludesOtherTests =
    /\b(?:other|remaining|unrelated) tests(?: of (?:the|that) file)?(?: are| fall| remain| must be| should be)? (?:not (?:reviewed|in|part of)|outside|out of scope|excluded)\b|\b(?:do not review|exclude) (?:all )?(?:the )?(?:other|remaining|unrelated) tests\b|(?:其余|其他)测试(?:不在|不属于|不评审|不纳入|排除在)/i;
  const sentences = rule.split(/[.!?。！？]/);
  const outsideRound = sentences.find((sentence) => {
    return (
      excludesOtherTests.test(sentence) &&
      /\bthis round\b|本轮/i.test(sentence) &&
      /\bout_of_scope\b/.test(sentence)
    );
  });
  expect(outsideRound, 'Other tests go to out_of_scope in the same sentence').toBeDefined();
});

it('[AC-CT-06zzzzzzzg#6] the S1 rule heading cites approval 184', () => {
  const heading = readFileSync(promptFile, 'utf8')
    .split('\n')
    .find((line) => /^##+ /.test(line) && line.includes('S1') && line.includes('D10-2317'));
  expect(heading ?? '').toMatch(/\b184\b/);
});
