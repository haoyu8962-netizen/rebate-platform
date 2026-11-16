// CT-06zzzzzi round 3 / 4 (orchestrator rulings D10-1689 whitelist A, D10-1775, D10-1779,
// D10-1780 ⑦ A): the token whitelist of a file under a file-level support entry, through
// test-blocks.ts compareSupportFile (support-tokens.ts judgeInsertions). Outside the blocks a
// support file may only gain tokens, none of a refused kind; each refusal names the line of the
// inserted token (head) or of the removed one (base).
// CT-06zzzzzj (D10-1795 / D10-1880 / D10-1888): on top of these rules, an allow list (rule 5,
// default deny): positions P1–P4 × the expression grammar; the cases of round 3 / 4 that passed
// while off the list (new …, a member call, an assignment to a fresh name, a token in an if
// header) are refused now, by the allow list.
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
  '  if (size(x) > 0) {',
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

it('[CT-06zzzzzi] whitelist: pure insertions of allowed tokens pass (import, argument, appended property, optional parameter, new const, plain call, a typed const)', () => {
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
    insert('  let tries = 0;', '  const table: Map<string, number> = summary(input);'),
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
  // Round 3 let a name this change declares be assigned; the allow list (CT-06zzzzzj) takes no
  // let and no assignment at all: each line is refused by it.
  const tried = n('  let tries = 0;');
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
  // One run of inserted tokens: named by its first token off the list.
  expect(problems(fresh)).toEqual([
    `head:${tried + 1} \`let\` inserted (only a const declares a new name)`,
  ]);
  for (const [line, reason] of [
    [
      '  const one = 1;\n  one = 2;',
      /a statement inserted that is no import, const, call or export/,
    ],
    ['  const box = { a: 1 };\n  box.a = 2;', /a member call or member access as a statement/],
  ] as const) {
    const head = insert('  let tries = 0;', line);
    expect(refused(head, tried + 2, reason), `${line}\n${problems(head).join('\n')}`).toBe(true);
  }
  // `const` inserted before an existing assignment turns it into a declaration.
  const turned = edit('  n = n + 1;', '  const n = n + 1;');
  expect(refused(turned, n('  n = n + 1;'), /turned into a declaration/)).toBe(true);
});

it('[CT-06zzzzzi] D10-1780 ⑦ A (ii): a token inserted in a for or if header whose body holds an assertion call is refused; an argument appended in a header without one passes (CT-06zzzzzj: a member call there is off the allow list)', () => {
  const forHead = edit('  for (const row of rows) {', '  for (const row of rows.slice(0)) {');
  expect(
    refused(forHead, n('  for (const row of rows) {'), /existing statement holding an assertion/),
  ).toBe(true);
  const ifHead = edit('  if (rows.length > 0) {', '  if (rows.length.valueOf() > 0) {');
  expect(
    refused(ifHead, n('  if (rows.length > 0) {'), /existing statement holding an assertion/),
  ).toBe(true);
  expect(problems(edit('  if (size(x) > 0) {', '  if (size(x, 1) > 0) {'))).toEqual([]);
  expect(
    refused(
      edit('  if (size(x) > 0) {', '  if (size(x).valueOf() > 0) {'),
      n('  if (size(x) > 0) {'),
      /inserted into the header of an if/,
    ),
  ).toBe(true);
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
    // Passing in round 3; off the allow list since CT-06zzzzzj (an import is a whole statement
    // of the file only).
    ["  import('./x.ts').then(String);", /an import inserted inside a block/],
    ['  const note = `${input.fee ?? 0}`;', /template/],
  ];
  for (const [line, reason] of cases) {
    const head = insert('  let tries = 0;', line);
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

// CT-06zzzzzj (D10-1880 / D10-1888): the allow list, positions P1–P4 × the expression grammar.

/** The problems of `base` → `head` (any base) as `side:line reason` strings. */
function problemsOf(base: string, head: string): string[] {
  const r = compareSupportFile(base, head);
  if (!r.ok) throw new Error(r.reason);
  return r.tokens.map((p) => `${p.side}:${p.line} ${p.reason}`);
}

it('[CT-06zzzzzj] P1 whole statements: imports with a binding, a new const, [await] calls of a bare identifier, <base local>.push(…), export const and export { … } at the end pass', () => {
  const end = `${KIT}export const LIMIT = 3;\nexport { send };\n`;
  const heads = [
    insert("import { send } from './http.ts';", "import * as digests from './digests.ts';"),
    insert("import { send } from './http.ts';", "import type { Shape } from './rows.ts';"),
    insert("import { send } from './http.ts';", "import base, { other as alias } from 'node:x';"),
    insert('  let tries = 0;', "  const label = 'x';"),
    insert('  let tries = 0;', '  const sum = input.amount * 2 + 1;'),
    insert('  let tries = 0;', '  const big = input.amount >= 10;'),
    insert('  let tries = 0;', '  await summary(input, [1n, { a: input.fee }]);'),
    insert('  let tries = 0;', '  tries.push(input.fee);'),
    insert('  let tries = 0;', '  input.push({ id: 1 });'),
    insert('  let tries = 0;', '  const pick = summary;\n  summary(pick);'),
    end,
  ];
  for (const head of heads) expect(problems(head), head).toEqual([]);
});

it('[CT-06zzzzzj] P1 refusals name the line: a bare import, let / var, export { … } before existing code, a destructuring or two-name const, a push on an import binding, a global or a fresh const, a fresh const called (④), a member call statement, a name alone', () => {
  const at = n('  let tries = 0;') + 1;
  const cases: [string, RegExp, number][] = [
    ['  let more = 1;', /`let` inserted/, 0],
    ['  var more = 1;', /`var` inserted/, 0],
    ['  const { amount } = input;', /destructuring const/, 0],
    ['  const [first] = input;', /destructuring const/, 0],
    // The comma expression rule of CT-06zzzzzi names the line first (one problem per line).
    ['  const a = 1, b = 2;', /comma expression/, 0],
    ['  send.push(1);', /`send` is no const, let or parameter of the base file/, 0],
    ['  history.push(1);', /`history` is no const, let or parameter/, 0],
    ['  const queue = [];\n  queue.push(1);', /`queue` is no const, let or parameter/, 1],
    ['  const assign = summary;\n  assign(input);', /a const this change declares, called/, 1],
    ['  const wrap = summary;\n  const got = wrap(input);', /a const this change declares/, 1],
    ['  Object.assign(input, {});', /member call or member access as a statement/, 0],
    ["  vi.stubEnv('X', '1');", /member call or member access as a statement/, 0],
    ['  input;', /no import, const, call or export/, 0],
    ['  await input;', /no import, const, call or export/, 0],
    ['  await Promise.resolve(input);', /member call or member access as a statement/, 0],
  ];
  for (const [line, reason, offset] of cases) {
    const head = insert('  let tries = 0;', line);
    expect(refused(head, at + offset, reason), `${line}\n${problems(head).join('\n')}`).toBe(true);
  }
  const bare = insert("import { send } from './http.ts';", "import './setup.ts';");
  expect(refused(bare, n("import { send } from './http.ts';") + 1, /bare side-effect import/)).toBe(
    true,
  );
  const early = insert("import { send } from './http.ts';", 'export { send };');
  expect(
    refused(early, n("import { send } from './http.ts';") + 1, /at the end of the file only/),
  ).toBe(true);
  const exportLet = `${KIT}export let LIMIT = 3;\n`;
  expect(refused(exportLet, KIT.split('\n').length, /off the allow list/)).toBe(true);
});

it('[CT-06zzzzzj] P2 / P4 tails: an argument, a property or an optional parameter appended, a lone trailing comma, a name anywhere in import braces pass; one before or between existing items, a required, rest or defaulted parameter, a name added to an export list are refused', () => {
  const sendLine = "  const sent = send(app, 'POST', input);";
  const total = '  return { sent, total: input.amount + input.fee };';
  const adjust = 'export function adjust(app: App, input: Input) {';
  for (const head of [
    edit(sendLine, "  const sent = send(app, 'POST', input, { a: [1] }, summary(input));"),
    edit(sendLine, "  const sent = send(\n    app,\n    'POST',\n    input,\n  );"),
    edit(total, '  return { sent, total: input.amount + input.fee, ...summary(input), b };'),
    edit(adjust, 'export function adjust(app: App, input: Input, a?: string, b?) {'),
    edit("import { send } from './http.ts';", "import { other, send } from './http.ts';"),
  ]) {
    expect(problems(head), head).toEqual([]);
  }
  const cases: [string, string, RegExp][] = [
    [sendLine, "  const sent = send(app, label, 'POST', input);", /before or between/],
    [sendLine, "  const sent = send(app, 'POST', input, 1 + 1);", /off the allow list/],
    [total, '  return { label: 1, sent, total: input.amount + input.fee };', /before or between/],
    [total, '  return { ...input, sent, total: input.amount + input.fee };', /before or between/],
    [adjust, 'export function adjust(app: App, input: Input, label: string) {', /required/],
    [adjust, 'export function adjust(app: App, input: Input, ...rest: string[]) {', /rest/],
    [adjust, 'export function adjust(label?: string, app: App, input: Input) {', /before or/],
  ];
  for (const [line, to, reason] of cases) {
    const head = edit(line, to);
    expect(refused(head, n(line), reason), `${to}\n${problems(head).join('\n')}`).toBe(true);
  }
  const base = 'const a = 1;\nconst b = 2;\nexport { a };\n';
  expect(problemsOf(base, base.replace('{ a }', '{ a, b }'))).toEqual([
    'head:3 `,` inserted into an export list (names are added to an import only)',
  ]);
});

it('[CT-06zzzzzj] P3 type positions: a return type, a const or parameter annotation, an optional mark, an optional member of an interface or a type literal pass; a required member and an annotation on a destructured name are refused', () => {
  const adjust = 'export function adjust(app: App, input: Input) {';
  for (const head of [
    edit(adjust, 'export function adjust(app: App, input: Input): Promise<Map<string, number>> {'),
    edit(
      "  const sent = send(app, 'POST', input);",
      "  const sent: Sent = send(app, 'POST', input);",
    ),
    edit('export function plain(x: number) {', 'export function plain(x?: number) {'),
  ]) {
    expect(problems(head), head).toEqual([]);
  }
  const iface =
    'export interface T {\n  id: string;\n}\nexport type U = { a: number; b: number };\n';
  expect(
    problemsOf(iface, iface.replace('  id: string;', '  id: string;\n  more?: string;')),
  ).toEqual([]);
  expect(problemsOf(iface, iface.replace('b: number }', 'b: number; c?: string[] }'))).toEqual([]);
  expect(problemsOf(iface, iface.replace('  id: string;', '  id?: string;'))).toEqual([]);
  expect(
    problemsOf(iface, iface.replace('  id: string;', '  id: string;\n  more: string;')),
  ).toEqual(['head:3 a required member inserted (only an optional one, `x?: T`)']);
  const pattern = 'const { a } = b;\n';
  expect(problemsOf(pattern, 'const { a: c } = b;\n')).not.toEqual([]);
});

it('[CT-06zzzzzj] the expression grammar: Promise.resolve(…), arrays, nested calls of bare identifiers pass in a new const; new, a member call, a template with ${…}, parentheses, indexing, a unary minus, an operator below the top of the value, a call of a call are refused, naming the line', () => {
  const at = n('  let tries = 0;') + 1;
  for (const line of [
    '  const ok = await Promise.resolve(summary(input));',
    "  const list = [1n, input.fee, { a: 'x', b: [null, true] }];",
    '  const deep = input.a.b.c;',
    '  const merged = { a: 1, ...input, ...summary(input) };',
  ]) {
    expect(problems(insert('  let tries = 0;', line)), line).toEqual([]);
  }
  const cases: [string, RegExp][] = [
    ['  const d = new Date(0).toISOString();', /`new` inserted/],
    ['  const s = input.fee.toFixed(2);', /a member call `\.toFixed\(`/],
    ['  const r = Promise.reject(input);', /a member call `\.reject\(`/],
    ['  const t = `${input.fee}`;', /a template literal with/],
    ['  const g = (input.fee);', /off the allow list/],
    ['  const i = input[0];', /off the allow list/],
    ['  const m = -1;', /off the allow list/],
    ['  const o = summary(input.fee + 1);', /off the allow list/],
    ['  const c = summary(input)(1);', /off the allow list/],
    ['  const late = { ...input, a: 1 };', /a property after a spread/],
    ['  summary(input.fee * 2);', /off the allow list/],
  ];
  for (const [line, reason] of cases) {
    const head = insert('  let tries = 0;', line);
    expect(refused(head, at, reason), `${line}\n${problems(head).join('\n')}`).toBe(true);
  }
});

it('[CT-06zzzzzj] one problem per line: a line another rule names gets no allow-list problem; a token after an existing call (.then) is refused as an insertion into an existing statement', () => {
  const sendLine = "  const sent = send(app, 'POST', input);";
  const then = edit(sendLine, "  const sent = send(app, 'POST', input).then(String);");
  expect(problems(then)).toEqual([
    `head:${n(sendLine)} \`.\` inserted into an existing statement (no whole statement, no item appended at the end of a list, no type)`,
  ]);
  const arrow = insert('  let tries = 0;', '  const pick = (s: Sent) => s;');
  expect(problems(arrow)).toEqual([
    `head:${n('  let tries = 0;') + 1} an arrow function \`=>\` inserted`,
  ]);
});

it('[CT-06zzzzzj] review r1 S2-1: Promise.resolve(…) passes only while Promise is the global; a const, an import or a parameter named Promise makes it a member call, refused; a push on a base local cannot be aliased (a const of its name is refused as a name the base holds)', () => {
  const at = n('  let tries = 0;') + 1;
  expect(
    problems(insert('  let tries = 0;', '  const ok = await Promise.resolve(summary(input));')),
  ).toEqual([]);
  const aliased = insert(
    '  let tries = 0;',
    '  const Promise = { resolve: Object.assign };\n  const patched = Promise.resolve(sent, { status: 200 });',
  );
  expect(refused(aliased, at + 1, /`Promise` is declared in this file/)).toBe(true);
  const imported = insert(
    "import { send } from './http.ts';",
    "import { Promise } from './promise.ts';",
  ).replace('  let tries = 0;', '  let tries = 0;\n  const got = Promise.resolve(input);');
  expect(refused(imported, at + 1, /`Promise` is declared in this file/)).toBe(true);
  const param = edit(
    'export function adjust(app: App, input: Input) {',
    'export function adjust(app: App, input: Input, Promise?: object) {',
  ).replace('  let tries = 0;', '  let tries = 0;\n  summary(Promise.resolve(input));');
  expect(refused(param, at, /`Promise` is declared in this file/)).toBe(true);
  const shadow = insert('  let tries = 0;', '  const tries = [];\n  tries.push(1);');
  expect(refused(shadow, at, /declares `tries`, a name the base file already holds/)).toBe(true);
});

it('[CT-06zzzzzj] review r1 S2-2: a type literal is known by where its braces stand (a type alias, an annotation, type arguments), not by the separators: a required member appended with a comma is refused, an optional one passes; a property appended to an object expression passes', () => {
  const base = [
    'export type T = { a: number };',
    'export type U = Partial<{ a: number }> | { b: string };',
    'export function f(t: { a: number }) {',
    '  return t;',
    '}',
    'export const o = { a: 1 };',
    'export const p = { a: { b: 1 } };',
    '',
  ].join('\n');
  const pass = [
    base.replace('T = { a: number }', 'T = { a: number, b?: string }'),
    base.replace('T = { a: number }', 'T = { a: number; b?: string }'),
    base.replace('Partial<{ a: number }>', 'Partial<{ a: number, c?: string }>'),
    base.replace('| { b: string }', '| { b: string, c?: number }'),
    base.replace('f(t: { a: number })', 'f(t: { a: number, b?: string })'),
    base.replace('o = { a: 1 }', 'o = { a: 1, b: 2 }'),
    base.replace('p = { a: { b: 1 } }', 'p = { a: { b: 1, c: 2 } }'),
  ];
  for (const head of pass) expect(problemsOf(base, head), head).toEqual([]);
  const refusedHeads: [string, number][] = [
    [base.replace('T = { a: number }', 'T = { a: number, b: string }'), 1],
    [base.replace('T = { a: number }', 'T = { a: number; b: string }'), 1],
    [base.replace('Partial<{ a: number }>', 'Partial<{ a: number, c: string }>'), 2],
    [base.replace('| { b: string }', '| { b: string, c: number }'), 2],
    [base.replace('f(t: { a: number })', 'f(t: { a: number, b: string })'), 3],
  ];
  for (const [head, line] of refusedHeads) {
    expect(problemsOf(base, head), head).toEqual([
      `head:${line} a required member inserted (only an optional one, \`x?: T\`)`,
    ]);
  }
});
