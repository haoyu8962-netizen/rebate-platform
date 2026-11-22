import { expect, it } from 'vitest';
import { expectedRedFiles } from '../../../../tools/ci/evidence-check.ts';
import {
  checkRedReports,
  ruleTestBaselines,
  ruleTestsLeftOut,
} from '../../../../tools/guard/lib/red-check.ts';
import { ROOT, type RedTest, parse, redReport } from '../modify-existing-support/kit.ts';
import { FILE, NOTE, OUTSIDE, SUITE, TITLE, eachBlock, entry, source, taskLedger } from './kit.ts';

const task = parse(taskLedger(entry()));
const base = source([eachBlock(1)]);
const head = source([eachBlock(2)]);

function baselineReader(after: string) {
  return {
    base: (file: string) => (file === FILE ? base : null),
    head: (file: string) => (file === FILE ? after : null),
  };
}

it('[AC-CT-06zzzzzzzc#9] 先红与证据检查对整块改动使用同一份应跑清单', () => {
  const read = baselineReader(head);
  const red = ruleTestsLeftOut([FILE], read, task);
  const evidence = expectedRedFiles([FILE], read, task, task.modify_existing);
  const mixed = baselineReader(source([eachBlock(2)], 1));
  expect({
    red: red.expected,
    modifiedLeftOut: red.modifiedLeftOut,
    evidence,
    mixedRed: ruleTestsLeftOut([FILE], mixed, task).expected,
    mixedEvidence: expectedRedFiles([FILE], mixed, task, task.modify_existing),
  }).toEqual({
    red: [],
    modifiedLeftOut: [FILE],
    evidence: [],
    mixedRed: [FILE],
    mixedEvidence: [FILE],
  });
});

const alpha = `${SUITE} > ${TITLE.replace('$label', 'alpha')}`;
const beta = `${SUITE} > ${TITLE.replace('$label', 'beta')}`;
const summary = `${SUITE} > ${OUTSIDE}`;
const assertion = 'AssertionError: expected 1 to be 2';

const outcomes: { label: string; outside: RedTest; ok: boolean }[] = [
  { label: '相邻改动为有效红', outside: [summary, 'failed', assertion], ok: true },
  { label: '相邻改动未登记且为绿', outside: [summary, 'passed'], ok: false },
];

it.each(outcomes)('[AC-CT-06zzzzzzzc#10] 红绿行归到整块登记 $label', ({ outside, ok }) => {
  const after = source([eachBlock(2)], 1);
  const baselines = ruleTestBaselines(
    [FILE],
    [{ path: FILE, status: 'M' }],
    task.paths,
    baselineReader(after),
    task.renames,
    task.expected_values,
    task.red_exempt_outside,
    task.red_exempt_rows,
    task.modify_existing,
  );
  const report = redReport(FILE, [[alpha, 'failed', assertion], [beta, 'passed'], outside]);
  const result = checkRedReports(
    [report],
    [FILE],
    ROOT,
    baselines,
    task.red_exempt,
    task.red_exempt_rows,
    task.modify_existing,
  );
  expect(result.problems).toMatchObject(
    ok ? [] : [{ file: FILE, test: summary, reason: expect.stringMatching(/green|为绿/i) }],
  );
  expect(result.ok).toBe(ok);
  expect(result.exempt?.filter((test) => test.modified)).toMatchObject([
    { file: FILE, test: alpha, status: 'failed', reason: NOTE },
    { file: FILE, test: beta, status: 'passed', reason: NOTE },
  ]);
  expect(result.red).toContain(`${FILE} > ${alpha}`);
  const betaNote = result.notes.some((note) => note.includes(beta) && note.includes('rule_change'));
  expect(betaNote).toBe(true);
});
