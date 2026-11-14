// CT-06zzzzzi (D10-1662) round 2, review-claude-1 S1-2: an assertion helper called outside the
// blocks counts as an assertion call. A changed line (removed at the base or added at the head)
// that calls an identifier starting with `expect` or `assert` right before `(` —
// `expectMentions(`, `assertTable(`, `helpers.expectSchema(`, `assertOnlyReads(` … — is refused,
// naming the file and the line, in a money or attribution fixture too (rule_change with the owner
// label). Names that are not called (`expected`, `expectedRows.push(`, `asserted`) are other words:
// changing such lines passes.
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  type Repo,
  SLOW,
  assertionProblem,
  branch,
  check,
  cleanup,
  ledger,
  lineOf,
  makeRepo,
  problemsOf,
  refusal,
  support,
  supportRecord,
  trusted,
} from './kit.ts';

/** Not a money or attribution test. */
const DEVICES = 'test/spec/identity/devices/kit.ts';
/** A money or attribution test (a ledger directory). */
const CLOSING = 'test/spec/ledger/adjustments-closing/kit.ts';

// Eighteen comment lines first: every changed line is at line 19 or later.
const PAD = ['// fixture (CT-06zzzzzi round 2)', ...Array.from({ length: 17 }, () => '// padding')];

const MENTIONS = "  expectMentions(rows[0]!, { ids: ['a'], values: [expected[0], 0n] });";
const TABLE = '  await assertTable(db);';
const SCHEMA = "  await helpers.expectSchema('200', body);";
const ONLY_READS = '  assertOnlyReads();';
const EXPECTED = '  const expected = [1n, 2n];';
const EXPECTED_ROWS = "  expectedRows.push({ id: 'a', amount: 100n });";
const ASSERTED = '  const asserted = rows.length;';

/** A fixture with assertion helpers and a checker calling them outside any block. */
const kit = (calls: readonly string[]): string =>
  [
    ...PAD,
    "import { expect } from 'vitest';",
    "import * as helpers from './schema-helpers.ts';",
    '',
    'export function expectMentions(row: Row, want: Want) {',
    '  expect(row.ids).toEqual(want.ids);',
    '}',
    '',
    'export async function assertTable(db: Db) {',
    '  expect(await db.count()).toBe(0);',
    '}',
    '',
    'export function assertOnlyReads() {',
    '  expect(writes).toEqual([]);',
    '}',
    '',
    'export async function checkRows(db: Db, rows: Row[], body: unknown) {',
    ...calls,
    '  return { expectedRows, asserted };',
    '}',
    '',
  ].join('\n');

const CALLS = [
  EXPECTED,
  '  const expectedRows: Row[] = [];',
  EXPECTED_ROWS,
  ASSERTED,
  MENTIONS,
  TABLE,
  SCHEMA,
  ONLY_READS,
];
const DEVICES_BASE = kit(CALLS);
const CLOSING_MENTIONS = MENTIONS.replace("['a']", '[e.id]');
const CLOSING_BASE = kit(CALLS.map((l) => (l === MENTIONS ? CLOSING_MENTIONS : l)));

/** `base` with `line` replaced by `to` (null: removed). */
function edit(base: string, line: string, to: string | null): string {
  const lines = base.split('\n');
  const at = lines.indexOf(line);
  if (at < 0) throw new Error(`fixture: "${line}" not found`);
  if (to === null) lines.splice(at, 1);
  else lines[at] = to;
  return lines.join('\n');
}

/** `base` with `line` added right after `after`. */
function add(base: string, after: string, line: string): string {
  return edit(base, after, `${after}\n${line}`);
}

let repo: Repo;
beforeAll(() => {
  repo = makeRepo('helpers', { [DEVICES]: DEVICES_BASE, [CLOSING]: CLOSING_BASE });
});
afterAll(cleanup);

/** A branch changing `file` from `base` to `head`, with its (correct) support record. */
const supportBranch = (name: string, file: string, base: string, head: string): string =>
  branch(repo, name, { [file]: head }, [supportRecord(file, base, head)]);

it(
  '[CT-06zzzzzi#30] an assertion helper call outside the blocks (expectX, assertX, obj.expectX) removed, changed in its arguments or added is refused, naming the file and the line',
  () => {
    const dir = trusted('helpers', ledger([support(DEVICES)]));
    // [name, head, lines one of which is named]
    const cases: [string, string, number[]][] = [
      [
        'expectMentions removed',
        edit(DEVICES_BASE, MENTIONS, null),
        [lineOf(DEVICES_BASE, MENTIONS)],
      ],
      [
        'expectMentions argument changed',
        edit(DEVICES_BASE, MENTIONS, MENTIONS.replace('0n', '1n')),
        [lineOf(DEVICES_BASE, MENTIONS)],
      ],
      ['assertTable removed', edit(DEVICES_BASE, TABLE, null), [lineOf(DEVICES_BASE, TABLE)]],
      [
        'assertTable argument changed',
        edit(DEVICES_BASE, TABLE, '  await assertTable(db.replica);'),
        [lineOf(DEVICES_BASE, TABLE)],
      ],
      [
        'helpers.expectSchema removed',
        edit(DEVICES_BASE, SCHEMA, null),
        [lineOf(DEVICES_BASE, SCHEMA)],
      ],
      [
        'helpers.expectSchema argument changed',
        edit(DEVICES_BASE, SCHEMA, SCHEMA.replace("'200'", "'201'")),
        [lineOf(DEVICES_BASE, SCHEMA)],
      ],
      [
        'assertOnlyReads removed',
        edit(DEVICES_BASE, ONLY_READS, null),
        [lineOf(DEVICES_BASE, ONLY_READS)],
      ],
    ];
    const added = add(DEVICES_BASE, ONLY_READS, '  await helpers.assertNoRows(db);');
    cases.push(['helpers.assertNoRows added', added, [lineOf(added, 'assertNoRows')]]);
    cases.forEach(([name, head, lines], i) => {
      expect(head, name).not.toBe(DEVICES_BASE);
      expect(Math.min(...lines), name).toBeGreaterThan(18);
      const report = check(repo, supportBranch(`helpers-${i}`, DEVICES, DEVICES_BASE, head), dir);
      expect(report.ok, name).toBe(false);
      expect(
        assertionProblem(report, DEVICES, lines),
        `${name}\n${problemsOf(report)}`,
      ).toBeDefined();
    });
  },
  SLOW,
);

it(
  '[CT-06zzzzzi#31] in a money fixture (test/spec/ledger/…/kit.ts, rule_change with the owner label) an assertion helper call removed or changed outside the blocks is refused',
  () => {
    const text = ledger([support(CLOSING)]);
    expect(refusal(text)).toBe('');
    const dir = trusted('helpers-money', text);
    const cases: [string, string, number[]][] = [
      [
        'expectMentions expected amount changed',
        edit(CLOSING_BASE, CLOSING_MENTIONS, CLOSING_MENTIONS.replace('0n', '1n')),
        [lineOf(CLOSING_BASE, CLOSING_MENTIONS)],
      ],
      ['assertTable removed', edit(CLOSING_BASE, TABLE, null), [lineOf(CLOSING_BASE, TABLE)]],
    ];
    cases.forEach(([name, head, lines], i) => {
      const report = check(
        repo,
        supportBranch(`helpers-money-${i}`, CLOSING, CLOSING_BASE, head),
        dir,
        'owner',
      );
      expect(report.ok, name).toBe(false);
      expect(report.approval_wanted, name).toBe(true);
      expect(
        assertionProblem(report, CLOSING, lines),
        `${name}\n${problemsOf(report)}`,
      ).toBeDefined();
    });
  },
  SLOW,
);

it(
  '[CT-06zzzzzi#32] lines naming expected / expectedRows.push( / asserted without calling an expect… or assert… identifier may change outside the blocks',
  () => {
    const dir = trusted('helpers-plain', ledger([support(DEVICES)]));
    const changes: [string, string][] = [
      [EXPECTED, '  const expected = [1n, 3n];'],
      [EXPECTED_ROWS, "  expectedRows.push({ id: 'a', amount: 200n });"],
      [ASSERTED, '  const asserted = rows.length + 1;'],
    ];
    changes.forEach(([from, to], i) => {
      const head = edit(DEVICES_BASE, from, to);
      expect(head).not.toBe(DEVICES_BASE);
      const report = check(repo, supportBranch(`plain-${i}`, DEVICES, DEVICES_BASE, head), dir);
      expect(report.problems, to).toEqual([]);
    });
    // All three at once, and in the money fixture with the owner label.
    const all = changes.reduce((text, [from, to]) => edit(text, from, to), DEVICES_BASE);
    expect(
      check(repo, supportBranch('plain-all', DEVICES, DEVICES_BASE, all), dir).problems,
    ).toEqual([]);
    const money = trusted('helpers-plain-money', ledger([support(CLOSING)]));
    const closing = changes.reduce((text, [from, to]) => edit(text, from, to), CLOSING_BASE);
    const report = check(repo, supportBranch('plain-money', CLOSING, CLOSING_BASE, closing), money);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  },
  SLOW,
);
