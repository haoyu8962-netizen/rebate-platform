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

// CT-06zzzzzk (D10-1902 / D10-1916): an object type literal at any depth of a type is judged by
// P3 (typeLiteral → inType: the enclosing tuple / parenthesized type, a conditional or function
// type's branch or return, a named tuple element); a value nested alike stays P2.

/** Base lines, each with one `{ a: number }` leaf in a type (1-based line = index + 1). */
const NESTED = [
  'type A = { id: string };',
  'declare const raw: never;',
  'export type T1 = [{ a: number }];',
  'export type T2 = readonly [string, { a: number }];',
  'export type T3 = [label: { a: number }];',
  'export type T4 = (A | { a: number })[];',
  'export type T5 = () => [{ a: number }];',
  'export type T6<X> = X extends A ? [{ a: number }] : never;',
  'export type T7<X> = X extends A ? never : [{ a: number }];',
  'export const v1 = raw as Array<[{ a: number }]>;',
  'export const v2 = raw as Record<string, { a: number }>;',
  'export function g(cb: <X>(x: X) => [{ a: number }]) {',
  '  return cb;',
  '}',
  '',
];

it('[CT-06zzzzzk] inType: a nested object type literal (tuple, readonly / named tuple, parenthesized, function type return, conditional branch, type arguments) takes optional members or a ? mark; a required member is refused at its line', () => {
  const base = NESTED.join('\n');
  const leaves = NESTED.map((l, i) => [l, i + 1] as const).filter(([l]) =>
    l.includes('{ a: number }'),
  );
  expect(leaves.length).toBe(10);
  for (const [line, at] of leaves) {
    const edit = (to: string): string => base.replace(line, line.replace('{ a: number }', to));
    for (const to of ['{ a: number; b?: string }', '{ a: number, b?: string }', '{ a?: number }']) {
      expect(problemsOf(base, edit(to)), `${line} → ${to}`).toEqual([]);
    }
    for (const to of ['{ a: number; b: string }', '{ a: number, b: string }']) {
      expect(problemsOf(base, edit(to)), `${line} → ${to}`).toEqual([
        `head:${at} a required member inserted (only an optional one, \`x?: T\`)`,
      ]);
    }
  }
});

it('[CT-06zzzzzk] inType: object literals nested in values stay P2 — in an array, a call argument, parentheses, a generic arrow body, a conditional expression branch, before as / satisfies — a property appended passes', () => {
  const base = [
    'declare const raw: boolean;',
    'declare function f(value: unknown): void;',
    'export const rows = [{ a: 1 }];',
    'export const later = [0, { a: 1 }];',
    'f([{ x: [{ a: 1 }] }]);',
    'export const grouped = ({ a: 1 });',
    'export const make = <T,>(x: T) => [{ a: x }];',
    'export const pick = raw ? [{ a: 1 }] : [];',
    'export const alt = raw ? [] : [{ a: 1 }];',
    'export const asserted = [{ a: 1 }] as unknown;',
    'export const checked = [{ a: 1 }] satisfies unknown;',
    '',
  ].join('\n');
  for (const leaf of ['{ a: 1 }', '{ a: x }']) {
    let from = 0;
    for (;;) {
      const at = base.indexOf(leaf, from);
      if (at < 0) break;
      const head = `${base.slice(0, at)}${leaf.replace(' }', ', b: 2 }')}${base.slice(at + leaf.length)}`;
      expect(problemsOf(base, head), head.slice(at - 30, at + 20)).toEqual([]);
      from = at + 1;
    }
  }
});

it('[CT-06zzzzzk] bindings: a `,` in the type arguments after as / satisfies in an initializer ends no declarator (no pattern read from the type literal)', () => {
  const base = [
    'declare const raw: never;',
    'export const v = raw as Record<string, { a: number }>;',
    'export const w = raw satisfies Map<string, { a: number }>;',
    '',
  ].join('\n');
  for (const name of ['v', 'w']) {
    const line = base.split('\n').find((l) => l.startsWith(`export const ${name} `)) as string;
    const head = base.replace(line, line.replace('{ a: number }', '{ a: number; b?: string }'));
    expect(problemsOf(base, head), head).toEqual([]);
  }
});

// CT-06zzzzzk (D10-1924): skipping the type after as / satisfies hides no real declaration. The
// base holds `dup`; a declarator of it after the type must still be named (rule 3), on its line.

const HOLDS = [
  'declare const raw: never;',
  'declare const obj: { as: number; satisfies: number };',
  'type T = { id: string };',
  'export const dup = 0;',
  '',
].join('\n');
/** The line of HOLDS + the first inserted line. */
const AT = HOLDS.split('\n').length;
const COMMA = `head:${AT} a comma expression inserted`;
const holds = (line: number): string =>
  `head:${line} declares \`dup\`, a name the base file already holds`;
/** The problems of HOLDS with `lines` inserted at its end. */
const appended = (lines: string): string[] => problemsOf(HOLDS, `${HOLDS}${lines}\n`);

it('[CT-06zzzzzk] bindings (i): after `raw as T` a second declarator of a name the base holds is still refused for that name, on its own line; a fresh name gets only the comma expression', () => {
  expect(appended('const v = raw as Record<string, number>, dup = 1;')).toEqual([COMMA, holds(AT)]);
  expect(appended('const v = raw as Record<string, number>,\n  dup = 1;')).toEqual([
    COMMA,
    holds(AT + 1),
  ]);
  expect(appended('const v = raw as Record<string, number>,\n  fresh = 1;')).toEqual([COMMA]);
});

it('[CT-06zzzzzk] bindings (ii): `as unknown as T`, `as const` and `satisfies T` are skipped as types (an edit inside them declares nothing) and the declarator after them is still seen', () => {
  for (const line of [
    'export const v = raw as unknown as Record<string, { a: number }>, next = 1;',
    'export const s = raw satisfies Map<string, { a: number }>, next = 1;',
  ]) {
    const base = `declare const raw: never;\n${line}\n`;
    const head = base.replace('{ a: number }', '{ a: number; b?: string }');
    expect(problemsOf(base, head), head).toEqual([]);
  }
  const frozen = 'declare const raw: never;\nexport const w = { a: 1 } as const, next = 1;\n';
  expect(problemsOf(frozen, frozen.replace('{ a: 1 }', '{ a: 1, b: 2 }'))).toEqual([]);
  for (const first of [
    'const v = raw as unknown as T,',
    'const v = [raw] as const,',
    'const v = raw satisfies T,',
  ]) {
    expect(appended(`${first} dup = 1;`), first).toEqual([COMMA, holds(AT)]);
    expect(appended(`${first}\n  dup = 1;`), first).toEqual([COMMA, holds(AT + 1)]);
  }
});

it('[CT-06zzzzzk] bindings (iii): a member named `.as` / `.satisfies` starts no type: the declarator after it is seen, also where a skipped type would run on (`obj.as < 1, dup`)', () => {
  expect(appended('const got = obj.as, dup = 1;')).toEqual([COMMA, holds(AT)]);
  for (const member of ['as', 'satisfies']) {
    // Read as a type, `< 1, dup = 1` would be its type arguments up to the `;`: dup hidden.
    expect(appended(`const got = obj.${member} < 1,\n  dup = 1;`), member).toEqual([
      COMMA,
      holds(AT + 1),
    ]);
  }
});

it('[CT-06zzzzzk] bindings (iv): a type with commas, angles, braces and a function type after `as` ends at the `,` / `;` / line break after it: the next declarator or statement is seen on its line', () => {
  const type = 'raw as Map<string, { a: () => void }>';
  const arrow = `head:${AT} an arrow function \`=>\` inserted`;
  expect(appended(`const v = ${type}, dup = 2;`)).toEqual([arrow, COMMA, holds(AT)]);
  expect(appended(`const v = ${type},\n  dup = 2;`)).toEqual([arrow, COMMA, holds(AT + 1)]);
  expect(appended(`const v = ${type};\nconst dup = 2;`)).toEqual([arrow, holds(AT + 1)]);
  expect(appended(`const v = ${type}\nconst dup = 2`)).toEqual([arrow, holds(AT + 1)]);
  const base = `declare const raw: never;\nexport const m = ${type}, next = 2;\n`;
  const head = base.replace('{ a: () => void }', '{ a: () => void; b?: string }');
  expect(problemsOf(base, head)).toEqual([]);
});

// CT-06zzzzzk code review r2 (S2): `as` / `satisfies` is the type operator only right after a whole
// operand; a variable named `as` / `satisfies` (after `=`, `,`, an operator) is a name.

it('[CT-06zzzzzk] review r2: a variable named as / satisfies starts no type: the declarator after `as < 1` stays a base local (push passes) and a repeated name is still seen', () => {
  for (const word of ['as', 'satisfies']) {
    const base = `const ${word} = 0;\nconst flag = ${word} < 1, rows: number[] = [];\n`;
    expect(problemsOf(base, `${base}rows.push(2);\n`), word).toEqual([]);
    expect(appended(`const flag = ${word} < 1, dup = 1;`), word).toEqual([COMMA, holds(AT)]);
    expect(appended(`const flag = ${word} < 1,\n  dup = 1;`), word).toEqual([COMMA, holds(AT + 1)]);
  }
});

it('[CT-06zzzzzk] review r2: after a variable named as / satisfies the operator is the next one (`as as T`): its type is skipped and the declarator after it is seen', () => {
  for (const [name, op] of [
    ['as', 'as'],
    ['satisfies', 'satisfies'],
    ['as', 'satisfies'],
  ]) {
    const first = `const v = ${name} ${op} T,`;
    expect(appended(`${first} dup = 1;`), first).toEqual([COMMA, holds(AT)]);
    expect(appended(`${first}\n  dup = 1;`), first).toEqual([COMMA, holds(AT + 1)]);
  }
  const base = `declare const as: never;\nexport const v = as as Record<string, { a: number }>, next = 1;\n`;
  expect(problemsOf(base, base.replace('{ a: number }', '{ a: number; b?: string }'))).toEqual([]);
});

it('[CT-06zzzzzk] review r2: the operator follows any whole operand (a name, x!, a call, an array, a string, this, a member .as) and its type is skipped; a name as before `| { … }` is an operand, its object literal P2', () => {
  for (const operand of ['raw', 'raw!', 'f(raw)', '[raw]', "'x'", 'this', 'obj.as']) {
    const base = [
      'declare const raw: never;',
      'declare const obj: { as: number };',
      'declare function f(v: unknown): unknown;',
      `export const v = ${operand} as Map<string, { a: number }>, next = 1;`,
      '',
    ].join('\n');
    const head = base.replace('{ a: number }', '{ a: number; b?: string }');
    expect(problemsOf(base, head), operand).toEqual([]);
  }
  const named = 'declare const as: number;\nexport const v = as | { a: 1 };\n';
  expect(problemsOf(named, named.replace('{ a: 1 }', '{ a: 1, b: 2 }'))).toEqual([]);
});

// CT-06zzzzzn (D10-1924 / D10-1929 / D10-1932): three more type positions — the branches of a
// conditional type whose check type is a function type (conditionalType), a type parameter's
// default (typeDefault), the type after as / satisfies following a contextual keyword used as a
// variable name (contextualName) — judge an object type literal by P3; values alike stay P2.

const PRELUDE = [
  'type A = number;',
  'type B = void;',
  'declare const cond: boolean;',
  'declare const raw: never;',
];

/**
 * Lines with one `{ a: number }` leaf in a type: optional members pass, a required one
 * is refused at its line.
 */
function typeLeaves(lines: readonly string[]): void {
  const base = [...PRELUDE, ...lines, ''].join('\n');
  for (const line of lines.filter((l) => l.includes('{ a: number }'))) {
    const at = base.split('\n').indexOf(line) + 1;
    const edit = (to: string): string => base.replace(line, line.replace('{ a: number }', to));
    for (const to of ['{ a: number; b?: string }', '{ a: number, b?: string }', '{ a?: number }']) {
      expect(problemsOf(base, edit(to)), `${line} → ${to}`).toEqual([]);
    }
    for (const to of ['{ a: number; b: string }', '{ a: number, b: string }']) {
      expect(problemsOf(base, edit(to)), `${line} → ${to}`).toEqual([
        `head:${at} a required member inserted (only an optional one, \`x?: T\`)`,
      ]);
    }
    expect(problemsOf(base, edit('{ a: number\n  b: string\n}')), line).toEqual([
      `head:${at + 1} a required member inserted (only an optional one, \`x?: T\`)`,
    ]);
  }
}

/** Each line holds one `{ a: 1 }` leaf in a value: a property appended passes (P2). */
function valueLeaves(lines: readonly string[]): void {
  const base = [...PRELUDE, ...lines, ''].join('\n');
  for (const line of lines.filter((l) => l.includes('{ a: 1 }'))) {
    const head = base.replace(line, line.replace('{ a: 1 }', '{ a: 1, b: 2 }'));
    expect(problemsOf(base, head), line).toEqual([]);
  }
}

it('[CT-06zzzzzn] conditionalType: a check type that is a function type (no / with parameters, generic, new / abstract new, a generic return, a function type returning one) keeps both branches types', () => {
  typeLeaves([
    'export type R1<T> = T extends () => void ? [{ a: number }] : never;',
    'export type R2<T> = T extends (x: A, y: string) => B ? { a: number } : never;',
    'export type R3<T> = T extends (x: A) => B ? { other: boolean } : { a: number };',
    'export type R4<T> = T extends <U>(x: U) => U ? never : [{ a: number }];',
    'export type R5<T> = T extends new () => B ? [{ a: number }] : never;',
    'export type R6<T> = T extends abstract new () => B ? [{ a: number }] : never;',
    'export type R7<T> = T extends (x: A) => Promise<B> ? [{ a: number }] : never;',
    'export type R8<T> = T extends () => () => void ? [{ a: number }] : never;',
    'export type R9<T> = T extends (x: { a: number }) => B ? 1 : 2;',
  ]);
});

it('[CT-06zzzzzn] conditionalType: an arrow function before a conditional expression is no check type — a generic arrow whose type parameter extends (also a function type constraint), a plain, curried, async or return-typed arrow — its branches stay P2', () => {
  valueLeaves([
    'export const h = <T extends A>(x: T) => cond ? [{ a: 1 }] : [];',
    'export const i = <T extends A>(x: T) => cond ? [] : [{ a: 1 }];',
    'export const w = <T extends (x: A) => B>(t: T) => cond ? [{ a: 1 }] : [];',
    'export const g = (x: A) => cond ? [{ a: 1 }] : [];',
    'export const k = (a: A) => (b: A) => cond ? [{ a: 1 }] : [];',
    'export const m = async (x: A) => cond ? [{ a: 1 }] : [];',
    'export const e = (x: A): B => cond ? [{ a: 1 }] : [];',
    'export const s = (x: A) => cond;',
    'export const t = cond ? [{ a: 1 }] : [];',
  ]);
});

it('[CT-06zzzzzn] typeDefault: a type parameter default is a type — alias, interface, function, generator, class, class expression, arrow, function type, method, call signature, after nested type arguments, a later parameter, a list over lines', () => {
  typeLeaves([
    'export type Box<T = { a: number }> = T;',
    'export type Pair<U, T = [{ a: number }]> = T;',
    'export interface I<T = { a: number }> { value: T; }',
    'export function f<T = { a: number }>() {}',
    'export function* gen<T = { a: number }>() {}',
    'export class C<T = { a: number }> {}',
    'export const K = class<T = { a: number }> {};',
    'export const arrow = <T = { a: number }>() => raw;',
    'export type Fn = <T extends Map<A, B> = { a: number }>() => void;',
    'export class M { m<T = { a: number }>() {} }',
    'export interface S { <T = { a: number }>(x: T): void; }',
    'export type Many<',
    '  U,',
    '  T = { a: number },',
    '> = [U, T];',
  ]);
});

it('[CT-06zzzzzn] typeDefault: a value default stays P2 — a function, arrow or method parameter default, a destructuring default, a declarator after a less-than comparison', () => {
  valueLeaves([
    'export function withDefault(x = { a: 1 }) { void x; }',
    'export const arrowDefault = (x = { a: 1 }) => x;',
    'export class P { m(x = { a: 1 }) { void x; } }',
    'export const { k = { a: 1 } } = raw;',
    'export const less = cond < raw, after = { a: 1 };',
    'export const generic = <T,>(x: T, y = { a: 1 }) => [x, y];',
  ]);
});

/** The contextual keywords a module may use as a variable name (support-tokens.ts CONTEXTUAL). */
const CONTEXTUAL_WORDS = [
  'async',
  'of',
  'from',
  'type',
  'declare',
  'abstract',
  'namespace',
  'readonly',
  'keyof',
];

it('[CT-06zzzzzn] contextualName: a contextual keyword used as a variable name where an operand starts (after =, (, a comma, return, ?, :) admits as / satisfies as the type operator: its type is P3', () => {
  for (const w of CONTEXTUAL_WORDS) {
    typeLeaves([
      `export const v = ${w} as [{ a: number }];`,
      `export const s = f(${w} satisfies { a: number });`,
      `export const l = [raw, ${w} as { a: number }];`,
      `export function r() { return ${w} as [{ a: number }]; }`,
      `export const t = cond ? ${w} as [{ a: number }] : raw;`,
      `export const u = cond ? raw : ${w} satisfies { a: number };`,
    ]);
  }
});

it('[CT-06zzzzzn] contextualName: the keyword readings stay — of after an operand is the for-of keyword (the name as after it is indexed, its object P2), declaration and modifier keywords at a statement or member start, an async method named as', () => {
  valueLeaves([
    'for (const x of as[{ a: 1 }.a]) void x;',
    'async function load() { return [{ a: 1 }]; }',
    "import x from './m.ts'; export const fromValue = [{ a: 1 }];",
    'export class R { readonly as = [{ a: 1 }]; }',
    'export const o = { x: 1, async as() { return [{ a: 1 }]; } };',
    'export const arrowAs = async as => [{ a: 1 }];',
  ]);
  typeLeaves([
    'type T = [{ a: number }];',
    'declare const d: [{ a: number }];',
    'export abstract class Q { abstract m(): { a: number }; }',
    'export type Ro = { readonly as: { a: number } };',
  ]);
});

it('[CT-06zzzzzn] contextualName: the type skipped after `<word> as` hides no declarator — a name the base holds after it is still refused on its line', () => {
  for (const w of CONTEXTUAL_WORDS) {
    const first = `const v = ${w} as Record<string, { a: number }>,`;
    expect(appended(`${first} dup = 1;`), first).toEqual([COMMA, holds(AT)]);
    expect(appended(`${first}\n  dup = 1;`), first).toEqual([COMMA, holds(AT + 1)]);
  }
});

// CT-06zzzzzn code review r1 (S2): a contextual keyword used as a variable name at the start of
// a statement (after `;`, `{`, `}`, at a line break where a statement ends) before as / satisfies.

it('[CT-06zzzzzn] review r1: a contextual keyword used as a variable name at the start of a statement (after ;, {, }, a line break ending the statement before) admits as / satisfies as the type operator: its type is P3', () => {
  for (const w of CONTEXTUAL_WORDS) {
    typeLeaves([
      `declare const d0: never; ${w} as [0, { a: number }];`,
      `${w} as [{ a: number }];`,
      'export const before = raw',
      `${w} satisfies [string, { a: number }]`,
      `{ ${w} satisfies { a: number }; }`,
      `if (cond) {} ${w} as { a: number };`,
    ]);
  }
});

it('[CT-06zzzzzn] review r1: the keyword readings at the start of a statement stay — a type alias named as, an async arrow with a parameter named as, declare / abstract / namespace declarations, readonly in members, of after an object or array pattern', () => {
  typeLeaves([
    'type as = { a: number };',
    'declare const declared: { a: number };',
    'declare namespace NS { const inner: { a: number }; }',
    'export abstract class Q2 { abstract m(): { a: number }; }',
    'export type Members = { readonly as: { a: number }; readonly x?: { a: number } };',
  ]);
  valueLeaves([
    'async as => [{ a: 1 }];',
    'export const asyncArrow = async as => [{ a: 1 }];',
    'namespace NV { export const v = [{ a: 1 }]; }',
    'export class R2 { readonly as = [{ a: 1 }]; readonly as2 = [0]; }',
    'for (const { a } of as[{ a: 1 }.a]) void a;',
    'for (const [a] of as[{ a: 1 }.a]) void a;',
    'for (const { a }\n  of as[{ a: 1 }.a]) void a;',
    'for (const x\n  of as[{ a: 1 }.a]) void x;',
    'for await (const { a } of as[{ a: 1 }.a]) void a;',
  ]);
});

// CT-06zzzzzo (D10-1989): member signatures without a body (memberParams), the object type after
// a function type's `=>` (Tree.arrowType), a defaulted interface's body (headerKeyword), a
// line-leading `as` / `satisfies` (no type operator, as in TypeScript), `as[n]` an index. Each
// item pairs what this change turns (`now`) with what it must leave as it was (`kept`): the
// kept rows were refused (or allowed) before CT-06zzzzzo and still are — no write refused before
// becomes allowed but the fixed false refusals themselves.

const GAPS = [
  'declare const raw: never;',
  'declare const cond: boolean;',
  'declare const n: number;',
  'declare function ping(): void;',
  'declare function f(x: unknown): void;',
  'declare function as<T>(x: T): T;',
  'let dup = 1;',
];
const REQUIRED = 'a required member inserted (only an optional one, `x?: T`)';

/** The problems of GAPS + rows → the same with `from` replaced once by `to`. */
function gap(rows: readonly string[], from: string, to: string): string[] {
  const base = [...GAPS, ...rows, ''].join('\n');
  const at = base.indexOf(from);
  expect(at >= 0 && base.indexOf(from, at + 1) < 0, from).toBe(true);
  return problemsOf(base, `${base.slice(0, at)}${to}${base.slice(at + from.length)}`);
}

/** Whether `problems` name the head line `line` (1-based in the head), with `reason` in it. */
function names(problems: readonly string[], line: number, reason = ''): boolean {
  return problems.some((p) => p.startsWith(`head:${line} `) && p.includes(reason));
}

/** The 1-based line of GAPS + rows on which `row` starts. */
const gapLine = (rows: readonly string[], row: string): number =>
  [...GAPS, ...rows.slice(0, rows.indexOf(row))].join('\n').split('\n').length + 1;

const SIGNATURES = [
  'interface I { m(x: { a: number }): void; }',
  'interface C { (x: { a: number }): void; new (x: { a: number }): C; }',
  'interface G { get<T>(x: { a: T }): T; delete?(x: { a: number }): void; }',
  'abstract class A { abstract m(x: { a: number }): void; }',
  'class O { over(x: { a: number }): void; over(x: unknown) { void x; } }',
  'class M { m<T>(x: { a: T }) { void x; } }',
  'type T = { m(x: { a: number }): void };',
];

it('[CT-06zzzzzo] ① now: a member signature without a body (interface, call / construct signature, abstract, overload, generic method, type literal) judges its parameter types by P3 and appends only optional parameters — a required member or parameter, allowed before, is refused', () => {
  for (const row of SIGNATURES) {
    const line = gapLine(SIGNATURES, row);
    const leaf = row.includes('a: T') ? '{ a: T }' : '{ a: number }';
    const member = (to: string): string[] => gap(SIGNATURES, row, row.replace(leaf, to));
    expect(member(leaf.replace(' }', ', b: string }')), row).toEqual([`head:${line} ${REQUIRED}`]);
    expect(member(leaf.replace(' }', '\n  b: string }')), row).toEqual([
      `head:${line + 1} ${REQUIRED}`,
    ]);
    // A required parameter (an argument of a call before) appended to the list.
    const appended = gap(SIGNATURES, row, row.replace(`${leaf})`, `${leaf}, y)`));
    expect(names(appended, line, 'a required parameter inserted'), row).toBe(true);
    // Correct P3 / P2 in a parameter list (refused as a value before): optional ones pass.
    expect(member(leaf.replace(' }', '; b?: string }')), row).toEqual([]);
    expect(gap(SIGNATURES, row, row.replace(`(x: ${leaf}`, `(x?: ${leaf}`)), row).toEqual([]);
    expect(gap(SIGNATURES, row, row.replace(`${leaf})`, `${leaf}, y?: number)`)), row).toEqual([]);
  }
});

it('[CT-06zzzzzo] ① kept: calls and values stay P2 — a call argument, an object method with a body, a call statement in a block, a class field, a decorator, a `case (x):` — and a statement split off a member, a parameter name pushed on, a block after a class stay refused', () => {
  const rows = [
    'ping(); f({ a: 1 });',
    'const o = { m(x: number): number { return x; }, k: f({ a: 1 }) };',
    'class P { x = f({ a: 1 }); }',
    'if (cond) { f({ a: 1 }); }',
    'switch (n) { case (1): f({ a: 1 }); }',
    'interface S { m(only: number): void; get(k: string): number; }',
    'class K {}',
    'function after() { ping(); }',
  ];
  for (const row of rows.slice(0, 5)) {
    expect(gap(rows, row, row.replace('{ a: 1 }', '{ a: 1, b: 2 }')), row).toEqual([]);
    expect(gap(rows, row, row.replace('{ a: 1 }', '{ a: 1, b?: 2 }')), row).not.toEqual([]);
  }
  const s = 'interface S { m(only: number): void; get(k: string): number; }';
  const at = gapLine(rows, s);
  // `m; (x…)` would make a property and a call signature of one method.
  for (const to of [s.replace('m(only', 'm; (only'), s.replace('get(k', 'get, (k')]) {
    expect(names(gap(rows, s, to), at, 'changed its meaning'), to).toBe(true);
  }
  // A signature's parameter is no local of the file (D10-1888 ③): no push on it.
  const end = 'function after() { ping(); }';
  expect(names(gap(rows, end, `${end}\nonly.push(1);`), at + 3, 'is no const, let')).toBe(true);
  // A call statement in a block gains no return type; a body after a class is no class body.
  expect(gap(rows, 'if (cond) { f(', 'if (cond) { f(raw): void; f(')).not.toEqual([]);
  expect(gap(rows, end, 'function after() { ping(\n  b?: string); }')).not.toEqual([]);
  expect(gap(rows, end, 'function after() { ping(); const extra = 2; }')).toEqual([]);
});

const RETURNS = [
  'type F = () => { a: number };',
  'type K = new () => { a: number };',
  'let ann: (x: number) => { a: number } = raw;',
  'function cb(c: () => { a: number }) { void c; }',
  'const typed = raw as () => { a: number };',
];

it('[CT-06zzzzzo] ② now: the object type after the => of a function type (an alias, a constructor type, an annotation, a parameter type, after as) takes optional members (refused as statements before); a required member and a statement are refused', () => {
  for (const row of RETURNS) {
    const line = gapLine(RETURNS, row);
    const edit = (to: string): string[] => gap(RETURNS, row, row.replace('{ a: number }', to));
    expect(edit('{ a: number; b?: string }'), row).toEqual([]);
    expect(edit('{ a: number, b?: string }'), row).toEqual([]);
    expect(edit('{ a?: number }'), row).toEqual([]);
    expect(edit('{ a: number; b: string }'), row).toEqual([`head:${line} ${REQUIRED}`]);
    expect(edit('{ a: number\n  b: string\n}'), row).toEqual([`head:${line + 1} ${REQUIRED}`]);
    // A statement in it (P1 in the block it was read as before) is refused now.
    expect(edit('{ a: number; ping(); }'), row).not.toEqual([]);
    expect(edit('{ a: number; const extra = 2; }'), row).not.toEqual([]);
  }
});

const ARROWS = [
  'const g = () => { ping(); };',
  'f(() => { ping(); });',
  'const h = (x: number): number => { ping(); return x; };',
  'const lt = n < (() => { ping(); });',
  'const tern = cond ? () => { ping(); } : null;',
  'class X extends (() => { ping(); return Object; })() {}',
  'export default () => { ping(); };',
  'const gen = <T,>(x: T) => { ping(); return x; };',
  'const o = { k: () => { ping(); } };',
];

it('[CT-06zzzzzo] ② kept: an arrow function body in a value (or an ambiguous place: after <, a class heritage) stays a block judged by P1 — a statement passes, an optional member, an assignment or a let are refused as before', () => {
  for (const row of ARROWS) {
    const line = gapLine(ARROWS, row);
    const edit = (to: string): string[] => gap(ARROWS, row, row.replace('ping();', to));
    expect(edit('ping(); const extra = 2;'), row).toEqual([]);
    expect(edit('ping(); ping();'), row).toEqual([]);
    expect(names(edit('ping();\n  b?: string;'), line + 1), row).toBe(true);
    expect(names(edit('ping();\n  dup = 2;'), line + 1, 'an assignment'), row).toBe(true);
    expect(names(edit('ping();\n  let extra = 2;'), line + 1), row).toBe(true);
  }
});

it('[CT-06zzzzzo] ③ now: a conditional type whose check type is a function type returning an object type keeps both branches types (P3); a conditional expression stays P2', () => {
  const rows = [
    'type R<T> = T extends () => { a: 1 } ? [{ a: number }] : never;',
    'type S<T> = T extends (x: A) => { a: 1 } ? never : [{ a: number }];',
    'type A = number;',
    'const v = cond ? [{ a: 1 }] : [];',
  ];
  for (const row of rows.slice(0, 2)) {
    const line = gapLine(rows, row);
    const edit = (to: string): string[] =>
      gap(rows, row, row.replace('[{ a: number }]', `[${to}]`));
    expect(edit('{ a: number; b?: string }'), row).toEqual([]);
    expect(edit('{ a: number, b: string }'), row).toEqual([`head:${line} ${REQUIRED}`]);
    // The check type's object type itself is a type literal now.
    expect(gap(rows, row, row.replace('{ a: 1 }', '{ a: 1; b?: 2 }')), row).toEqual([]);
    expect(gap(rows, row, row.replace('{ a: 1 }', '{ a: 1; b: 2 }')), row).toEqual([
      `head:${line} ${REQUIRED}`,
    ]);
  }
  const value = 'const v = cond ? [{ a: 1 }] : [];';
  expect(gap(rows, value, value.replace('{ a: 1 }', '{ a: 1, b: 2 }'))).toEqual([]);
});

const AS_CALLS = [
  'export const v = raw\nas({ a: 1 });',
  'export const w = raw\nsatisfies({ a: 1 });',
  'const typed = raw\nas<[{ a: number }]>(raw);',
];

it('[CT-06zzzzzo] ④ now: an existing line-leading as / satisfies is a call of that name (TypeScript ends the statement before it): its object argument takes a P2 property, and a whole statement may stand before it (both refused as a type assertion before)', () => {
  for (const row of AS_CALLS.slice(0, 2)) {
    expect(gap(AS_CALLS, row, row.replace('{ a: 1 }', '{ a: 1, b: 2 }')), row).toEqual([]);
    expect(gap(AS_CALLS, row, row.replace('raw\n', 'raw\nping();\n')), row).toEqual([]);
    expect(gap(AS_CALLS, row, row.replace('raw\n', 'raw\nconst extra = 2\n')), row).toEqual([]);
  }
});

it('[CT-06zzzzzo] ④ now refused (allowed before): the object of a line-leading call takes no optional member or ? mark (a value); a line break added before an existing as / satisfies, or removed, changes its meaning; an inserted line-leading as after an operand names why', () => {
  const rows = ['export const before = raw'];
  const line = gapLine(rows, 'export const before = raw') + 1;
  expect(
    names(
      gap(rows, 'export const before = raw', 'export const before = raw\nas(raw)'),
      line,
      'inserted at the start of a line after an operand',
    ),
  ).toBe(true);
  // The object after a line-leading call is a value: no optional member, no ? mark.
  const call = 'export const v = raw\nas({ a: 1 });';
  expect(gap(AS_CALLS, call, call.replace('{ a: 1 }', '{ a: 1, b?: 2 }'))).not.toEqual([]);
  expect(gap(AS_CALLS, call, call.replace('{ a: 1 }', '{ a?: 1 }'))).not.toEqual([]);
  // The operator turned into a name (a re-wrap) or back (a join): existing code changed.
  const typed = ['const w = raw as { a: number };', 'const c = raw\nas(n);'];
  const w = gapLine(typed, 'const w = raw as { a: number };');
  expect(gap(typed, 'raw as {', 'raw\nas {')).toEqual([
    `head:${w + 1} \`as\` changed its meaning (a type operator → a name)`,
  ]);
  expect(gap(typed, 'raw\nas(n)', 'raw as(n)')).toEqual([
    `head:${w + 1} \`as\` changed its meaning (a name → a type operator)`,
  ]);
});

it('[CT-06zzzzzo] ④ kept: a line-leading as / satisfies inserted after an operand is refused on its line (also a call P1 would take); type arguments of a line-leading call stay P3; after a block it is a statement as before', () => {
  const rows = ['export const before = raw', 'if (cond) { ping(); }'];
  const line = gapLine(rows, 'export const before = raw') + 1;
  for (const added of [
    'as(dup = 2)',
    'as < 1, dup = 2',
    'as < 1',
    'as({ a: 1, b: 2 })',
    'as(raw)',
    'satisfies(raw)',
  ]) {
    const got = gap(rows, 'export const before = raw', `export const before = raw\n${added}`);
    expect(names(got, line), added).toBe(true);
  }
  const block = 'if (cond) { ping(); }';
  expect(gap(rows, block, `${block}\nas(raw)`)).toEqual([]);
  // Type arguments of the line-leading call stay a type.
  const generic = 'const typed = raw\nas<[{ a: number }]>(raw);';
  const at = gapLine(AS_CALLS, generic) + 1;
  expect(
    gap(AS_CALLS, generic, generic.replace('{ a: number }', '{ a: number, b: string }')),
  ).toEqual([`head:${at} ${REQUIRED}`]);
  expect(
    gap(AS_CALLS, generic, generic.replace('{ a: number }', '{ a: number, b?: string }')),
  ).toEqual([]);
});

const DEFAULTED = [
  'interface I<T = { a: number }> { value: T; }',
  'interface J<U, T = [{ a: number }]> extends Array<U | T> { value: T; }',
  'interface K<T extends A | B = A> { value: T; }',
  'type A = number;',
  'type B = string;',
];

it('[CT-06zzzzzo] ⑤ now: the body of an interface with a defaulted (or union-constrained) type parameter is a type body — an optional member passes (refused as a statement before), a required member and a statement are refused', () => {
  for (const row of DEFAULTED.slice(0, 3)) {
    const line = gapLine(DEFAULTED, row);
    const body = (to: string): string[] => gap(DEFAULTED, row, row.replace('{ value: T; }', to));
    expect(body('{ value: T; b?: string; }'), row).toEqual([]);
    expect(body('{\n  b?: string;\n  value: T; }'), row).toEqual([]);
    expect(body('{ value?: T; }'), row).toEqual([]);
    expect(body('{ value: T; b: string; }'), row).toEqual([`head:${line} ${REQUIRED}`]);
    expect(body('{\n  b: string;\n  value: T; }'), row).toEqual([`head:${line + 1} ${REQUIRED}`]);
    expect(body('{ value: T; ping(); }'), row).not.toEqual([]);
    expect(body('{ value: T; const extra = 2; }'), row).not.toEqual([]);
  }
  // A class with a defaulted type parameter reads its member signatures (①).
  const rows = [
    'class Q<T = { a: number }> { m(x: { a: number }): void; m(x: unknown) { void x; } }',
  ];
  const q = rows[0] as string;
  expect(gap(rows, q, q.replace('m(x: { a: number })', 'm(x: { a: number, b: string })'))).toEqual([
    `head:${gapLine(rows, q)} ${REQUIRED}`,
  ]);
});

it('[CT-06zzzzzo] ⑤ kept: a function or block after a defaulted interface or class is no type or class body (the header walk stops at the body before)', () => {
  const rows = [
    'interface I<T = { a: number }> { value: T; }',
    'function make() { ping(); }',
    'class Q<T = { a: number }> { m(x: { a: number }): void; m(x: unknown) { void x; } }',
    'if (cond) { ping(); }',
  ];
  for (const row of ['function make() { ping(); }', 'if (cond) { ping(); }']) {
    const line = gapLine(rows, row);
    expect(gap(rows, row, row.replace('ping();', 'ping(); const extra = 2;')), row).toEqual([]);
    expect(names(gap(rows, row, row.replace('ping();', 'ping();\n  b?: string;')), line + 1)).toBe(
      true,
    );
    expect(gap(rows, row, row.replace('ping()', 'ping(\n  b?: string)')), row).not.toEqual([]);
  }
});

it('[CT-06zzzzzo] ⑥ an insertion into the index after a variable named as / satisfies is refused as an index (the message only: refused as an array before); an array literal keeps its wording, a type after as[ stays P3', () => {
  const rows = [
    'declare const as: number[];',
    'declare const satisfies: number[];',
    'const v = as[n];',
    'const w = satisfies[n];',
    'const other = raw[n];',
    'const values = [n];',
    'type X = as[{ a: number }];',
  ];
  for (const row of ['const v = as[n];', 'const w = satisfies[n];', 'const other = raw[n];']) {
    expect(gap(rows, row, row.replace('[n]', '[n\n  + 1\n]')), row).toEqual([
      `head:${gapLine(rows, row) + 1} \`+\` inserted into an index (not on the allow list)`,
    ]);
  }
  const array = 'const values = [n];';
  expect(gap(rows, array, array.replace('[n]', '[n\n  + 1\n]'))).toEqual([
    `head:${gapLine(rows, array) + 1} \`+\` inserted into an existing array (not on the allow list)`,
  ]);
  const typed = 'type X = as[{ a: number }];';
  expect(gap(rows, typed, typed.replace('{ a: number }', '{ a: number, b: string }'))).toEqual([
    `head:${gapLine(rows, typed)} ${REQUIRED}`,
  ]);
});

// CT-06zzzzzp (D10-2007): two P3 leniencies closed in every type position — A1 a lone separator
// inside a member of a member list (allowListProblems list), A2 `?:` or a second
// annotation in an annotation (typeSpan, annotation) — plus B a class field's annotation
// (Tree.classField), C an annotated optional method signature in a type literal (memberParams,
// Tree.annotatedParams) and D the header walk ending at an earlier declaration's body
// (headerKeyword). `now` rows changed their decision; `kept` rows decide as before.

const STRAY = [
  'type T = { a: number };',
  'type U = {\n  a: number\n  b: string\n};',
  'interface I { value: T; }',
];

it('[CT-06zzzzzp] A1 now: a lone separator inside an existing member (before its colon, after it) or an inserted member followed by an existing token that starts no member is refused on its line', () => {
  const t = 'type T = { a: number };';
  const line = gapLine(STRAY, t);
  for (const to of ['{ a\n;\n: number }', '{ a\n,\n: number }', '{ a:\n;\nnumber }']) {
    expect(gap(STRAY, t, t.replace('{ a: number }', to)), to).toEqual([
      `head:${line + 1} a lone separator \`${to.includes(',') ? ',' : ';'}\` inserted inside an existing member (no member before or after it, CT-06zzzzzp)`,
    ]);
  }
  const i = 'interface I { value: T; }';
  expect(names(gap(STRAY, i, i.replace('value: T', 'value\n;\n: T')), gapLine(STRAY, i) + 1)).toBe(
    true,
  );
  // An optional member put before an existing `: number` swallows no annotation.
  expect(gap(STRAY, t, t.replace('{ a: number }', '{ a\n; b?: string\n: number }'))).not.toEqual(
    [],
  );
});

it('[CT-06zzzzzp] A1 kept: a separator after a whole member — trailing (P4), between members on their own lines, before an inserted optional member — still passes; a second separator stays refused', () => {
  const t = 'type T = { a: number };';
  for (const to of ['{ a: number\n;\n }', '{ a: number\n,\n }', '{ a: number; }']) {
    expect(gap(STRAY, t, t.replace('{ a: number }', to)), to).toEqual([]);
  }
  expect(gap(STRAY, t, t.replace('{ a: number }', '{ a: number\n; b?: string\n }'))).toEqual([]);
  const u = 'type U = {\n  a: number\n  b: string\n};';
  expect(gap(STRAY, u, u.replace('a: number\n', 'a: number;\n'))).toEqual([]);
  expect(gap(STRAY, u, u.replace('a: number\n', 'a: number\n  c?: string\n'))).toEqual([]);
  expect(gap(STRAY, t, t.replace('{ a: number }', '{ a: number;\n; }'))).toEqual([
    `head:${gapLine(STRAY, t) + 1} \`;\` inserted off the allow list (CT-06zzzzzj: positions P1–P4 × the expression grammar)`,
  ]);
});

it('[CT-06zzzzzp] A2 now: `?:` or a second annotation in an inserted member type, or an annotation inserted before an existing one (a variable, a parameter, a return type), is refused on its line', () => {
  const t = 'type T = { a: number };';
  const line = gapLine(STRAY, t);
  for (const to of ['{ a: number; b?: void: string }', '{ a: number; b?: ?: string }']) {
    const got = gap(STRAY, t, t.replace('{ a: number }', to));
    expect(names(got, line, 'outside a conditional type'), to).toBe(true);
  }
  const rows = [
    'let v: { a: number };',
    'function p(y: { a: number }) { void y; }',
    'interface S { m(x: number): void }',
  ];
  for (const [row, from] of [
    ['let v: { a: number };', 'v: {'],
    ['function p(y: { a: number }) { void y; }', 'y: {'],
    ['interface S { m(x: number): void }', 'x: number'],
    ['interface S { m(x: number): void }', '): void'],
  ] as const) {
    const at = gapLine(rows, row) + 1;
    const [name, rest] = [from.slice(0, from.indexOf(':')), from.slice(from.indexOf(':'))];
    for (const extra of [':?', ': string']) {
      const got = gap(rows, row, row.replace(from, `${name}\n${extra}\n${rest}`));
      expect(names(got, at), `${row} ${extra}`).toBe(true);
    }
  }
});

it('[CT-06zzzzzp] A2 kept: an annotation inserted on a parameter or a variable, an optional member with a plain type, still pass; an inserted conditional stays refused by rule 2', () => {
  const rows = ['function q(y) { void y; }', 'let w = 1;', 'type T = { a: number };'];
  expect(gap(rows, '(y)', '(y: number)')).toEqual([]);
  expect(gap(rows, '(y)', '(y?: { a: number })')).toEqual([]);
  expect(gap(rows, 'let w = 1', 'let w: number = 1')).toEqual([]);
  expect(gap(rows, '{ a: number }', '{ a: number; b?: string | number }')).toEqual([]);
  expect(
    names(
      gap(rows, '{ a: number }', '{ a: number; b?: A extends B ? C : D }'),
      gapLine(rows, 'type T = { a: number };'),
      'a conditional',
    ),
  ).toBe(true);
});

const FIELDS = [
  'class C { x: { a: number } }',
  'class S { static readonly z!: { a: number }; }',
  "class K { ['k']: { a: number }; }",
  'class Cb { cb: () => { a: number }; }',
  'class P { x = cond ? raw : { a: 1 }; }',
  'class Q { x = { a: 1 }; }',
];

it('[CT-06zzzzzp] B now: the object type of a class field annotation (modifiers, a definite !, a computed name, after a function type =>) takes only optional members', () => {
  for (const [row, leaf] of [
    ['class C { x: { a: number } }', '{ a: number }'],
    ['class S { static readonly z!: { a: number }; }', '{ a: number }'],
    ["class K { ['k']: { a: number }; }", '{ a: number }'],
    ['class Cb { cb: () => { a: number }; }', '{ a: number }'],
  ] as const) {
    const line = gapLine(FIELDS, row);
    const edit = (to: string): string[] => gap(FIELDS, row, row.replace(leaf, to));
    expect(edit('{ a: number, b: string }'), row).toEqual([`head:${line} ${REQUIRED}`]);
    expect(edit('{ a: number; b?: string }'), row).toEqual([]);
    expect(edit('{ a: number, b?: string }'), row).toEqual([]);
  }
  const cb = 'class Cb { cb: () => { a: number }; }';
  expect(gap(FIELDS, cb, cb.replace('{ a: number }', '{ a: number; ping(); }'))).not.toEqual([]);
});

it('[CT-06zzzzzp] B kept: an object in a field initializer (also a conditional branch) stays a value judged by P2', () => {
  for (const row of ['class P { x = cond ? raw : { a: 1 }; }', 'class Q { x = { a: 1 }; }']) {
    expect(gap(FIELDS, row, row.replace('{ a: 1 }', '{ a: 1, b: 2 }')), row).toEqual([]);
    expect(gap(FIELDS, row, row.replace('{ a: 1 }', '{ a: 1, b?: 2 }')), row).not.toEqual([]);
  }
});

const OPTIONAL_METHODS = [
  'type M = { m?(x: { a: number }): void };',
  'type R = { m?(x: { a: number }): () => void };',
  'type N = { m?(x): string };',
  'if (cond) { cond ? (raw) : raw; }',
];

it('[CT-06zzzzzp] C now: an optional method signature with an annotated parameter in a type literal reads its parameter list: P3 in its types, only optional parameters appended', () => {
  for (const row of OPTIONAL_METHODS.slice(0, 2)) {
    const line = gapLine(OPTIONAL_METHODS, row);
    const edit = (to: string): string[] =>
      gap(OPTIONAL_METHODS, row, row.replace('{ a: number }', to));
    expect(edit('{ a: number, b: string }'), row).toEqual([`head:${line} ${REQUIRED}`]);
    expect(edit('{ a: number; b?: string }'), row).toEqual([]);
    expect(
      gap(OPTIONAL_METHODS, row, row.replace('{ a: number })', '{ a: number }, y?: number)')),
      row,
    ).toEqual([]);
  }
});

it('[CT-06zzzzzp] C kept: an unannotated optional method signature and a parenthesized conditional branch stay parentheses — an inserted annotation or parameter is refused', () => {
  const n = 'type N = { m?(x): string };';
  const line = gapLine(OPTIONAL_METHODS, n);
  for (const to of ['m?(x: string)', 'm?(x, y?: string)']) {
    expect(names(gap(OPTIONAL_METHODS, n, n.replace('m?(x)', to)), line), to).toBe(true);
  }
  const block = 'if (cond) { cond ? (raw) : raw; }';
  expect(
    names(
      gap(OPTIONAL_METHODS, block, block.replace('(raw)', '(raw, b)')),
      gapLine(OPTIONAL_METHODS, block),
    ),
  ).toBe(true);
});

const AFTER_DECLARATIONS = [
  'interface X { a: number }\nfunction g() { ping(); }',
  'enum E { A } if (cond) { ping(); }',
  'interface Y { a: number } while (cond) { ping(); }',
  'class Z { a = 1 }\nfunction h() { ping(); }',
];

it('[CT-06zzzzzp] D now: a function body or if / while block right after an interface or enum is a block — a call statement passes, a member-shaped statement is refused', () => {
  for (const [row, body] of [
    ['interface X { a: number }\nfunction g() { ping(); }', 'g() { ping(); }'],
    ['enum E { A } if (cond) { ping(); }', 'if (cond) { ping(); }'],
    ['interface Y { a: number } while (cond) { ping(); }', 'while (cond) { ping(); }'],
  ] as const) {
    const at = gapLine(AFTER_DECLARATIONS, row) + (row.includes('\n') ? 1 : 0);
    const edit = (to: string): string[] =>
      gap(AFTER_DECLARATIONS, body, body.replace('ping();', to));
    expect(edit('ping(); ping();'), row).toEqual([]);
    expect(names(edit('ping(); b: 1;'), at), row).toBe(true);
    expect(names(edit('ping(); b?: string;'), at), row).toBe(true);
  }
});

it('[CT-06zzzzzp] D kept: the interface body itself and a function body after a class decide as before', () => {
  const x = 'interface X { a: number }';
  const line = gapLine(AFTER_DECLARATIONS, 'interface X { a: number }\nfunction g() { ping(); }');
  expect(gap(AFTER_DECLARATIONS, `${x}\n`, `${x.replace(' }', '; b?: string }')}\n`)).toEqual([]);
  expect(gap(AFTER_DECLARATIONS, `${x}\n`, `${x.replace(' }', '; b: string }')}\n`)).toEqual([
    `head:${line} ${REQUIRED}`,
  ]);
  const h = 'h() { ping(); }';
  expect(gap(AFTER_DECLARATIONS, h, h.replace('ping();', 'ping(); ping();'))).toEqual([]);
});

// CT-06zzzzzp, independent Claude money r1 (two S2 in list(), members): a run that follows no
// separator and no `{` must stand after a whole member — not inside a wrapped annotation, not
// between a modifier and its member's name.

const WRAPPED = [
  'type T = {\n  a:\n    number\n};',
  'interface I {\n  value:\n    T;\n}',
  'interface R { readonly a: number }',
  'type Q = { readonly [k: string]: number };',
  'type W = { readonly };',
];

it('[CT-06zzzzzp] r1 now: a member inserted on its own line inside a wrapped annotation, or a separator / member inserted between a modifier and its name, is refused on its line', () => {
  for (const [row, from] of [
    ['type T = {\n  a:\n    number\n};', '  a:\n'],
    ['interface I {\n  value:\n    T;\n}', '  value:\n'],
  ] as const) {
    const at = gapLine(WRAPPED, row) + 2;
    for (const added of ['    b?: string\n', '    b?: string;\n']) {
      expect(names(gap(WRAPPED, row, row.replace(from, `${from}${added}`)), at), row).toBe(true);
    }
  }
  for (const [row, from] of [
    ['interface R { readonly a: number }', 'readonly a'],
    ['type Q = { readonly [k: string]: number };', 'readonly ['],
  ] as const) {
    const at = gapLine(WRAPPED, row) + 1;
    for (const added of [';', ',', 'b?: string;']) {
      const to = from.replace('readonly ', `readonly\n${added}\n`);
      expect(names(gap(WRAPPED, row, row.replace(from, to)), at, 'the modifier'), added).toBe(true);
    }
  }
});

it('[CT-06zzzzzp] r1 kept: an optional member before or after a wrapped member, after a modified member, and a trailing separator after a member named readonly still pass', () => {
  const t = 'type T = {\n  a:\n    number\n};';
  expect(gap(WRAPPED, t, t.replace('{\n', '{\n  b?: string;\n'))).toEqual([]);
  expect(gap(WRAPPED, t, t.replace('number\n', 'number\n  b?: string\n'))).toEqual([]);
  const i = 'interface I {\n  value:\n    T;\n}';
  expect(gap(WRAPPED, i, i.replace('T;\n', 'T;\n  b?: string;\n'))).toEqual([]);
  const r = 'interface R { readonly a: number }';
  expect(gap(WRAPPED, r, r.replace('number }', 'number; b?: string }'))).toEqual([]);
  expect(gap(WRAPPED, r, r.replace('{ readonly', '{ b?: string; readonly'))).toEqual([]);
  const w = 'type W = { readonly };';
  expect(gap(WRAPPED, w, w.replace('readonly }', 'readonly\n;\n }'))).toEqual([]);
  expect(gap(WRAPPED, w, w.replace('readonly }', 'readonly; b?: string }'))).toEqual([]);
});

// CT-06zzzzzp, independent Claude money r2 (S2 in list(), members): a type operator word
// (keyof typeof unique infer new extends is asserts readonly) ends no member unless it is the
// member's own name.

const OPERATED = [
  'type T = {\n  a: keyof\n    U\n};',
  'type O = {\n  a: typeof\n    raw\n};',
  'type C = {\n  a: new\n    () => U\n};',
  'type E = {\n  a: U extends\n    V ? X : Y\n};',
  'type K = { keyof: string; new: number };',
  'type N = { keyof };',
  'type W = { new };',
  'type R = { readonly keyof };',
  'type S = { new(): U };',
];

it('[CT-06zzzzzp] r2 now: a member or a lone separator inserted on its own line between a type operator (keyof, typeof, new, extends) and its operand is refused on its line', () => {
  for (const row of OPERATED.slice(0, 4)) {
    const at = gapLine(OPERATED, row) + 2;
    const word = /a: (?:U )?(\w+)\n/.exec(row)?.[1] ?? '';
    const from = `${word}\n`;
    for (const added of ['    b?: string\n', '    b?: string;\n', '    ;\n']) {
      expect(names(gap(OPERATED, row, row.replace(from, `${from}${added}`)), at), row).toBe(true);
    }
  }
});

it('[CT-06zzzzzp] r2 kept: members named keyof / new (also with a modifier, untyped) and a construct signature still take an appended optional member or a trailing separator', () => {
  const edits: [string, string, string][] = [
    ['type K = { keyof: string; new: number };', 'number }', 'number; b?: string }'],
    ['type N = { keyof };', 'keyof }', 'keyof\n;\n }'],
    ['type N = { keyof };', 'keyof }', 'keyof; b?: string }'],
    ['type W = { new };', 'new }', 'new\n,\n }'],
    ['type W = { new };', 'new }', 'new\n; b?: string\n }'],
    ['type R = { readonly keyof };', 'keyof }', 'keyof; b?: string }'],
    ['type S = { new(): U };', 'U }', 'U; b?: string }'],
  ];
  for (const [row, from, to] of edits) {
    expect(gap(OPERATED, row, row.replace(from, to)), `${row} ${to}`).toEqual([]);
  }
});
