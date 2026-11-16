// CT-06zzzzzi (D10-1662) round 3, orchestrator rulings D10-1689 (whitelist A, after review-claude-2
// S1: assertion helpers whose names do not start with expect / assert — `await conforms(sent);`,
// `answer(sent, 0)`, `denied()`'s `{ reason: 'admin_permission_denied' }` — removed or changed
// outside the blocks passed the round 2 blacklist) and D10-1775 (after spec-test review r3). A file
// with a support entry is judged from the merge base to the head, token by token outside its it /
// test blocks:
// 1. the base tokens are an ordered subsequence of the head's: a token removed, changed (a number,
//    a string, an identifier, an operator), moved or swapped is refused, naming the file and a
//    line (merge-base or head); code wrapped into a comment or a template counts as removed;
// 2. the inserted tokens hold no control flow (if else for while do switch case default try catch
//    finally return throw break continue, ? :, && || ?? and &&= ||= ??=, ?.), no comma expression,
//    no `=>` / `function` / `class`, no test modifier (skip, only, todo, failing, skipIf, runIf),
//    no vi mock / doMock / stubGlobal and no assertion call (the round 1 / 2 judgment: expect(
//    expectTypeOf( assert( assert.<name>( .to<Upper…>( .rejects .resolves, a called identifier
//    starting with expect / assert); they declare no name (const, import binding, parameter) the
//    base file already holds; and none stands in a statement holding an assertion call (before,
//    inside or around it);
// 3. comments are not compared: removed, changed or inserted, they pass.
// Passing insertions: import lines and specifiers, call arguments, properties and spreads appended
// to object literals, optional parameters and members (`summary?: string`), new const
// declarations, await, plain calls, `export { … }` at the end. Blocks keep needing their own block
// entries (#21, #28); files without a support entry are judged as before (#22).
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  ADMIN,
  ADMIN_BASE,
  ADMIN_KIT,
  type Repo,
  SLOW,
  branch,
  branchVia,
  check,
  cleanup,
  insertAfter,
  ledger,
  lineAt,
  lineOf,
  lineProblem,
  makeRepo,
  problemsOf,
  refusal,
  replaceLine,
  replaceOnce,
  support,
  supportRecord,
  trusted,
} from './kit.ts';

let repo: Repo;
let dir: string;
beforeAll(() => {
  repo = makeRepo('whitelist', { [ADMIN_KIT]: ADMIN_BASE });
  const text = ledger([support(ADMIN_KIT)]);
  // A money fixture: rule_change with br is the one reason it accepts.
  const refused = refusal(text);
  if (refused !== '') throw new Error(`fixture: the ledger is refused: ${refused}`);
  dir = trusted('whitelist', text);
});
afterAll(cleanup);

/** [name, the head, lines (merge base or head) one of which the refusal names] */
type Case = [name: string, head: string, lines: number[]];
type Edit = [name: string, edit: (text: string) => string];

/** A branch changing ADMIN_KIT to `head` (base → head in one commit), with its correct record. */
const adminBranch = (name: string, head: string): string =>
  branch(repo, name, { [ADMIN_KIT]: head }, [supportRecord(ADMIN_KIT, ADMIN_BASE, head)]);

const at = (line: string): number => lineOf(ADMIN_BASE, line);
/** The number of the line of ADMIN_BASE that is exactly `line`. */
const n = (line: string): number => lineAt(ADMIN_BASE, line);
/** For a line inserted right after the base line `line`: that line or the inserted one. */
const after = (line: string): number[] => [n(line), n(line) + 1];

/** Each case on its own branch, with its correct record: refused, naming ADMIN_KIT and a line. */
function refusedEach(prefix: string, cases: readonly Case[]): void {
  cases.forEach(([name, head, lines], i) => {
    expect(head, name).not.toBe(ADMIN_BASE);
    expect(Math.min(...lines), name).toBeGreaterThan(18);
    const report = check(repo, adminBranch(`${prefix}-${i}`, head), dir);
    const why = `${name}\n${problemsOf(report)}`;
    expect(report.ok, why).toBe(false);
    expect(report.approval_wanted, name).toBe(true);
    expect(lineProblem(report, ADMIN_KIT, lines), why).toBeDefined();
  });
}

// The insertions B1-02zzzb needs (the step-up summary), as edits that compose.
const SUMMARY_IMPORT = "import { stepUpSummary } from './summary.ts';";
const COMMENT_LINE = '// step-up summary (B1-02zzzb): assertions (answer, conforms) unchanged.';
/** ADMIN.executed with answer(sent, 0) changed to answer(sent, 1). */
const ANSWER_ONE = '  const body = await answer(sent, 1);';
const addImport = (t: string): string => insertAfter(t, ADMIN.send, SUMMARY_IMPORT);
const addComment = (t: string): string => insertAfter(t, ADMIN.send, COMMENT_LINE);
const addProperty = (t: string): string =>
  replaceOnce(
    t,
    'body.amount + body.fee }',
    'body.amount + body.fee, summary: stepUpSummary(sent) }',
  );

const INSERTIONS: Edit[] = [
  ['an import line', addImport],
  [
    'a specifier in an existing import',
    (t) =>
      replaceOnce(t, '{ contractPaths, validate }', '{ contractPaths, operationOf, validate }'),
  ],
  [
    'an argument in an existing call',
    (t) =>
      replaceOnce(
        t,
        "'/admin/adjustments', body);",
        "'/admin/adjustments', body, stepUpSummary(body));",
      ),
  ],
  ['a property appended to an object literal', addProperty],
  [
    'a spread appended to an object literal',
    (t) => replaceOnce(t, '{ id: sent.path }', '{ id: sent.path, ...extra }'),
  ],
  [
    'an optional parameter (, summary?: string)',
    (t) =>
      replaceLine(
        t,
        ADMIN.stepUpOf,
        'export function stepUpOf(sent: AdminSent, summary?: string) {',
      ),
  ],
  ['an optional member of an interface', (t) => insertAfter(t, ADMIN.path, '  summary?: string;')],
  [
    'an optional member of a type literal',
    (t) => replaceOnce(t, 'fee: number }', 'fee: number; summary?: string }'),
  ],
  [
    'a new const holding await and a plain call',
    (t) =>
      insertAfter(t, ADMIN.adjust, '  const echoed = await Promise.resolve(stepUpSummary(body));'),
  ],
  ['a plain call statement', (t) => insertAfter(t, ADMIN.raw, '  stepUpSummary(sent);')],
  ['export { … } appended at the end of the file', (t) => `${t}export { stepUpSummary };\n`],
];

it(
  '[CT-06zzzzzi#33] tokens only inserted outside the blocks pass in a money fixture with the owner label: an import, a specifier, an argument, a property or a spread appended to an object literal, an optional parameter or member (summary?: string), a new const with await, a plain call, export { … } at the end; an optional chain or an arrow function inserted is refused (D10-1775)',
  () => {
    INSERTIONS.forEach(([name, edit], i) => {
      const head = edit(ADMIN_BASE);
      expect(head, name).not.toBe(ADMIN_BASE);
      const report = check(repo, adminBranch(`insert-${i}`, head), dir);
      expect(report.problems, name).toEqual([]);
    });
    // All at once, with a comment saying what changed (its "assertions (" is a comment's).
    const all = INSERTIONS.reduce((text, [, edit]) => edit(text), addComment(ADMIN_BASE));
    const report = check(repo, adminBranch('insert-all', all), dir);
    expect(report.problems).toEqual([]);
    expect(report).toMatchObject({ ok: true, approval_wanted: true });
    // Passing in round 3, refused since D10-1775: `?.` and `=>` inserted.
    refusedEach('insert-reversed', [
      [
        'an optional chain inserted into an appended property',
        replaceOnce(
          ADMIN_BASE,
          'body.amount + body.fee }',
          'body.amount + body.fee, summary: body?.summary }',
        ),
        [n(ADMIN.total)],
      ],
      [
        'an arrow function in a new const',
        insertAfter(ADMIN_BASE, ADMIN.adjust, '  const summaryOf = (b: AdjustBody) => b.amount;'),
        after(ADMIN.adjust),
      ],
    ]);
  },
  2 * SLOW,
);

it(
  '[CT-06zzzzzi#34] an original token outside the blocks removed or changed is refused in a money fixture with the owner label, naming the file and the line: await conforms(sent); removed (review-claude-2 S1), answer(sent, 0) → 1, the reason string, a code, an operator, a call name',
  () => {
    const conforms = at(ADMIN.conforms);
    const returned = at(ADMIN.returnBody);
    const denied = at(ADMIN.denied);
    const cases: Case[] = [
      [
        'await conforms(sent); removed',
        replaceLine(ADMIN_BASE, ADMIN.conforms, null),
        [conforms - 1, conforms],
      ],
      [
        'return body; removed',
        replaceLine(ADMIN_BASE, ADMIN.returnBody, null),
        [returned - 1, returned],
      ],
      [
        'answer(sent, 0) → answer(sent, 1)',
        replaceLine(ADMIN_BASE, ADMIN.executed, ANSWER_ONE),
        [at(ADMIN.executed)],
      ],
      [
        "{ reason: 'admin_permission_denied' } → another string",
        replaceOnce(ADMIN_BASE, "'admin_permission_denied'", "'admin_permission_revoked'"),
        [denied],
      ],
      [
        'answer(sent, 10403, …) → 10404',
        replaceOnce(ADMIN_BASE, 'answer(sent, 10403,', 'answer(sent, 10404,'),
        [denied],
      ],
      [
        'body.amount + body.fee → body.amount - body.fee',
        replaceOnce(ADMIN_BASE, 'body.amount + body.fee', 'body.amount - body.fee'),
        [at(ADMIN.total)],
      ],
      [
        'conforms(sent) → validate(sent)',
        replaceLine(ADMIN_BASE, ADMIN.conforms, '  await validate(sent);'),
        [conforms],
      ],
    ];
    cases.forEach(([name, head, lines], i) => {
      expect(head, name).not.toBe(ADMIN_BASE);
      expect(Math.min(...lines), name).toBeGreaterThan(18);
      const report = check(repo, adminBranch(`changed-${i}`, head), dir);
      const why = `${name}\n${problemsOf(report)}`;
      expect(report.ok, name).toBe(false);
      expect(report.approval_wanted, name).toBe(true);
      expect(lineProblem(report, ADMIN_KIT, lines), why).toBeDefined();
    });
  },
  SLOW,
);

it(
  '[CT-06zzzzzi#35] inserted tokens outside the blocks holding control flow (if else for while do switch case try catch finally return throw break continue, ? :, && || ??, &&= ||= ??=) or an assertion call, or inserted inside an existing assertion, are refused, naming the file and the line',
  () => {
    const raw = at(ADMIN.raw);
    const part = at(ADMIN.part);
    // Inserted after the last statement of stepUpOf (only its closing brace follows).
    const afterRaw: [name: string, line: string][] = [
      ['if', '  if (raw === undefined) void sent;'],
      ['return', '  return raw;'],
      ['throw', "  throw new Error('no step-up');"],
      ['for', '  for (const c of String(raw)) void c;'],
      ['while', '  while (String(raw).length > 9) void raw;'],
      ['do … while', '  do void raw; while (raw === undefined);'],
      ['switch / case', "  switch (raw) { case 'sms': void raw; }"],
      ['try / catch', '  try { void String(raw); } catch {}'],
      ['try / finally', '  try { void raw; } finally { void sent; }'],
      ['? : ternary', "  const shown = raw ? raw : 'none';"],
      ['&&', '  void (raw && sent.headers);'],
      ['||', "  const either = raw || 'none';"],
      ['??', "  const known = raw ?? 'none';"],
      ['&&=', "  sent.note &&= 'seen';"],
      ['||=', "  sent.note ||= 'seen';"],
      ['??=', "  sent.note ??= 'seen';"],
      ['expect(…).toBe(…)', "  expect(raw).toBe('sms');"],
      ['an expect… helper call', '  expectRows(raw);'],
      ['assert.ok(…)', '  assert.ok(raw);'],
      ['.rejects', '  void sent.rejects;'],
    ];
    // Inserted inside the loop of stepUpOf, after its if.
    const afterPart: [name: string, line: string][] = [
      ['else', '    else void part;'],
      ['break', '    break;'],
      ['continue', '    continue;'],
    ];
    const cases: Case[] = [
      ...afterRaw.map(([name, line]): Case => [
        name,
        insertAfter(ADMIN_BASE, ADMIN.raw, line),
        [raw, raw + 1],
      ]),
      ...afterPart.map(([name, line]): Case => [
        name,
        insertAfter(ADMIN_BASE, ADMIN.part, line),
        [part, part + 1],
      ]),
      // Inserted inside an existing assertion: the assertion changes.
      [
        '.not inserted into expect(…).toBe(…)',
        replaceLine(ADMIN_BASE, ADMIN.code, '  expect(body.code).not.toBe(code);'),
        [at(ADMIN.code)],
      ],
      [
        'an operand inserted into the expected value',
        replaceLine(ADMIN_BASE, ADMIN.code, '  expect(body.code).toBe(code + 1);'),
        [at(ADMIN.code)],
      ],
      [
        'an argument inserted into an assertion helper call',
        replaceLine(ADMIN_BASE, ADMIN.adjustment, '  expectAdjustment(body.data, true);'),
        [at(ADMIN.adjustment)],
      ],
    ];
    cases.forEach(([name, head, lines], i) => {
      expect(Math.min(...lines), name).toBeGreaterThan(18);
      const report = check(repo, adminBranch(`inserted-${i}`, head), dir);
      const why = `${name}\n${problemsOf(report)}`;
      expect(report.ok, name).toBe(false);
      expect(lineProblem(report, ADMIN_KIT, lines), why).toBeDefined();
    });
  },
  2 * SLOW,
);

it(
  '[CT-06zzzzzi#36] comments outside the blocks are not compared: removed, rewritten or inserted (holding assertions (, expect(, assert.ok( or if … return) they pass, also inside an assertion',
  () => {
    const comments: Edit[] = [
      [
        'a line comment holding "assertions (" rewritten',
        (t) =>
          replaceLine(
            t,
            ADMIN.plan,
            '// assertions (status, code, data, schema) live in answer() and conforms().',
          ),
      ],
      ['a line comment holding "expect(" removed', (t) => replaceLine(t, ADMIN.order, null)],
      [
        'a doc comment rewritten',
        (t) => replaceLine(t, ADMIN.answerDoc, '/** Status, code (expect(…)), then schema. */'),
      ],
      [
        'a line comment inserted',
        (t) => insertAfter(t, ADMIN.raw, '  // expect(raw), assertions (if any): elsewhere'),
      ],
      [
        'a block comment inserted between tokens',
        (t) => replaceOnce(t, 'const raw = sent', 'const raw = /* assert.ok(raw) */ sent'),
      ],
      [
        'a block comment inserted inside an assertion',
        (t) => replaceLine(t, ADMIN.code, '  expect(body.code /* the code */).toBe(code);'),
      ],
      [
        'a trailing comment added to a code line',
        (t) => replaceLine(t, ADMIN.conforms, '  await conforms(sent); // if (…) return;'),
      ],
    ];
    comments.forEach(([name, edit], i) => {
      const head = edit(ADMIN_BASE);
      expect(head, name).not.toBe(ADMIN_BASE);
      const report = check(repo, adminBranch(`comment-${i}`, head), dir);
      expect(report.problems, name).toEqual([]);
    });
    const all = comments.reduce((text, [, edit]) => edit(text), ADMIN_BASE);
    const report = check(repo, adminBranch('comment-all', all), dir);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  },
  SLOW,
);

it(
  '[CT-06zzzzzi#37] merge base → head when the change is in the rule-test commit (spec_commit after the base): a removed or changed token or inserted control flow there is refused, naming the file and the line; pure insertions there and after it pass',
  () => {
    const conforms = at(ADMIN.conforms);
    const raw = at(ADMIN.raw);
    const removed = replaceLine(ADMIN_BASE, ADMIN.conforms, null);
    const answered = replaceLine(ADMIN_BASE, ADMIN.executed, ANSWER_ONE);
    const branched = insertAfter(ADMIN_BASE, ADMIN.raw, '  if (raw === undefined) void sent;');
    // [name, the file at the rule-test commit, the file at the head, lines one of which is named]
    const cases: [name: string, spec: string, head: string, lines: number[]][] = [
      [
        'await conforms(sent); removed in the rule-test commit, a pure insertion below it after',
        removed,
        insertAfter(removed, ADMIN.raw, '  const echoed = String(raw);'),
        [conforms - 1, conforms],
      ],
      [
        'answer(sent, 0) → answer(sent, 1) in the rule-test commit',
        answered,
        answered,
        [at(ADMIN.executed)],
      ],
      ['an if inserted in the rule-test commit', branched, branched, [raw, raw + 1]],
    ];
    cases.forEach(([name, specText, headText, lines], i) => {
      const later = headText === specText ? {} : { [ADMIN_KIT]: headText };
      const records = [supportRecord(ADMIN_KIT, ADMIN_BASE, headText)];
      const via = branchVia(repo, `spec-${i}`, { [ADMIN_KIT]: specText }, later, records);
      expect(via.spec, name).not.toBe(repo.base);
      const report = check(repo, via.head, dir);
      const why = `${name}\n${problemsOf(report)}`;
      expect(report.ok, name).toBe(false);
      expect(lineProblem(report, ADMIN_KIT, lines), why).toBeDefined();
    });
    // Pure insertions in the rule-test commit (a comment holding "assertions (" too) and after it.
    const specText = addComment(addImport(ADMIN_BASE));
    const headText = addProperty(specText);
    const records = [supportRecord(ADMIN_KIT, ADMIN_BASE, headText)];
    const ok = branchVia(
      repo,
      'spec-ok',
      { [ADMIN_KIT]: specText },
      { [ADMIN_KIT]: headText },
      records,
    );
    expect(ok.spec).not.toBe(repo.base);
    const report = check(repo, ok.head, dir);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  },
  SLOW,
);

// ---------------------------------------------------------------------------------------------
// D10-1775 (spec-test review r3, approvals 94): each class pinned as refused.

/** The characters of `text`, sorted: equal for two texts holding the same tokens in any order. */
const chars = (text: string): string => [...text].sort().join('');

it(
  '[CT-06zzzzzi#38] the base tokens must stay an ordered subsequence of the head’s: await conforms(sent); moved after return body; or before the code assertion, the two arguments of answer(sent, 10403, …) swapped, the operands of body.amount + body.fee swapped — no token added or removed, each refused, naming the file and the line',
  () => {
    const conforms = n(ADMIN.conforms);
    const code = n(ADMIN.code);
    const without = replaceLine(ADMIN_BASE, ADMIN.conforms, null);
    const cases: Case[] = [
      [
        'await conforms(sent); moved after return body;',
        insertAfter(without, ADMIN.returnBody, ADMIN.conforms),
        [conforms, conforms + 1],
      ],
      [
        'await conforms(sent); moved before the code assertion',
        replaceLine(without, ADMIN.code, `${ADMIN.conforms}\n${ADMIN.code}`),
        [code, code + 1],
      ],
      [
        'answer(sent, 10403, …) → answer(10403, sent, …)',
        replaceOnce(ADMIN_BASE, 'answer(sent, 10403,', 'answer(10403, sent,'),
        [n(ADMIN.denied)],
      ],
      [
        'body.amount + body.fee → body.fee + body.amount',
        replaceOnce(ADMIN_BASE, 'body.amount + body.fee', 'body.fee + body.amount'),
        [n(ADMIN.total)],
      ],
    ];
    for (const [name, head] of cases) expect(chars(head), name).toBe(chars(ADMIN_BASE));
    refusedEach('order', cases);
  },
  SLOW,
);

it(
  '[CT-06zzzzzi#39] inserted alone into existing control flow, each is refused, naming the file and the line: catch {} between an existing try and its finally, finally {} after an existing try / catch, case and default in an existing switch, do before the statement ahead of an existing while, else {} after an existing if, throw, break, continue',
  () => {
    const finallyAt = n(ADMIN.finally);
    refusedEach('flow', [
      [
        'catch {} between an existing try and its finally',
        replaceLine(ADMIN_BASE, ADMIN.finally, '  } catch {\n  } finally {'),
        [finallyAt, finallyAt + 1],
      ],
      [
        'finally {} after an existing try / catch',
        replaceOnce(ADMIN_BASE, `${ADMIN.catchBody}\n  }`, `${ADMIN.catchBody}\n  } finally {}`),
        [n(ADMIN.catchBody) + 1],
      ],
      [
        "case 'x': in an existing switch",
        insertAfter(ADMIN_BASE, ADMIN.caseBody, "    case 'x':"),
        after(ADMIN.caseBody),
      ],
      [
        'default: in an existing switch',
        insertAfter(ADMIN_BASE, ADMIN.caseBody, '    default:'),
        after(ADMIN.caseBody),
      ],
      [
        'do before an existing statement (do … while with the existing while)',
        replaceLine(ADMIN_BASE, ADMIN.beforeWhile, '  do void left;'),
        [n(ADMIN.beforeWhile)],
      ],
      [
        'else {} after an existing if',
        replaceOnce(ADMIN_BASE, `${ADMIN.ifBody}\n  }\n}`, `${ADMIN.ifBody}\n  } else {}\n}`),
        [n(ADMIN.ifBody) + 1],
      ],
      [
        'throw',
        insertAfter(ADMIN_BASE, ADMIN.left, "  throw new Error('stop');"),
        after(ADMIN.left),
      ],
      [
        'break in an existing while',
        insertAfter(ADMIN_BASE, ADMIN.loopBody, '    break;'),
        after(ADMIN.loopBody),
      ],
      [
        'continue in an existing while',
        insertAfter(ADMIN_BASE, ADMIN.loopBody, '    continue;'),
        after(ADMIN.loopBody),
      ],
      [
        'break in an existing switch',
        insertAfter(ADMIN_BASE, ADMIN.caseBody, '      break;'),
        after(ADMIN.caseBody),
      ],
    ]);
  },
  2 * SLOW,
);

it(
  '[CT-06zzzzzi#40] short circuits, optional chains and comma expressions inserted are refused, naming the file and the line: && || ?? ?. (also ?.() ), foo(x) → foo((void 0, x)), a, before a statement or a callee',
  () => {
    const before = n(ADMIN.beforeWhile);
    refusedEach('short', [
      ['&&', replaceLine(ADMIN_BASE, ADMIN.beforeWhile, '  void left && sent;'), [before]],
      ['||', replaceLine(ADMIN_BASE, ADMIN.beforeWhile, '  void left || sent;'), [before]],
      ['??', replaceLine(ADMIN_BASE, ADMIN.beforeWhile, '  void left ?? sent;'), [before]],
      ['?.', replaceLine(ADMIN_BASE, ADMIN.beforeWhile, '  void left?.valueOf;'), [before]],
      [
        '?.() before an existing call',
        replaceLine(ADMIN_BASE, ADMIN.json, '  const body = sent.json?.();'),
        [n(ADMIN.json)],
      ],
      [
        'foo(x) → foo((void 0, x))',
        replaceLine(
          ADMIN_BASE,
          ADMIN.settlePost,
          "    await send(app, 'POST', '/admin/settle', (void 0, sent.json()));",
        ),
        [n(ADMIN.settlePost)],
      ],
      [
        'a, before an existing statement',
        replaceLine(ADMIN_BASE, ADMIN.beforeWhile, '  void 0, void left;'),
        [before],
      ],
      [
        'a, before an existing callee',
        replaceLine(ADMIN_BASE, ADMIN.conforms, '  await (void 0, conforms)(sent);'),
        [n(ADMIN.conforms)],
      ],
    ]);
  },
  SLOW,
);

it(
  '[CT-06zzzzzi#41] => / function / class inserted are refused, naming the file and the line: an arrow function (also async, also as an argument), a function expression or declaration, a class expression or declaration',
  () => {
    refusedEach('function', [
      [
        'an arrow function in a new const',
        insertAfter(ADMIN_BASE, ADMIN.raw, '  const pick = (s: AdminSent) => s.path;'),
        after(ADMIN.raw),
      ],
      [
        'an async arrow function',
        insertAfter(ADMIN_BASE, ADMIN.raw, '  const later = async () => raw;'),
        after(ADMIN.raw),
      ],
      [
        'an arrow function as an inserted argument',
        replaceOnce(
          ADMIN_BASE,
          "'/admin/adjustments', body);",
          "'/admin/adjustments', body, () => body);",
        ),
        [n(ADMIN.post)],
      ],
      [
        'a function expression',
        insertAfter(ADMIN_BASE, ADMIN.raw, '  const named = function () { void raw; };'),
        after(ADMIN.raw),
      ],
      [
        'a function declaration',
        insertAfter(ADMIN_BASE, ADMIN.send, 'function pick(s: AdminSent) {\n  void s;\n}'),
        after(ADMIN.send),
      ],
      [
        'a class declaration',
        insertAfter(ADMIN_BASE, ADMIN.send, 'class Summary {}'),
        after(ADMIN.send),
      ],
      [
        'a class expression',
        insertAfter(ADMIN_BASE, ADMIN.raw, '  const Shape = class {};'),
        after(ADMIN.raw),
      ],
    ]);
  },
  SLOW,
);

it(
  '[CT-06zzzzzi#42] an inserted declaration, import binding or parameter named like an identifier the base file holds is refused, naming the file and the line: const body, let conforms, import { code }, import { … as answer }, a parameter body / raw, a destructured left',
  () => {
    refusedEach('shadow', [
      [
        'a const named body',
        insertAfter(ADMIN_BASE, ADMIN.raw, '  const body = String(raw);'),
        after(ADMIN.raw),
      ],
      [
        'a let named conforms',
        insertAfter(ADMIN_BASE, ADMIN.raw, '  let conforms = raw;'),
        after(ADMIN.raw),
      ],
      [
        'an import binding named code',
        insertAfter(ADMIN_BASE, ADMIN.send, "import { code } from './codes.ts';"),
        after(ADMIN.send),
      ],
      [
        'an import alias named answer',
        insertAfter(
          ADMIN_BASE,
          ADMIN.send,
          "import { stepUpSummary as answer } from './summary.ts';",
        ),
        after(ADMIN.send),
      ],
      [
        'a parameter named body',
        replaceLine(
          ADMIN_BASE,
          ADMIN.stepUpOf,
          'export function stepUpOf(sent: AdminSent, body?: AdjustBody) {',
        ),
        [n(ADMIN.stepUpOf)],
      ],
      [
        'a parameter named raw',
        replaceLine(
          ADMIN_BASE,
          ADMIN.settle,
          'export async function settle(app: App, sent: AdminSent, raw?: string) {',
        ),
        [n(ADMIN.settle)],
      ],
      [
        'a destructured const named left',
        insertAfter(ADMIN_BASE, ADMIN.raw, '  const { left } = sent.json();'),
        after(ADMIN.raw),
      ],
    ]);
  },
  SLOW,
);

it(
  '[CT-06zzzzzi#43] test modifiers and vi mock / doMock / stubGlobal inserted are refused, naming the file and the line: skip, only, todo, failing, skipIf, runIf',
  () => {
    const modifiers: [name: string, line: string][] = [
      ['skip', '  void it.skip;'],
      ['only', '  void it.only;'],
      ['todo', '  void it.todo;'],
      ['failing', '  void it.failing;'],
      ['skipIf', '  void it.skipIf;'],
      ['runIf', '  void it.runIf;'],
    ];
    const mocks: [name: string, line: string][] = [
      ['vi mock', "vi.mock('./http.ts');"],
      ['vi doMock', "vi.doMock('./http.ts');"],
      ['vi stubGlobal', "vi.stubGlobal('fetch', send);"],
    ];
    refusedEach('modifier', [
      ...modifiers.map(([name, line]): Case => [
        name,
        insertAfter(ADMIN_BASE, ADMIN.raw, line),
        after(ADMIN.raw),
      ]),
      ...mocks.map(([name, line]): Case => [
        name,
        insertAfter(ADMIN_BASE, ADMIN.send, line),
        after(ADMIN.send),
      ]),
    ]);
  },
  2 * SLOW,
);

it(
  '[CT-06zzzzzi#44] existing code wrapped into a comment, a template or a string counts as removed and is refused, naming the file and the line: /* */ on the line or on lines of their own, //, backticks on the line or on lines of their own, quotes',
  () => {
    const conforms = n(ADMIN.conforms);
    const returned = n(ADMIN.returnBody);
    refusedEach('wrapped', [
      [
        '/* */ around await conforms(sent); on its line',
        replaceLine(ADMIN_BASE, ADMIN.conforms, '  /* await conforms(sent); */'),
        [conforms],
      ],
      [
        '/* and */ on lines of their own around it',
        replaceLine(ADMIN_BASE, ADMIN.conforms, '  /*\n  await conforms(sent);\n  */'),
        [conforms, conforms + 1, conforms + 2],
      ],
      [
        '// before it',
        replaceLine(ADMIN_BASE, ADMIN.conforms, '  // await conforms(sent);'),
        [conforms],
      ],
      [
        'backticks around it on its line',
        replaceLine(ADMIN_BASE, ADMIN.conforms, '  void `await conforms(sent);`;'),
        [conforms],
      ],
      [
        'backticks on lines of their own around return body;',
        replaceLine(ADMIN_BASE, ADMIN.returnBody, '  void `\n  return body;\n  `;'),
        [returned, returned + 1, returned + 2],
      ],
      [
        'quotes around it',
        replaceLine(ADMIN_BASE, ADMIN.conforms, "  void 'await conforms(sent);';"),
        [conforms],
      ],
    ]);
  },
  SLOW,
);

it(
  '[CT-06zzzzzi#45] no token is inserted into a statement holding an assertion call, before, inside or around it, also on lines of their own: void / await before expect(…), .not or a message argument inside, an operand in the expected value, an argument to a call inside, an argument to expectAdjustment(…), a call wrapped around — each refused, naming the file and the line',
  () => {
    const validate = n(ADMIN.validate);
    const open = n(ADMIN.adjustOpen);
    const status = n(ADMIN.status);
    const wrapped = replaceLine(
      replaceLine(ADMIN_BASE, ADMIN.adjustOpen, `  ignore(\n${ADMIN.adjustOpen}`),
      ADMIN.adjustClose,
      '  ),\n  );',
    );
    refusedEach('assertion', [
      // On lines of their own: the assertion lines themselves stay as they were.
      [
        '.not on a line of its own inside expect(…) / .toBe(…)',
        insertAfter(ADMIN_BASE, ADMIN.validate, '    .not'),
        after(ADMIN.validate),
      ],
      [
        'an argument on a line of its own inside expectAdjustment(…)',
        insertAfter(ADMIN_BASE, ADMIN.adjustArg, '    true,'),
        after(ADMIN.adjustArg),
      ],
      [
        'void on a line of its own before expect(…)',
        replaceLine(ADMIN_BASE, ADMIN.validate, `  void\n${ADMIN.validate}`),
        [validate, validate + 1],
      ],
      [
        'a call wrapped around expectAdjustment(…) on lines of their own',
        wrapped,
        [open, open + 1, open + 3],
      ],
      // On the assertion's line.
      [
        'await before expect(…)',
        replaceLine(ADMIN_BASE, ADMIN.status, `  await ${ADMIN.status.trim()}`),
        [status],
      ],
      [
        'a message argument inside expect(…)',
        replaceLine(
          ADMIN_BASE,
          ADMIN.status,
          "  expect(sent.statusCode, 'status').toBe(HTTP_STATUS[code]);",
        ),
        [status],
      ],
      [
        '.not inside expect(…).toBe(…)',
        replaceLine(
          ADMIN_BASE,
          ADMIN.status,
          '  expect(sent.statusCode).not.toBe(HTTP_STATUS[code]);',
        ),
        [status],
      ],
      [
        'an operand in the expected value',
        replaceLine(
          ADMIN_BASE,
          ADMIN.status,
          '  expect(sent.statusCode).toBe(HTTP_STATUS[code + 0]);',
        ),
        [status],
      ],
      [
        'an argument to a plain call inside expect(…)',
        replaceOnce(
          ADMIN_BASE,
          'validate(schema, sent.json()))',
          'validate(schema, sent.json(), true))',
        ),
        [validate],
      ],
      [
        'a call wrapped around expectAdjustment(…) on its line',
        replaceLine(
          ADMIN_BASE,
          ADMIN.adjustment,
          '  void Promise.resolve(expectAdjustment(body.data));',
        ),
        [n(ADMIN.adjustment)],
      ],
    ]);
  },
  2 * SLOW,
);

/** ADMIN_KIT moved within its directory. */
const RENAMED = 'test/spec/ledger/admin-adjustments/kit-v2.ts';

it(
  '[CT-06zzzzzi#46] a support file with a support entry removed or renamed is refused, naming the file',
  () => {
    const removed = branch(
      repo,
      'removed',
      {
        [ADMIN_KIT]: null,
        'test/spec/ledger/admin-adjustments/placeholder.ts': '// keeps test/ in the tree\n',
      },
      [supportRecord(ADMIN_KIT, ADMIN_BASE, '')],
    );
    const r = check(repo, removed, dir);
    expect(r.ok).toBe(false);
    expect(problemsOf(r)).toContain(ADMIN_KIT);
    const renamed = branch(repo, 'renamed', { [ADMIN_KIT]: null, [RENAMED]: ADMIN_BASE }, [
      supportRecord(ADMIN_KIT, ADMIN_BASE, ADMIN_BASE),
    ]);
    const m = check(repo, renamed, dir);
    expect(m.ok).toBe(false);
    expect(problemsOf(m)).toContain(ADMIN_KIT);
  },
  SLOW,
);
