// CT-06zzzzzv (D10-2152): a top-level `for (const route of [ … ])` over an inline array of literal
// rows, its body the base's, one `it` per row, is compared row by row: a row whose text is the
// base's is an unchanged test, a changed row declared in modify_existing by its full name passes
// as a declared change (undeclared it must be red), and a row whose title holds a run-time value
// is taken by its index while its text is unchanged. Where declarations apply (a file listed in
// red_exempt_outside), the unchanged rows may be declared in red_exempt.
import { expect, it } from 'vitest';
import {
  BASE_ROWS,
  F,
  HEAD_ROWS,
  N_CONSENT,
  N_GET,
  N_STEP,
  Q_BASE,
  Q_HEAD,
  Q_LEDGER,
  ROW_CONSENT,
  ROW_GET,
  ROW_STEP,
  ROW_STEP_HEAD,
  T1,
  T_NEW,
  UUID_A,
  UUID_B,
  exemptOf,
  judgeF,
  ledger,
  linkName,
  modifyOf,
  outsideOf,
  qTests,
  testFile,
} from './kit.ts';

it('[CT-06zzzzzv#1] the B1-02zzzc shape — one row of the for…of table changed and declared in modify_existing, a new test next to it — passes: the unchanged rows are exempt, the declared row passes green as a declared change, the new test is red', () => {
  expect(BASE_ROWS).not.toEqual(HEAD_ROWS);
  const { expected, result } = judgeF(Q_BASE, Q_HEAD, Q_LEDGER, qTests());
  expect(expected).toEqual([F]);
  expect(result.problems).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.red).toEqual([`${F} > ${T_NEW}`]);
  const exempt = result.exempt ?? [];
  expect(exempt.filter((e) => e.modified === true).map((e) => e.test)).toEqual([N_STEP]);
  for (const name of [T1, N_GET, N_CONSENT, linkName(UUID_A)]) {
    expect(
      exempt.some((e) => e.file === F && e.test === name && e.modified !== true),
      name,
    ).toBe(true);
  }
});

it('[CT-06zzzzzv#2] the changed row undeclared must be red as before: green it is the only problem (the unchanged rows stay exempt), red the run is ok', () => {
  const green = judgeF(Q_BASE, Q_HEAD, ledger(), qTests());
  expect(green.expected).toEqual([F]);
  expect(green.result.ok).toBe(false);
  expect(green.result.problems.map((p) => [p.file, p.test])).toEqual([[F, N_STEP]]);
  expect(green.result.problems[0]?.reason).toMatch(/green on the skeleton/);
  const red = judgeF(Q_BASE, Q_HEAD, ledger(), qTests(), [N_STEP, T_NEW]);
  expect(red.result.problems).toEqual([]);
  expect(red.result.ok).toBe(true);
  expect([...red.result.red].sort()).toEqual([`${F} > ${N_STEP}`, `${F} > ${T_NEW}`].sort());
});

it('[CT-06zzzzzv#3] in a file whose change outside the tests is declared in red_exempt_outside, the unchanged rows can be declared in red_exempt (declared exemptions that apply) next to the declared changed row', () => {
  const rows = [ROW_GET, ROW_CONSENT, ROW_STEP];
  const base = testFile({ rows });
  const head = testFile({
    rows: [ROW_GET, ROW_CONSENT, ROW_STEP_HEAD],
    stepUp: true,
    added: true,
  });
  const l = ledger({
    red_exempt_outside: [outsideOf(F)],
    red_exempt: [exemptOf(F, T1), exemptOf(F, N_GET), exemptOf(F, N_CONSENT)],
    modify_existing: [modifyOf(F, N_STEP)],
  });
  const { expected, result } = judgeF(base, head, l, [T1, N_GET, N_CONSENT, N_STEP, T_NEW]);
  expect(expected).toEqual([F]);
  expect(result.problems).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.red).toEqual([`${F} > ${T_NEW}`]);
  const exempt = result.exempt ?? [];
  for (const name of [N_GET, N_CONSENT]) {
    expect(
      exempt.some((e) => e.test === name && e.declared === true && e.modified !== true),
      name,
    ).toBe(true);
  }
  expect(exempt.filter((e) => e.modified === true).map((e) => e.test)).toEqual([N_STEP]);
  // Without the red_exempt entries the unchanged rows of such a file must be red, as any test.
  const undeclared = judgeF(
    base,
    head,
    ledger({ red_exempt_outside: [outsideOf(F)], modify_existing: [modifyOf(F, N_STEP)] }),
    [T1, N_GET, N_CONSENT, N_STEP, T_NEW],
  );
  expect(undeclared.result.ok).toBe(false);
  for (const name of [N_GET, N_CONSENT]) {
    expect(
      undeclared.result.problems.some((p) => p.test === name),
      name,
    ).toBe(true);
  }
});

it('[CT-06zzzzzv#4] the run-time row (its path made with randomUUID()) unchanged is taken by its index, whatever name the run gave it: exempt green in every run', () => {
  for (const uuid of [UUID_A, UUID_B]) {
    const { result } = judgeF(Q_BASE, Q_HEAD, Q_LEDGER, qTests(uuid));
    expect(result.problems, uuid).toEqual([]);
    expect(result.ok, uuid).toBe(true);
    expect(
      (result.exempt ?? []).some((e) => e.test === linkName(uuid) && e.modified !== true),
      uuid,
    ).toBe(true);
  }
  // The same file with the step-up row unchanged and only the new test: still ok, nothing but the
  // new test red.
  const head = testFile({ rows: BASE_ROWS, added: true });
  const { result } = judgeF(Q_BASE, head, ledger(), [
    T1,
    N_GET,
    N_CONSENT,
    linkName(UUID_B),
    N_STEP,
    T_NEW,
  ]);
  expect(result.problems).toEqual([]);
  expect(result.red).toEqual([`${F} > ${T_NEW}`]);
});
