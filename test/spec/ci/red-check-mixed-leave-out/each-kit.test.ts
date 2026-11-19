// CT-06zzzzzr (D10-2125) (B): a modify_existing `.each` / `.for` block whose table is one name
// imported from a same-directory test-support file exporting it at its top level as
// `export const NAME = [ literals ]` (`as const` or not) is expanded row by row — the base from
// the base's kit, the head from the head's — and its declared rows apply. Another directory, a
// re-export, a `let`, the result of a call, a non-literal row, a kit the base does not have: the
// rows still cannot be expanded and the entries do not apply.
import { expect, it } from 'vitest';
import {
  ACTIONS_BARE,
  ACTIONS_DECL,
  ACTIONS_MODULE,
  OTHER_KIT,
  S1,
  S2_ROWS,
  S3,
  SMS,
  SMS_KIT,
  SMS_LEDGER,
  type Tree,
  modifiedOnlyFiles,
  reader,
  redRun,
  smsFile,
  smsKit,
  smsOutcomes,
} from './kit.ts';

/** The base and head trees: the sms file (callback changed at the head) and `extra` files. */
const trees = (
  opts: { importLine?: string; added?: boolean },
  base: Tree,
  head: Tree = base,
): { base: Tree; head: Tree } => ({
  base: { ...base, [SMS]: smsFile({ ...opts, head: false, added: false }) },
  head: { ...head, [SMS]: smsFile({ ...opts, head: true }) },
});

const run = (t: { base: Tree; head: Tree }) =>
  redRun([SMS], reader(t.base, t.head), SMS_LEDGER, smsOutcomes(true));

/** Every declared row is a problem that says the entry does not apply because of `why`. */
const refusedRows = (t: { base: Tree; head: Tree }, why: RegExp, name: string): void => {
  const result = run(t);
  expect(result.ok, name).toBe(false);
  for (const row of S2_ROWS) {
    const p = result.problems.find(
      (x) => x.file === SMS && x.test === row && /does not apply/.test(x.reason),
    );
    expect(p?.reason, `${name}: ${row}\n${JSON.stringify(result.problems, null, 2)}`).toMatch(why);
  }
};

it('[CT-06zzzzzr#14] it.each(ACTIONS), ACTIONS `export const … = [literals]` (as const or not) in ./kit.ts: every row declared and the shared callback changed, the file is left out by modifiedOnlyFiles; with a new test next to it, it stays expected', () => {
  for (const decl of [ACTIONS_DECL, ACTIONS_BARE]) {
    const t = trees({}, { [SMS_KIT]: smsKit(decl) });
    expect(
      modifiedOnlyFiles([SMS], reader(t.base, t.head), SMS_LEDGER.modify_existing),
      decl,
    ).toEqual([{ file: SMS, tests: [...S2_ROWS] }]);
    const added = trees({ added: true }, { [SMS_KIT]: smsKit(decl) });
    expect(
      modifiedOnlyFiles([SMS], reader(added.base, added.head), SMS_LEDGER.modify_existing),
      decl,
    ).toEqual([]);
  }
});

it('[CT-06zzzzzr#15] the B1-02zzzb (B) shape in the red run: the declared rows of it.each(ACTIONS) pass green as declared changes, the unchanged test is exempt, the new test is red: ok', () => {
  for (const decl of [ACTIONS_DECL, ACTIONS_BARE]) {
    const result = run(trees({ added: true }, { [SMS_KIT]: smsKit(decl) }));
    expect(result.problems, decl).toEqual([]);
    expect(result.ok, decl).toBe(true);
    expect(result.red, decl).toEqual([`${SMS} > ${S3}`]);
    expect(
      (result.exempt ?? []).filter((e) => e.modified === true).map((e) => e.test),
      decl,
    ).toEqual([...S2_ROWS]);
    expect(
      (result.exempt ?? []).some((e) => e.test === S1 && e.modified !== true),
      decl,
    ).toBe(true);
  }
});

it('[CT-06zzzzzr#16] still cannot be expanded for certain: a kit of another directory, a re-export (export { … } from, export * from), a let, the result of a call, a non-literal or spread row', () => {
  // The control: the same file and a same-directory kit exporting the literal array.
  const ok = run(trees({ added: true }, { [SMS_KIT]: smsKit() }));
  expect(ok.problems).toEqual([]);
  const cannot = /cannot be expanded for certain/;
  const cases: [string, { base: Tree; head: Tree }][] = [
    [
      'a kit of another directory',
      trees(
        { importLine: "import { ACTIONS, send } from '../zzother/kit.ts';", added: true },
        { [OTHER_KIT]: smsKit() },
      ),
    ],
    [
      'export { ACTIONS } from a second module',
      trees(
        { added: true },
        {
          [SMS_KIT]: smsKit("export { ACTIONS } from './actions.ts';"),
          [ACTIONS_MODULE]: ACTIONS_DECL,
        },
      ),
    ],
    [
      'export * from a second module',
      trees(
        { added: true },
        {
          [SMS_KIT]: smsKit("export * from './actions.ts';"),
          [ACTIONS_MODULE]: ACTIONS_DECL,
        },
      ),
    ],
    [
      'a let',
      trees(
        { added: true },
        { [SMS_KIT]: smsKit("export let ACTIONS = ['payout_account_change', 'phone_change'];") },
      ),
    ],
    [
      'the result of a call',
      trees(
        { added: true },
        {
          [SMS_KIT]: smsKit('export const ACTIONS = actions();', [
            'function actions() {',
            "  return ['payout_account_change', 'phone_change'] as const;",
            '}',
            '',
          ]),
        },
      ),
    ],
    [
      'a row that is a name',
      trees(
        { added: true },
        {
          [SMS_KIT]: smsKit("export const ACTIONS = [PAYOUT, 'phone_change'] as const;", [
            "const PAYOUT = 'payout_account_change';",
          ]),
        },
      ),
    ],
    [
      'a spread row',
      trees(
        { added: true },
        {
          [SMS_KIT]: smsKit('export const ACTIONS = [...BOUND] as const;', [
            "const BOUND = ['payout_account_change', 'phone_change'] as const;",
          ]),
        },
      ),
    ],
  ];
  for (const [name, t] of cases) refusedRows(t, cannot, name);
});

it('[CT-06zzzzzr#17] each side reads its own kit: a kit changed elsewhere keeps the rows; a kit the base does not have cannot be expanded; a row added to the head kit makes the entries not apply', () => {
  // The kit's helper changed at the head, the table the same: the rows apply.
  const helper = smsKit().replace('token?: string', 'token?: string, channel?: string');
  expect(helper).not.toBe(smsKit());
  const same = run(trees({ added: true }, { [SMS_KIT]: smsKit() }, { [SMS_KIT]: helper }));
  expect(same.problems).toEqual([]);
  expect(same.ok).toBe(true);
  // No kit at the base (only the head has it): the base's rows cannot be expanded.
  refusedRows(
    trees({ added: true }, {}, { [SMS_KIT]: smsKit() }),
    /cannot be expanded for certain/,
    'no kit at the base',
  );
  // A row added to the head's kit: the table is not the base's row by row.
  refusedRows(
    trees(
      { added: true },
      { [SMS_KIT]: smsKit() },
      {
        [SMS_KIT]: smsKit(
          "export const ACTIONS = ['payout_account_change', 'phone_change', 'withdraw'] as const;",
        ),
      },
    ),
    /does not apply/,
    'a row added at the head',
  );
});
