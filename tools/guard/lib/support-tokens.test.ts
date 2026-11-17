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
