// CT-06zzzzzu (FU-EACH-KIT-TABLE-BIGINT; orchestrator ruling D10-2150): a same-directory kit table
// whose rows hold BigInt literals (`990n`, `0n`, `-1234n`) expands row by row, each row named as
// the same table written inline in the `.each` call names it; number and BigInt literals with `_`
// separators in the places the language allows count by their value without the `_`, their row
// text staying the source as written (kit and inline alike); a `_` anywhere else, and a row that
// is a name, a call or a spread, still cannot be expanded for certain. See ./kit.ts.
import { expect, it } from 'vitest';
import type { ModifiedComparison } from '../../../../tools/guard/lib/test-blocks.ts';
import {
  BIG,
  BIG_NAMES,
  FORMS,
  HELPER_ONLY,
  PLAIN,
  SEP,
  SEP_AMOUNT_NAMES,
  SEP_NAMES,
  SEP_VECTOR_NAMES,
  type Tables,
  type Tree,
  compareInline,
  compareKit,
  kitTree,
  rowTags,
  vectorName,
} from './kit.ts';

/** The row tag a found row's `before` / `after` ends with (compareModifiedBlocks). */
const tagOf = (text: string): string => text.slice(text.lastIndexOf('\n// .each row '));

/**
 * Every name of `names` is found and changed, the i-th on the row whose tag is `tags[i]` on both
 * sides; with `whole`, nothing else of the file differs (`outside` null). Else the reason, shown.
 */
const expanded = (
  r: ModifiedComparison,
  names: readonly string[],
  tags: readonly string[],
  label: string,
  whole = true,
): void => {
  expect(r.ok, `${label}: ${r.ok ? '' : r.reason}`).toBe(true);
  if (!r.ok) return;
  for (const [i, name] of names.entries()) {
    const b = r.blocks.find((x) => x.test === name);
    expect(b === undefined ? 'missing' : b.found ? 'found' : b.reason, `${label}: ${name}`).toBe(
      'found',
    );
    if (b?.found !== true) continue;
    expect(b.changed, `${label}: ${name}`).toBe(true);
    expect(tagOf(b.before), `${label}: ${name} (base)`).toBe(tags[i]);
    expect(tagOf(b.after), `${label}: ${name} (head)`).toBe(tags[i]);
  }
  if (whole) expect(r.outside, label).toBeNull();
};

/** Every name of `names` is not found, for a reason matching each of `why`. */
const refused = (
  r: ModifiedComparison,
  names: readonly string[],
  why: readonly RegExp[],
  label: string,
): void => {
  expect(r.ok, `${label}: ${r.ok ? '' : r.reason}`).toBe(true);
  if (!r.ok) return;
  for (const name of names) {
    const b = r.blocks.find((x) => x.test === name);
    expect(b?.found, `${label}: ${name}`).toBe(false);
    if (b === undefined || b.found) continue;
    for (const w of why) expect(b.reason, `${label}: ${name}`).toMatch(w);
  }
};

const CANNOT = /cannot be expanded for certain/;
const NOT_LITERAL = /not literal/;

/** `t` with one more VECTORS row `['bad', <value>, 1n]`. */
const withBad = (t: Tables, value: string): Tables => ({
  vectors: [...t.vectors, `['bad', ${value}, 1n]`],
  amounts: t.amounts,
});

/** The full names of withBad(SEP, <a literal printed as `printed`>), in the order of rowTags. */
const withBadNames = (printed: string): string[] => [
  ...SEP_VECTOR_NAMES,
  vectorName('bad', printed, '1n'),
  ...SEP_AMOUNT_NAMES,
];

/** `t` with VECTORS row `k` (0-based) written as `row`. */
const withRow = (t: Tables, k: number, row: string): Tables => ({
  vectors: t.vectors.map((r, i) => (i === k ? row : r)),
  amounts: t.amounts,
});

/**
 * A `_` where the language does not allow it (D10-2150 ③): the literal, a twin the language
 * allows in its place and how Vitest prints the twin.
 */
const MISPLACED: readonly (readonly [string, string, string, string])[] = [
  ['first (a name)', '_1', '1', '1'],
  ['last', '1_', '1', '1'],
  ['two in a row', '1__0', '1_0', '10'],
  ['before the point', '1_.5', '1.5', '1.5'],
  ['after the point', '1._5', '1.5', '1.5'],
  ['before the e', '1_e3', '1e3', '1000'],
  ['after the e', '1e_3', '1e3', '1000'],
  ['after the radix prefix', '0x_1F', '31', '31'],
  ['inside the radix prefix', '0_x1F', '31', '31'],
  ['before the n', '1_n', '1n', '1n'],
];

it('[CT-06zzzzzu#1] a kit table whose rows hold BigInt literals (990n, -1234n, 0n; bare, as const or annotated) expands row by row, each row with the full name and row text the same table written inline gives it', () => {
  // The control: the same rows inline in the `.each` calls (compareEachRows' reading, CT-06zzzf).
  expanded(compareInline(BIG_NAMES, BIG), BIG_NAMES, rowTags(BIG), 'inline');
  for (const [form, vectors, amounts] of FORMS) {
    expanded(
      compareKit(BIG_NAMES, kitTree(BIG, vectors, amounts)),
      BIG_NAMES,
      rowTags(BIG),
      `kit, ${form}`,
    );
  }
});

it('[CT-06zzzzzu#2] `_` separators (123_456n, 2_000_000n, -1_234n, 1_000, 1_000.5) in a kit table and inline: the full names are those of the values without the `_`, the row texts the source as written', () => {
  // Without separators (the values): inline, and in the kit.
  expanded(compareInline(SEP_NAMES, PLAIN), SEP_NAMES, rowTags(PLAIN), 'inline, without `_`');
  expanded(compareKit(SEP_NAMES, kitTree(PLAIN)), SEP_NAMES, rowTags(PLAIN), 'kit, without `_`');
  // With them: the same full names, each row's text as written (`123_456n`, not `123456n`).
  expanded(compareInline(SEP_NAMES, SEP), SEP_NAMES, rowTags(SEP), 'inline, with `_`');
  for (const [form, vectors, amounts] of FORMS) {
    expanded(
      compareKit(SEP_NAMES, kitTree(SEP, vectors, amounts)),
      SEP_NAMES,
      rowTags(SEP),
      `kit, with \`_\`, ${form}`,
    );
  }
  expect(rowTags(SEP)[0]).toBe("\n// .each row 1 of 3: ['raise', 123_456n, 2_000_000n]");
});

it('[CT-06zzzzzu#3] a row rewritten only with `_` separators (same value) is a changed row: its text is compared as written, inline and in a kit', () => {
  const sepFirst = withRow(PLAIN, 0, SEP.vectors[0] as string);
  const [first, second] = SEP_VECTOR_NAMES as [string, string];
  // Inline, the callbacks unchanged. The control: nothing changed, the declared row unchanged.
  const same = compareInline([second], PLAIN, PLAIN, false);
  expect(same.ok).toBe(true);
  if (same.ok) {
    const b = same.blocks[0];
    expect(b?.found === true ? b.changed : b?.reason, 'inline, nothing changed').toBe(false);
  }
  // Row 1 written with `_`, row 2 declared: row 1 changed and is not declared.
  refused(
    compareInline([second], PLAIN, sepFirst, false),
    [second],
    [/row 1 of the \.each \/ \.for table changed and is not declared/],
    'inline, row 1 rewritten, row 2 declared',
  );
  // Row 1 declared: found, changed, its base text without `_`, its head text with them.
  const own = compareInline([first], PLAIN, sepFirst, false);
  expect(own.ok).toBe(true);
  if (own.ok) {
    const b = own.blocks[0];
    expect(b?.found === true ? 'found' : b?.reason, 'inline, row 1 declared').toBe('found');
    if (b?.found === true) {
      expect(b.changed).toBe(true);
      expect(tagOf(b.before)).toBe(rowTags(PLAIN)[0]);
      expect(tagOf(b.after)).toBe(rowTags(sepFirst)[0]);
    }
  }
  // In the kit: the control, then the table declared differently at the head (not refused as
  // rows that cannot be expanded).
  const kitSame = compareKit([second], kitTree(PLAIN), kitTree(PLAIN), false);
  expect(kitSame.ok).toBe(true);
  if (kitSame.ok) {
    const b = kitSame.blocks[0];
    expect(b?.found === true ? b.changed : b?.reason, 'kit, nothing changed').toBe(false);
  }
  for (const name of [first, second]) {
    refused(
      compareKit([name], kitTree(PLAIN), kitTree(sepFirst), false),
      [name],
      [/declared differently|changed and is not declared/],
      `kit, ${name}`,
    );
  }
});

it('[CT-06zzzzzu#4] a `_` where the language does not allow it (first, last, twice, next to the point or the e, in a radix prefix, before the n) in a kit table: its rows still are not literal; the other table expands', () => {
  for (const [where, misplaced, twin, printed] of MISPLACED) {
    const names = withBadNames(printed);
    // The control: the twin the language allows in its place.
    expanded(
      compareKit(names, kitTree(withBad(SEP, twin))),
      names,
      rowTags(withBad(SEP, twin)),
      `kit, ${twin} in place of ${misplaced}`,
    );
    const r = compareKit(SEP_NAMES, kitTree(withBad(SEP, misplaced)));
    refused(r, SEP_VECTOR_NAMES, [CANNOT, NOT_LITERAL], `kit, \`_\` ${where}: ${misplaced}`);
    expanded(
      r,
      SEP_AMOUNT_NAMES,
      rowTags(SEP).slice(3),
      `kit, \`_\` ${where}: ${misplaced} (AMOUNTS)`,
      false,
    );
  }
});

it('[CT-06zzzzzu#5] a `_` where the language does not allow it in an inline `.each` table: its rows still cannot be expanded for certain; the other table expands', () => {
  for (const [where, misplaced, twin, printed] of MISPLACED) {
    const names = withBadNames(printed);
    expanded(
      compareInline(names, withBad(SEP, twin)),
      names,
      rowTags(withBad(SEP, twin)),
      `inline, ${twin} in place of ${misplaced}`,
    );
    const r = compareInline(SEP_NAMES, withBad(SEP, misplaced));
    refused(r, SEP_VECTOR_NAMES, [CANNOT], `inline, \`_\` ${where}: ${misplaced}`);
    expanded(
      r,
      SEP_AMOUNT_NAMES,
      rowTags(SEP).slice(3),
      `inline, \`_\` ${where}: ${misplaced} (AMOUNTS)`,
      false,
    );
  }
});

it('[CT-06zzzzzu#6] a kit table of BigInt rows with a row that is not literal (a name, a negated name, a BigInt(…) call, a whole row by name, a spread): still not literal, cannot be expanded for certain; the other table expands', () => {
  // The control: the same kit without the non-literal row.
  expanded(compareKit(SEP_NAMES, kitTree(SEP)), SEP_NAMES, rowTags(SEP), 'kit, literal rows');
  const cases: [string, Tree][] = [
    [
      'a row holding a name',
      kitTree(withBad(SEP, 'BIG_AMOUNT'), {}, {}, ['const BIG_AMOUNT = 990n;']),
    ],
    [
      'a row holding a negated name',
      kitTree(withBad(SEP, '-BIG_AMOUNT'), {}, {}, ['const BIG_AMOUNT = 990n;']),
    ],
    ['a row holding a call', kitTree(withBad(SEP, "BigInt('990')"))],
    [
      'a whole row by name',
      kitTree({ vectors: [...SEP.vectors, 'ROW'], amounts: SEP.amounts }, {}, {}, [
        "const ROW = ['row', 990n, 1n] as const;",
      ]),
    ],
    [
      'a spread row',
      kitTree(
        { vectors: [...SEP.vectors, '...MORE'], amounts: SEP.amounts },
        { asConst: true },
        {},
        ["const MORE = [['more', 990n, 1n]] as const;"],
      ),
    ],
  ];
  for (const [label, tree] of cases) {
    const r = compareKit(SEP_NAMES, tree);
    refused(r, SEP_VECTOR_NAMES, [CANNOT, NOT_LITERAL], label);
    expanded(r, SEP_AMOUNT_NAMES, rowTags(SEP).slice(3), `${label} (AMOUNTS)`, false);
  }
  // The kit's helper alone (no table): the names are not read from it.
  refused(
    compareKit(SEP_NAMES, HELPER_ONLY),
    SEP_NAMES,
    [CANNOT],
    'a kit that does not declare the tables',
  );
});
