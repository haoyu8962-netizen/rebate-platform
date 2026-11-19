// CT-06zzzzzq (FU-REVIEW-OUTPUT-NA-LINE, D10-2086 ②): the money checklist of
// tools/agent/validate-output.ts. An `na` item carries no position ("" / 0); an `na` position
// outside the diff is dropped with a warning instead of invalidating the review. Every other
// position check stays as it is: findings / out_of_scope, `ok` / `issue` items (missing or outside
// the diff). Each case pins the new `na` behaviour together with the controls it must keep; only
// the error / warning counts, the item and the cited position are pinned, plus the wording of the
// existing errors the task keeps unchanged.
import { expect, it } from 'vitest';
import { reviewProblems } from '../../../../tools/agent/validate-output.ts';
import {
  CHECKLIST_ITEMS,
  IN_DIFF,
  type Item,
  NA_OUT,
  NA_OUT_2,
  NO_POSITION,
  OUT,
  OUTSIDE_REASON,
  type Override,
  type Severity,
  diffChecker,
  finding,
  otherItem,
  review,
  validate,
} from './kit.ts';

const SEVERITIES: readonly Severity[] = ['S0', 'S1', 'S2'];
const CITED_STATUSES = ['ok', 'issue'] as const;

it('[AC-CT-06zzzzzq#1] an na item cited outside the diff: the review passes and one warning names the item and its original position', () => {
  const { check } = diffChecker();
  // Control: every item inside the diff, nothing to report.
  expect(validate(review(), check)).toEqual({ ok: true, errors: [], warnings: [] });
  // Control: an na item inside the diff gets no warning.
  expect(validate(review([['clock', { status: 'na' }]]), check)).toEqual({
    ok: true,
    errors: [],
    warnings: [],
  });

  for (const item of CHECKLIST_ITEMS) {
    const report = validate(review([[item, { status: 'na', ...NA_OUT }]]), check);
    expect(report.errors, item).toEqual([]);
    expect(report.ok, item).toBe(true);
    expect(report.warnings, item).toHaveLength(1);
    const warning = report.warnings[0] ?? '';
    expect(warning, item).toContain(item);
    expect(warning, item).toContain(NA_OUT.file);
    expect(warning, item).toContain(String(NA_OUT.line));
  }

  // Any negative answer of the checker counts as outside the diff (here: file not changed).
  const fileNotChanged = validate(
    review([['partial_refund', { status: 'na', ...NA_OUT }]]),
    (f, l) =>
      f === NA_OUT.file ? { ok: false, reason: 'file is not changed in the diff' } : check(f, l),
  );
  expect(fileNotChanged.errors).toEqual([]);
  expect(fileNotChanged.warnings).toHaveLength(1);
  expect(fileNotChanged.warnings[0]).toContain('partial_refund');

  // Two na items outside the diff: one warning each, each with its own item and position.
  const two = validate(
    review([
      ['rounding', { status: 'na', ...NA_OUT }],
      ['app_id', { status: 'na', ...NA_OUT_2 }],
    ]),
    check,
  );
  expect(two.errors).toEqual([]);
  expect(two.ok).toBe(true);
  expect(two.warnings).toHaveLength(2);
  const forFirst = two.warnings.filter((w) => w.includes(String(NA_OUT.line)));
  const forSecond = two.warnings.filter((w) => w.includes(String(NA_OUT_2.line)));
  expect(forFirst).toHaveLength(1);
  expect(forSecond).toHaveLength(1);
  expect(forFirst[0]).toContain('rounding');
  expect(forFirst[0]).toContain(NA_OUT.file);
  expect(forFirst[0]).not.toContain('app_id');
  expect(forSecond[0]).toContain('app_id');
  expect(forSecond[0]).toContain(NA_OUT_2.file);
  expect(forSecond[0]).not.toContain('rounding');

  // The other checks still apply to such an item: an empty note is an error, the position is not.
  const noNote = validate(review([['clock', { status: 'na', ...NA_OUT, note: ' ' }]]), check);
  expect(noNote.ok).toBe(false);
  expect(noNote.errors).toHaveLength(1);
  expect(noNote.errors[0]).toContain('(clock): note is empty');
});

it('[AC-CT-06zzzzzq#2] findings of every severity keep their position checks, also next to an na item without a position', () => {
  const { check } = diffChecker();
  const naItem: readonly [Item, Override] = ['clock', { status: 'na', ...NO_POSITION }];
  const missing = [
    NO_POSITION,
    { file: IN_DIFF.file, line: 0 },
    { file: '', line: IN_DIFF.line },
    { file: IN_DIFF.file, line: -1 },
  ];
  for (const severity of SEVERITIES) {
    // A well-formed finding next to an na item without a position: valid.
    const fine = validate(review([naItem], { findings: [finding(severity)] }), check);
    expect(fine.errors, severity).toEqual([]);
    expect(fine.ok, severity).toBe(true);

    for (const at of missing) {
      const label = `${severity} ${at.file}:${at.line}`;
      const inFindings = validate(review([naItem], { findings: [finding(severity, at)] }), check);
      expect(inFindings.ok, label).toBe(false);
      expect(inFindings.errors.join('\n'), label).toContain(
        'findings[0]: needs file and line >= 1',
      );
      expect(inFindings.errors.join('\n'), label).not.toContain('(clock)');

      const inOutOfScope = validate(
        review([naItem], { outOfScope: [finding(severity, at)] }),
        check,
      );
      expect(inOutOfScope.ok, label).toBe(false);
      expect(inOutOfScope.errors.join('\n'), label).toContain(
        'out_of_scope[0]: needs file and line >= 1',
      );
      expect(inOutOfScope.errors.join('\n'), label).not.toContain('(clock)');
    }

    // A finding outside the diff with its issue item citing the same place: still rejected
    // through the item, and the na relaxation turns nothing of it into a warning. (Whether the
    // finding's own position is compared with the diff is not pinned here: the validator never
    // did, and the task keeps the findings checks as they are.)
    const outside = validate(
      review([['rounding', { status: 'issue', ...OUT }], naItem], {
        findings: [finding(severity, OUT)],
      }),
      check,
    );
    expect(outside.ok, severity).toBe(false);
    expect(outside.errors.join('\n'), severity).toContain(
      `(rounding): ${OUT.file}:${OUT.line} ${OUTSIDE_REASON}`,
    );
    expect(outside.errors.join('\n'), severity).not.toContain('(clock)');
    expect(
      outside.warnings.filter((w) => w.includes(String(OUT.line))),
      severity,
    ).toEqual([]);
  }
});

it('[AC-CT-06zzzzzq#3] ok and issue items cited outside the diff are still rejected; only the na item next to them becomes a warning', () => {
  const { check } = diffChecker();
  for (const status of CITED_STATUSES) {
    for (const item of CHECKLIST_ITEMS) {
      const other = otherItem(item);
      const label = `${status} ${item}`;
      const report = validate(
        review([
          [item, { status, ...OUT }],
          [other, { status: 'na', ...NA_OUT }],
        ]),
        check,
      );
      expect(report.ok, label).toBe(false);
      expect(report.errors, label).toHaveLength(1);
      expect(report.errors[0], label).toContain(
        `(${item}): ${OUT.file}:${OUT.line} ${OUTSIDE_REASON}`,
      );
      expect(report.warnings, label).toHaveLength(1);
      expect(report.warnings[0], label).toContain(other);
      expect(report.warnings[0], label).toContain(String(NA_OUT.line));
    }
  }
  // Control: alone, the error is exactly the one the validator gave before.
  const at = CHECKLIST_ITEMS.indexOf('sign');
  const alone = validate(review([['sign', { status: 'ok', ...OUT }]]), check);
  expect(alone.errors).toEqual([
    `checklist[${at}] (sign): ${OUT.file}:${OUT.line} ${OUTSIDE_REASON}`,
  ]);
  expect(alone.warnings).toEqual([]);
});

it('[AC-CT-06zzzzzq#4] an na item without a position ("" / 0) passes and the line checker is never asked about it', () => {
  for (const item of CHECKLIST_ITEMS) {
    const { check, calls } = diffChecker();
    const r = review([[item, { status: 'na', ...NO_POSITION }]]);
    const report = validate(r, check);
    expect(report.errors, item).toEqual([]);
    expect(report.ok, item).toBe(true);
    expect(
      calls.filter((c) => c.file === '' || c.line < 1),
      item,
    ).toEqual([]);
    // The six other items are still checked against the diff.
    expect(calls, item).toHaveLength(CHECKLIST_ITEMS.length - 1);
    // Without --diff-base as well, through both entries.
    expect(validate(r).errors, item).toEqual([]);
    expect(reviewProblems(r, { money: true }).errors, item).toEqual([]);
  }

  const { check, calls } = diffChecker();
  const allNa = review(
    CHECKLIST_ITEMS.map((item): readonly [Item, Override] => [
      item,
      { status: 'na', ...NO_POSITION },
    ]),
  );
  const report = validate(allNa, check);
  expect(report.errors).toEqual([]);
  expect(report.ok).toBe(true);
  expect(calls).toEqual([]);
});

it('[AC-CT-06zzzzzq#5] an ok or issue item without a position is still rejected (needs file and line >= 1)', () => {
  for (const status of CITED_STATUSES) {
    for (const item of CHECKLIST_ITEMS) {
      const other = otherItem(item);
      const label = `${status} ${item}`;
      const { check, calls } = diffChecker();
      const report = validate(
        review([
          [item, { status, ...NO_POSITION }],
          [other, { status: 'na', ...NO_POSITION }],
        ]),
        check,
      );
      expect(report.ok, label).toBe(false);
      expect(report.errors, label).toHaveLength(1);
      expect(report.errors[0], label).toContain(`(${item}): needs file and line >= 1`);
      expect(
        calls.filter((c) => c.file === '' || c.line < 1),
        label,
      ).toEqual([]);
    }
  }
  // Half a position is no position for an ok item either.
  const { check } = diffChecker();
  for (const at of [
    { file: IN_DIFF.file, line: 0 },
    { file: '', line: IN_DIFF.line },
    { file: '  ', line: IN_DIFF.line },
    { file: IN_DIFF.file, line: -1 },
  ]) {
    const label = `${at.file}:${at.line}`;
    const report = validate(
      review([
        ['sign', { status: 'ok', ...at }],
        ['clock', { status: 'na', ...NO_POSITION }],
      ]),
      check,
    );
    expect(report.ok, label).toBe(false);
    expect(report.errors, label).toHaveLength(1);
    expect(report.errors[0], label).toContain('(sign): needs file and line >= 1');
  }
});
