// CT-06zzzzzi round 3 / 4 (orchestrator rulings D10-1689 whitelist A, D10-1775, D10-1779,
// D10-1780 ⑦ A): the token whitelist of a file under a file-level support entry, through
// test-blocks.ts compareSupportFile (support-tokens.ts judgeInsertions). Outside the blocks a
// support file may only gain tokens, none of a refused kind; each refusal names the line of the
// inserted token (head) or of the removed one (base).
import { expect, it } from 'vitest';
import { compareSupportFile } from './test-blocks.ts';

const KIT = [
  "import { expect } from 'vitest';",
  "import { send } from './http.ts';",
  '',
  'export async function answer(sent: Sent, code: number) {',
  '  const body = sent.json();',
  '  expect(body.code).toBe(code);',
  '  await conforms(sent);',
  '  return body;',
  '}',
  '',
  'export function adjust(app: App, input: Input) {',
  '  let tries = 0;',
  "  const sent = send(app, 'POST', input);",
  '  sent.meta = { tries };',
  '  return { sent, total: input.amount + input.fee };',
  '}',
  '',
  'export function check(rows: Row[]) {',
  '  for (const row of rows) {',
  '    expect(row.amount).toBe(1);',
  '  }',
  '  if (rows.length > 0) {',
  '    expect(rows[0]).toBeDefined();',
  '  }',
  '}',
  '',
  'export function plain(x: number) {',
  '  if (x > 0) {',
  '    void x;',
  '  }',
  '}',
  '',
  'export function bump(n: number) {',
  '  n = n + 1;',
  '  return n;',
  '}',
  '',
].join('\n');

/** 1-based number of the line of KIT that is exactly `line`. */
function n(line: string): number {
  const at = KIT.split('\n').indexOf(line);
  if (at < 0) throw new Error(`fixture: "${line}" not found`);
  return at + 1;
}

/** KIT with the line `line` replaced by `to`. */
function edit(line: string, to: string): string {
  const lines = KIT.split('\n');
  const at = lines.indexOf(line);
  if (at < 0) throw new Error(`fixture: "${line}" not found`);
  lines[at] = to;
  return lines.join('\n');
}

/** KIT with `added` inserted after the line `after`. */
function insert(after: string, added: string): string {
  return edit(after, `${after}\n${added}`);
}

/** The token problems of KIT → head as `side:line reason` strings. */
function problems(head: string): string[] {
  expect(head).not.toBe(KIT);
  const r = compareSupportFile(KIT, head);
  if (!r.ok) throw new Error(r.reason);
  return r.tokens.map((p) => `${p.side}:${p.line} ${p.reason}`);
}

/** Whether the problems of KIT → head hold one on `line` matching `reason`. */
function refused(head: string, line: number, reason: RegExp): boolean {
  return problems(head).some((p) => p.startsWith(`head:${line} `) && reason.test(p));
}

it('[CT-06zzzzzi] whitelist: pure insertions of allowed tokens pass (import, argument, appended property, optional parameter, new const, plain call, a .toISOString() call)', () => {
  const heads = [
    insert("import { send } from './http.ts';", "import { summary } from './summary.ts';"),
    edit(
      "  const sent = send(app, 'POST', input);",
      "  const sent = send(app, 'POST', input, summary);",
    ),
    edit(
      '  return { sent, total: input.amount + input.fee };',
      '  return { sent, total: input.amount + input.fee, digest: summary(input) };',
    ),
    edit(
      'export function adjust(app: App, input: Input) {',
      'export function adjust(app: App, input: Input, label?: string) {',
    ),
    insert('  let tries = 0;', '  const echoed = await Promise.resolve(summary(input));'),
    insert('  let tries = 0;', '  summary(input);'),
    insert('  let tries = 0;', '  const stamp = new Date(0).toISOString();'),
    insert('  let tries = 0;', '  const table: Map<string, number> = new Map();'),
  ];
  for (const head of heads) expect(problems(head), head).toEqual([]);
});

it('[CT-06zzzzzi] D10-1779 ①: a parameter default value inserted is refused, naming the line of the inserted token', () => {
  const head = edit(
    'export function adjust(app: App, input: Input) {',
    "export function adjust(app: App, input: Input, label = 'x') {",
  );
  expect(
    refused(head, n('export function adjust(app: App, input: Input) {'), /default value/),
  ).toBe(true);
  // A destructuring default in a new const too.
  const pattern = insert('  let tries = 0;', '  const { fee = 0 } = input;');
  expect(refused(pattern, n('  let tries = 0;') + 1, /default value/)).toBe(true);
});

it('[CT-06zzzzzi] D10-1779 ②: an assignment to a name of the base is refused (=, +=, ++, an existing property, an existing parameter); one to a name this change declares passes', () => {
  const after = n('  sent.meta = { tries };') + 1;
  for (const line of [
    '  tries = 1;',
    '  tries += 1;',
    '  tries++;',
    '  ++tries;',
    '  sent.meta = 1;',
    '  input.fee = 0;',
    '  input = other;',
  ]) {
    const head = insert('  sent.meta = { tries };', line);
    expect(refused(head, after, /assignment/), `${line}\n${problems(head).join('\n')}`).toBe(true);
  }
  // A name this change declares may be assigned, a property of it too.
  const fresh = insert(
    '  let tries = 0;',
    [
      '  let fresh = 0;',
      '  fresh = 1;',
      '  fresh += 1;',
      '  const box = { a: 1 };',
      '  box.a = 2;',
    ].join('\n'),
  );
  expect(problems(fresh)).toEqual([]);
  // `const` inserted before an existing assignment turns it into a declaration.
  const turned = edit('  n = n + 1;', '  const n = n + 1;');
  expect(refused(turned, n('  n = n + 1;'), /turned into a declaration/)).toBe(true);
});

it('[CT-06zzzzzi] D10-1780 ⑦ A (ii): a token inserted in a for or if header whose body holds an assertion call is refused; the same in a header without one passes', () => {
  const forHead = edit('  for (const row of rows) {', '  for (const row of rows.slice(0)) {');
  expect(
    refused(forHead, n('  for (const row of rows) {'), /existing statement holding an assertion/),
  ).toBe(true);
  const ifHead = edit('  if (rows.length > 0) {', '  if (rows.length.valueOf() > 0) {');
  expect(
    refused(ifHead, n('  if (rows.length > 0) {'), /existing statement holding an assertion/),
  ).toBe(true);
  expect(problems(edit('  if (x > 0) {', '  if (x.valueOf() > 0) {'))).toEqual([]);
});

it('[CT-06zzzzzi] D10-1780 ⑦ A (i) and (iii): an argument inserted next to an assertion passes, into it is refused; an optional parameter in the list of a function whose body asserts passes', () => {
  expect(problems(insert('  const body = sent.json();', '  summary(body);'))).toEqual([]);
  const message = edit(
    '  expect(body.code).toBe(code);',
    "  expect(body.code, 'code').toBe(code);",
  );
  expect(
    refused(
      message,
      n('  expect(body.code).toBe(code);'),
      /existing statement holding an assertion/,
    ),
  ).toBe(true);
  expect(
    problems(
      edit(
        'export function check(rows: Row[]) {',
        'export function check(rows: Row[], label?: string) {',
      ),
    ),
  ).toEqual([]);
  expect(
    problems(
      edit(
        'export async function answer(sent: Sent, code: number) {',
        'export async function answer(sent: Sent, code: number, label?: string) {',
      ),
    ),
  ).toEqual([]);
});

it('[CT-06zzzzzi] the refusal names the line of the inserted token: else {} on the closing line of an existing if, not the next base line', () => {
  const lines = KIT.split('\n');
  const close = n('    void x;') + 1;
  lines[close - 1] = '  } else {}';
  const got = problems(lines.join('\n'));
  expect(got[0]).toBe(`head:${close} control flow \`else\` inserted`);
});

it('[CT-06zzzzzi] whitelist: removed, changed or moved tokens and existing code wrapped or regrouped are refused; a removed assertion line keeps the assertion wording', () => {
  const removed = compareSupportFile(KIT, edit('  await conforms(sent);', ''));
  expect(removed.ok && removed.tokens.map((p) => `${p.side}:${p.line}`)).toEqual([
    `base:${n('  await conforms(sent);')}`,
  ]);
  const value = compareSupportFile(KIT, edit('  let tries = 0;', '  let tries = 1;'));
  expect(value.ok && value.tokens[0]?.reason).toMatch(/^`0` removed or changed/);
  const assertion = n('  expect(body.code).toBe(code);');
  const commented = compareSupportFile(
    KIT,
    edit('  expect(body.code).toBe(code);', '  // expect(body.code).toBe(code);'),
  );
  expect(commented.ok && commented.tokens.map((p) => `${p.side}:${p.line}`)).toEqual([
    `base:${assertion}`,
  ]);
  expect(commented.ok && commented.assertions.map((l) => `${l.side}:${l.line}`)).toEqual([
    `base:${assertion}`,
  ]);
  const swapped = compareSupportFile(
    KIT,
    edit(
      '  return { sent, total: input.amount + input.fee };',
      '  return { sent, total: input.fee + input.amount };',
    ),
  );
  expect(swapped.ok && swapped.tokens[0]?.side).toBe('base');
  const wrapped = edit('  await conforms(sent);', '  await later(conforms(sent));');
  expect(refused(wrapped, n('  await conforms(sent);'), /other brackets/)).toBe(true);
  const regrouped = edit(
    "  const sent = send(app, 'POST', input);",
    "  const sent = send(app, ('POST'), input);",
  );
  expect(refused(regrouped, n("  const sent = send(app, 'POST', input);"), /other brackets/)).toBe(
    true,
  );
});

it('[CT-06zzzzzi] whitelist: each refused kind of inserted token is named (control flow, conditional, short circuit, optional chain, function, comma expression, test modifier, vi mock, assertion call, shadowing name, template expression)', () => {
  const at = n('  let tries = 0;') + 1;
  const cases: [string, RegExp][] = [
    ['  if (tries) void 0;', /control flow `if`/],
    ['  const shown = tries ? 1 : 2;', /conditional/],
    ['  const either = tries || 1;', /short circuit/],
    ['  const known = input?.fee;', /optional chain/],
    ['  const pick = (s: Sent) => s;', /arrow function/],
    ['  const named = function () {};', /`function`/],
    ['  void 0, summary(input);', /comma expression/],
    // Built from parts: the test guard rejects the literal modifier in a test file (no-skip-only).
    [`  void it.${'only'};`, new RegExp(`test modifier \`\\.${'only'}\``)],
    ["  vi.mock('./http.ts');", /`vi\.mock`/],
    ['  expectRows(input);', /assertion call/],
    ['  void input.resolves;', /assertion call/],
    ['  const body = 1;', /declares `body`/],
    ["  import('./x.ts').then(String);", /^$/],
    ['  const note = `${input.fee ?? 0}`;', /template/],
  ];
  for (const [line, reason] of cases) {
    const head = insert('  let tries = 0;', line);
    if (reason.source === '^$') {
      expect(problems(head), line).toEqual([]);
      continue;
    }
    expect(refused(head, at, reason), `${line}\n${problems(head).join('\n')}`).toBe(true);
  }
});

it('[CT-06zzzzzi] D10-1793: a test hook (beforeEach, afterEach, beforeAll, afterAll) or vi.hoisted inserted is refused, naming the line of the inserted token; a plain call of another name passes', () => {
  const at = n('  let tries = 0;') + 1;
  const cases: [string, RegExp][] = [
    ['  beforeEach(reset);', /test hook `beforeEach`/],
    ['  afterEach(reset);', /test hook `afterEach`/],
    ['  beforeAll(reset);', /test hook `beforeAll`/],
    ['  afterAll(reset);', /test hook `afterAll`/],
    ['  vi.hoisted(reset);', /`vi\.hoisted`/],
  ];
  for (const [line, reason] of cases) {
    const head = insert('  let tries = 0;', line);
    expect(refused(head, at, reason), `${line}\n${problems(head).join('\n')}`).toBe(true);
    // The hook is the only refused kind in the line.
    expect(problems(head), line).toHaveLength(1);
  }
  expect(problems(insert('  let tries = 0;', '  resetAll(reset);'))).toEqual([]);
  expect(problems(insert('  let tries = 0;', '  setupBeforeEach(input);'))).toEqual([]);
});

it('[CT-06zzzzzi] whitelist: comments are no tokens (changed, removed, inserted, wrapping nothing); a statement inserted before one that starts alike passes', () => {
  const comments = KIT.replace(
    '  await conforms(sent);',
    '  await conforms(sent); // expect(x).toBe(1)',
  )
    .replace('  return body;', '  /* assert.ok(body) */ return body;')
    .replace(
      "import { send } from './http.ts';",
      "// if (x) return;\nimport { send } from './http.ts';",
    );
  expect(problems(comments)).toEqual([]);
  // A call before an existing call to the same function, on the same line as a new statement.
  const alike = edit(
    "  const sent = send(app, 'POST', input);",
    "  send(app, 'GET', input); const sent = send(app, 'POST', input);",
  );
  expect(problems(alike)).toEqual([]);
});
