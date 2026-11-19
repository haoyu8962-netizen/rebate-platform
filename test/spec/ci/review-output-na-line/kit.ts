// CT-06zzzzzq (FU-REVIEW-OUTPUT-NA-LINE, D10-2086 ② / D10-2087): helpers for the rule tests of
// the money checklist in tools/agent/validate-output.ts. The validator is reached only through
// its exported entries (validateOutput with the real review schema, reviewProblems); the diff is
// stood in for by an injected LineChecker, as tools/agent/validate-output.test.ts does.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHECKLIST_ITEMS,
  type ChecklistEntry,
  type Finding,
  type LineChecker,
  type Report,
  type ReviewOutput,
  validateOutput,
} from '../../../../tools/agent/validate-output.ts';

export { CHECKLIST_ITEMS };
export type Item = (typeof CHECKLIST_ITEMS)[number];
export type Status = ChecklistEntry['status'];
export type Severity = Finding['severity'];

export const REPO = join(import.meta.dirname, '..', '..', '..', '..');
export const REVIEW_SCHEMA: unknown = JSON.parse(
  readFileSync(join(REPO, 'tools', 'agent', 'schemas', 'review.schema.json'), 'utf8'),
);
export const MONEY_PROMPT = join(REPO, 'tools', 'agent', 'prompts', 'review-money.md');

/** The only line the injected diff contains. */
export const IN_DIFF = { file: 'src/changed.ts', line: 12 } as const;
/** A position of an `na` item outside the diff (distinctive line number, see the warnings). */
export const NA_OUT = { file: 'src/untouched.ts', line: 4321 } as const;
/** A second `na` position outside the diff, in another file. */
export const NA_OUT_2 = { file: 'src/elsewhere.ts', line: 8765 } as const;
/** A position of an `ok` / `issue` item or a finding outside the diff. */
export const OUT = { file: 'src/untouched.ts', line: 77 } as const;
/** "No position" as the template prescribes for `na` items (schema unchanged: "" and 0). */
export const NO_POSITION = { file: '', line: 0 } as const;

export const OUTSIDE_REASON = 'line is outside the diff hunks of this file';

export type Call = { file: string; line: number };

/** A LineChecker whose diff holds IN_DIFF only; every call is recorded. */
export function diffChecker(): { check: LineChecker; calls: Call[] } {
  const calls: Call[] = [];
  const check: LineChecker = (file, line) => {
    calls.push({ file, line });
    return file === IN_DIFF.file && line === IN_DIFF.line
      ? { ok: true, reason: '' }
      : { ok: false, reason: OUTSIDE_REASON };
  };
  return { check, calls };
}

export type Override = { status?: Status; file?: string; line?: number; note?: string };

export function finding(severity: Severity, at: { file: string; line: number } = IN_DIFF): Finding {
  return {
    severity,
    key: `${at.file}#split#rounding-direction`,
    file: at.file,
    line: at.line,
    rule: 'rounding-direction',
    scenario: 'base 101 fen at 5000 bp yields 51 instead of the floor 50',
    suggestion: 'Use floor division.',
  };
}

/**
 * A schema-valid money review: every checklist item `ok` at IN_DIFF unless overridden. Without
 * explicit findings there is one S2 finding at IN_DIFF when an item is `issue`, else none; the
 * verdict follows the S0 / S1 findings.
 */
export function review(
  overrides: readonly (readonly [Item, Override])[] = [],
  opts: { findings?: Finding[]; outOfScope?: Finding[] } = {},
): ReviewOutput {
  const byItem = new Map(overrides);
  const checklist = CHECKLIST_ITEMS.map((item): ChecklistEntry => ({
    item,
    status: 'ok',
    file: IN_DIFF.file,
    line: IN_DIFF.line,
    note: `verified ${item} on the changed line`,
    ...byItem.get(item),
  }));
  const findings =
    opts.findings ?? (checklist.some((c) => c.status === 'issue') ? [finding('S2')] : []);
  return {
    verdict: findings.some((f) => f.severity === 'S0' || f.severity === 'S1') ? 'fail' : 'pass',
    summary: 'Checked the seven money axes of the change; see the checklist notes.',
    findings,
    out_of_scope: opts.outOfScope ?? [],
    checklist,
  };
}

/** validateOutput with the real review schema and --money (plus --diff-base when a checker is given). */
export function validate(r: ReviewOutput, lineChecker?: LineChecker): Report {
  return validateOutput(
    REVIEW_SCHEMA,
    r,
    lineChecker === undefined ? { money: true } : { money: true, lineChecker },
  );
}

/** The other item used alongside `item` in a case. */
export function otherItem(item: Item): Item {
  return item === 'clock' ? 'sign' : 'clock';
}
