// CT-06zzzzzj (D10-1880, the second set of fixed cases): every example of CT-06zzzzzi code review
// r3b S2-1 / S2-2 is refused. Each is a pure insertion outside the blocks of a frozen money kit
// (ADMIN_KIT, the modify-existing-support fixture after test/spec/ledger/admin-adjustments/kit.ts,
// owner label present) that whitelist A (CT-06zzzzzi) let through while it changes what the
// helpers check. Under the two layers of the allow list (kit.ts) each falls outside it:
// S2-1 an argument before an existing one (P2 is the tail only), a binary operator (no operator in
// the expression grammar), .then / .catch after an existing call (a member call), `*` after
// `function` (no position takes it); S2-2 vi.spyOn(…).mockResolvedValue(…), vi.stubEnv(…),
// Object.assign(existing, …) (member calls), and an assignment through a fresh alias (no
// assignment but the const declaration: `const s = sent;` itself is a P1 const and passes, so the
// line named is the assignment's). Each is refused, naming the file and that line. D10-1888 adds
// three aliases: o.assign(…) after const o = Object (③ pushes only), assign(…) after const assign
// = Object.assign (④), const { stubEnv } = vi (⑤); `answer(sent, 0 + 1)` stays refused (② allows
// operators in the value of a new const only).
// S2-1 (d) is replayed on denied(), not on conforms(): conforms() holds an expect-named call, so
// CT-06zzzzzi already refuses `function*` there.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { lineProblem, problemsOf } from '../modify-existing-support/kit.ts';
import {
  ADMIN,
  ADMIN_BASE,
  ADMIN_KIT,
  type Fixture,
  SLOW,
  cleanup,
  fixture,
  insertAfter,
  judge,
  lineAt,
  replaceLine,
} from './kit.ts';

let f: Fixture;
beforeAll(() => {
  f = fixture('review');
});
afterAll(cleanup);

type Row = {
  name: string;
  /** The edit of ADMIN_BASE. */
  edit: (text: string) => string;
  /** The head lines holding the refused inserted token (each exactly once in the head). */
  lines: readonly string[];
};

const DENIED = 'export function denied(sent: AdminSent) {';
/** Replaces `line` by `to`; `to` is the head line named. */
const replaced = (name: string, line: string, to: string): Row => ({
  name,
  edit: (t) => replaceLine(t, line, to),
  lines: [to],
});
/** Inserts `added` (one or more lines) after ADMIN.raw in stepUpOf; `named` is the line named. */
const inserted = (name: string, added: string, named: string = added): Row => ({
  name,
  edit: (t) => insertAfter(t, ADMIN.raw, added),
  lines: [named],
});

const ROWS: readonly Row[] = [
  // S2-1 (a): the helper receives code 1.
  replaced(
    'S2-1 an argument before an existing one, answer(sent, 0) to answer(sent, 1, 0)',
    ADMIN.executed,
    '  const body = await answer(sent, 1, 0);',
  ),
  // S2-1 (b): binary operators and operands.
  replaced(
    'S2-1 an operator and operand in an existing argument, answer(sent, 0) to answer(sent, 0 + 1)',
    ADMIN.executed,
    '  const body = await answer(sent, 0 + 1);',
  ),
  replaced(
    "S2-1 a string concatenated to an existing value, { reason: 'admin_permission_denied' + '_x' }",
    ADMIN.denied,
    "  return answer(sent, 10403, { reason: 'admin_permission_denied' + '_x' });",
  ),
  // S2-1 (c): the helper's rejection swallowed, as if the line were deleted.
  replaced(
    'S2-1 .then(undefined, String) after an existing call, await conforms(sent)',
    ADMIN.conforms,
    '  await conforms(sent).then(undefined, String);',
  ),
  replaced(
    'S2-1 .catch(String) after an existing call, await conforms(sent)',
    ADMIN.conforms,
    '  await conforms(sent).catch(String);',
  ),
  // S2-1 (d): a generator whose body never runs (denied() holds no expect-named call).
  replaced(
    'S2-1 a star after function, function denied( to function* denied(',
    DENIED,
    'export function* denied(sent: AdminSent) {',
  ),
  // S2-2: mocking and writes to existing objects.
  inserted(
    "S2-2 vi.spyOn(service, 'verify').mockResolvedValue(true)",
    "  vi.spyOn(service, 'verify').mockResolvedValue(true);",
  ),
  inserted("S2-2 vi.stubEnv('X', '1')", "  vi.stubEnv('X', '1');"),
  inserted('S2-2 Object.assign(sent, { status: 200 })', '  Object.assign(sent, { status: 200 });'),
  inserted(
    'S2-2 a fresh alias then an assignment through it, const s = sent; s.status = 200',
    '  const s = sent;\n  s.status = 200;',
    '  s.status = 200;',
  ),
  // D10-1888, the aliases of S2-2: each first line passes alone; the line named is refused.
  inserted(
    'D10-1888 an alias of Object, const o = Object; o.assign(sent, { status: 200 })',
    '  const o = Object;\n  o.assign(sent, { status: 200 });',
    '  o.assign(sent, { status: 200 });',
  ),
  inserted(
    'D10-1888 ④ const assign = Object.assign; assign(sent, { status: 200 })',
    '  const assign = Object.assign;\n  assign(sent, { status: 200 });',
    '  assign(sent, { status: 200 });',
  ),
  inserted('D10-1888 ⑤ destructuring, const { stubEnv } = vi', '  const { stubEnv } = vi;'),
];

it.each(ROWS)(
  '[CT-06zzzzzj#20] code review r3b of CT-06zzzzzi: $name, inserted outside the blocks of a frozen money kit with the owner label, is refused, naming the file and the line',
  ({ name, edit, lines }) => {
    const head = edit(ADMIN_BASE);
    expect(head, name).not.toBe(ADMIN_BASE);
    const numbers = lines.map((line) => lineAt(head, line));
    expect(Math.min(...numbers), name).toBeGreaterThan(18);
    const report = judge(f, ADMIN_KIT, head);
    const why = `${name}\n${problemsOf(report)}`;
    expect(report.ok, why).toBe(false);
    expect(report.approval_wanted, why).toBe(true);
    expect(lineProblem(report, ADMIN_KIT, numbers), why).toBeDefined();
  },
  SLOW,
);
