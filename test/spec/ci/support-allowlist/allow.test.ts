// CT-06zzzzzj (FU-SUPPORT-TOKENS-HARDEN; D10-1795, allow list rewritten by D10-1880): the two
// layers of the allow list outside the blocks of a file with a file-level support entry (kit.ts
// has the list). #1–#6 the positions P1–P4, each passing, with the edge of each refused; #7 every
// part of the expression grammar passing in a new const, with its edge refused; #8–#10 the
// default-deny classes, each refused, naming the file and the line of the inserted token; #11 all
// passing kinds at once pass, and one denied insertion more is still refused. The three D10-1888
// widenings (array literals, operators in a new const's value, <base local>.push(…)) and the two
// anti-alias rules ④ ⑤ are in relaxed.test.ts.
import { afterAll, beforeAll, it } from 'vitest';
import {
  type Edit,
  type Fixture,
  GATE,
  GATE_BASE,
  GATE_KIT,
  IMPORT_DIGEST,
  IMPORT_ELSEWHERE,
  IMPORT_STUB,
  SLOW,
  cleanup,
  fixture,
  insertAfter,
  passAll,
  passEach,
  refuseEach,
  replaceLine,
} from './kit.ts';

let f: Fixture;
beforeAll(() => {
  f = fixture('allow');
});
afterAll(cleanup);

/** GATE_BASE with the line `line` replaced by `to`. */
const at = (line: string, to: string): string => replaceLine(GATE_BASE, line, to);
/** GATE_BASE with `added` inserted right after the line `line`. */
const after = (line: string, added: string): string => insertAfter(GATE_BASE, line, added);
/** An edit inserting `added` right after the line `line`. */
const adding =
  (line: string, added: string) =>
  (t: string): string =>
    insertAfter(t, line, added);
/** An edit replacing the line `line` by `to`. */
const replacing =
  (line: string, to: string) =>
  (t: string): string =>
    replaceLine(t, line, to);

/** The return line of claims() holding the properties `inner`. */
const claimsReturn = (inner: string): string => `  return { ${inner} };`;
/** The properties of that line at the base, and all of them but the first. */
const CLAIMS_REST = 'app_id: user.appId, action, jti: randomUUID()';
const CLAIMS = `sub: user.id, ${CLAIMS_REST}`;
/** claims()'s return line with `inner` appended to its properties. */
const claimsWith = (inner: string): string => claimsReturn(`${CLAIMS}, ${inner}`);
/** post()'s send(…) with `args` appended to its arguments. */
const postWith = (args: string): string =>
  `    return send(app, 'POST', path, body, header, ${args});`;

it(
  '[CT-06zzzzzj#1] P1 import declarations with a binding pass from any source (test_paths, outside it, a package such as node:crypto, an alias, a namespace), and a name added inside the braces of an existing import passes at any place; a bare side-effect import (a module, a package) is refused, naming the file and the line, and so is an added name the base holds',
  () => {
    passEach(f, GATE_KIT, [
      ['an import line from test_paths after the imports', adding(GATE.seed, IMPORT_DIGEST)],
      [
        'an import line from outside test_paths between the imports',
        adding(GATE.crypto, IMPORT_ELSEWHERE),
      ],
      [
        'an import line from a package (node:crypto, as w1 did)',
        adding(GATE.crypto, "import { randomBytes } from 'node:crypto';"),
      ],
      [
        'an import line binding an alias',
        adding(GATE.seed, "import { setTimeout as delay } from 'node:timers/promises';"),
      ],
      [
        'a namespace import',
        adding(GATE.seed, "import * as digests from '../step-up-other/digest.ts';"),
      ],
      [
        'a name added in front inside existing braces',
        replacing(GATE.http, "import { digestOf, send, sign } from './http.ts';"),
      ],
      [
        'a name added between names inside existing braces',
        replacing(GATE.http, "import { send, digestOf, sign } from './http.ts';"),
      ],
      [
        'a name added at the end inside existing braces',
        replacing(GATE.http, "import { send, sign, digestOf } from './http.ts';"),
      ],
      [
        'two names added inside the braces of a package import',
        replacing(
          GATE.crypto,
          "import { createHash, randomUUID, randomBytes } from 'node:crypto';",
        ),
      ],
    ]);
    const bare = "import '../step-up-digest/phone-stub.ts';";
    const pkg = "import 'reflect-metadata';";
    const shadow = "import { claims, send, sign } from './http.ts';";
    refuseEach(f, GATE_KIT, [
      ['a bare side-effect import of a module after the imports', after(GATE.seed, bare), bare],
      ['a bare side-effect import of a package', after(GATE.crypto, pkg), pkg],
      ['a name the base holds added inside existing braces', at(GATE.http, shadow), shadow],
    ]);
  },
  SLOW,
);

it(
  '[CT-06zzzzzj#2] P1 other whole statements between existing ones pass: const <new name> = <expression>, export const between declarations and at the end, [await] <call> as a statement (its callee need not be imported by this change), export { … } at the end; let, var, export let, export { … } among the imports or between declarations, and an expression statement that is no call (await <name>, <name>) are refused, naming the file and the line',
  () => {
    passEach(f, GATE_KIT, [
      [
        'a new const between statements, its value a call',
        adding(GATE.put, '    const summary = digestOf(body);'),
      ],
      [
        'export const between declarations',
        adding(GATE.swappable, "export const PHONE_PATH = 'me/phone';"),
      ],
      [
        'export const at the end of the file',
        (t) => `${t}export const PHONE = { path: '/v1/me/phone', action: 'phone_change' };\n`,
      ],
      ['an awaited call as a statement', adding(GATE.put, '    await fillBody(body, step);')],
      ['a call of an import as a statement', adding(GATE.put, '    fillBody(body, step);')],
      [
        'a call of a function of the base file as a statement (frozen #33: not only new imports)',
        adding(GATE.put, "    claims(user, 'phone_change');"),
      ],
      ['export { … } at the end', (t) => `${t}export { seedUser };\n`],
      [
        'export { … } of two names at the end, a comment above',
        (t) => `${t}// re-exported for the order tests\nexport { randomUUID, seedUser };\n`,
      ],
    ]);
    const letLine = "    let note = 'phone';";
    const varLine = "    var note = 'phone';";
    const exportLet = "export let PHONE = 'me/phone';";
    const exported = 'export { seedUser };';
    const between = 'export { claims };';
    const awaited = '    await token;';
    const named = '    body;';
    refuseEach(f, GATE_KIT, [
      ['a let declaration', after(GATE.put, letLine), letLine],
      ['a var declaration', after(GATE.put, varLine), varLine],
      ['export let at the end', `${GATE_BASE}${exportLet}\n`, exportLet],
      ['export { … } among the imports', after(GATE.seed, exported), exported],
      ['export { … } between declarations', after(GATE.swappable, between), between],
      ['await of a name as a statement (no call)', after(GATE.token, awaited), awaited],
      ['a name as a statement (no call)', after(GATE.put, named), named],
    ]);
  },
  SLOW,
);

it(
  "[CT-06zzzzzj#3] P2 / P4 arguments appended at the end of an existing call's list pass (an identifier inside an existing conditional, a literal into an empty list, a number, a member access, a call, an object literal, one on a line of its own with the trailing comma the formatter adds); an argument before the first, before or between existing ones is refused, naming the file and the line",
  () => {
    passEach(f, GATE_KIT, [
      [
        'an identifier appended inside an existing conditional',
        replacing(
          GATE.token,
          "    const token = step === undefined && days > 0 ? await stepUp('phone_change', body) : step;",
        ),
      ],
      [
        'a literal and an identifier into an empty argument list',
        replacing(
          GATE.header,
          "    const header = token ?? (await issue('payout_account_change', body));",
        ),
      ],
      ['a number appended', replacing(GATE.postSend, postWith('2'))],
      ['a member access appended', replacing(GATE.postSend, postWith('user.id'))],
      [
        'a call of a bare identifier appended',
        replacing(GATE.postSend, postWith('digestOf(body)')),
      ],
      [
        'an object literal appended',
        replacing(GATE.postSend, postWith('{ step: token, retry: false }')),
      ],
      [
        'P4: re-wrapped one per line, the appended argument with its trailing comma',
        replacing(
          GATE.postSend,
          [
            '    return send(',
            '      app,',
            "      'POST',",
            '      path,',
            '      body,',
            '      header,',
            '      digestOf(body),',
            '    );',
          ].join('\n'),
        ),
      ],
    ]);
    const before = "    return send(app, 'PUT', days, '/v1/me/payout-account', body, token);";
    const between = "    return send(app, 'POST', path, user.id, body, header);";
    const first = "    return send(user, app, 'POST', path, body, header);";
    refuseEach(f, GATE_KIT, [
      ['an argument before an existing one', at(GATE.putSend, before), before],
      ['an argument between existing ones', at(GATE.postSend, between), between],
      ['an argument before the first one', at(GATE.postSend, first), first],
    ]);
  },
  SLOW,
);

it(
  '[CT-06zzzzzj#4] P2 / P4 a property or a spread appended at the end of an object literal passes (key: identifier / number / boolean / string / member access / call / object literal, a shorthand, a spread of an identifier, a member access or a call; inline, on a line of its own, re-wrapped with the trailing comma the formatter adds); a property or a spread before or between existing ones is refused, naming the file and the line',
  () => {
    const appended = (inner: string) => replacing(GATE.claimsBody, claimsWith(inner));
    passEach(f, GATE_KIT, [
      ['key: identifier', appended('summary: action')],
      ['a shorthand property', appended('user')],
      ['a spread of an identifier', appended('...user')],
      ['key: number', appended('version: 2')],
      ['key: member access', appended('level: user.appId')],
      ['key: a call of a bare identifier', appended('digest: digestOf(user)')],
      ['a spread of a call of a bare identifier', appended('...digestOf(user)')],
      ['a spread of a member access', appended('...user.extra')],
      ['key: an object literal', appended("scope: { kind: 'phone', owner: user.id }")],
      [
        'key: boolean, inline',
        replacing(
          GATE.swappable,
          'export const SWAPPABLE = { deletion: true, withdraw: true, phone: true };',
        ),
      ],
      ['key: string, on a line of its own', adding(GATE.withdrawPath, "  phone: 'me/phone',")],
      [
        'key: an object literal, on a line of its own',
        adding(GATE.withdrawOp, "  phone: { path: '/v1/me/phone', action: 'phone_change' },"),
      ],
      [
        'P4: re-wrapped one per line, the appended property with its trailing comma',
        replacing(
          GATE.swappable,
          'export const SWAPPABLE = {\n  deletion: true,\n  withdraw: true,\n  phone: true,\n};',
        ),
      ],
    ]);
    const front = claimsReturn(`summary: action, ${CLAIMS}`);
    const middle = claimsReturn(`sub: user.id, summary: action, ${CLAIMS_REST}`);
    const spread = claimsReturn(`...user, ${CLAIMS}`);
    const phonePath = "  phone: 'me/phone',";
    const phoneOp = "  phone: { path: '/v1/me/phone', action: 'phone_change' },";
    refuseEach(f, GATE_KIT, [
      ['a property before the existing ones', at(GATE.claimsBody, front), front],
      ['a property between existing ones', at(GATE.claimsBody, middle), middle],
      ['a spread before the existing ones', at(GATE.claimsBody, spread), spread],
      [
        'a property between existing ones on lines of their own',
        after(GATE.deletionPath, phonePath),
        phonePath,
      ],
      [
        'an object-literal property between existing ones on lines of their own',
        after(GATE.deletionOp, phoneOp),
        phoneOp,
      ],
    ]);
  },
  SLOW,
);

const claims = (params: string): string => `export function claims(${params}) {`;

it(
  '[CT-06zzzzzj#5] P2 an optional parameter (x?: T, no default, a new name) appended at the end of a parameter list passes (a function declaration, the empty list of a method, after a parameter with a default, an async arrow function); one before an existing parameter, a required one, a rest parameter, one with a default value, or one named like an identifier of the base is refused, naming the file and the line',
  () => {
    passEach(f, GATE_KIT, [
      [
        'appended to a function declaration',
        replacing(GATE.claims, claims('user: GateUser, action: StepUpAction, stepUpBody?: object')),
      ],
      [
        'into the empty parameter list of a method',
        replacing(GATE.mint, '    async mint(stepUpBody?: object) {'),
      ],
      [
        'after a parameter with a default (an arrow function)',
        replacing(
          GATE.issue,
          "  const issue = (action = 'payout_account_change', stepUpBody?: unknown) => sign(claims(user, action));",
        ),
      ],
      [
        'appended to an async arrow function',
        replacing(
          GATE.stepUp,
          '  const stepUp = async (action: StepUpAction, stepUpBody?: object) => sign(claims(user, action));',
        ),
      ],
    ]);
    const before = claims('user: GateUser, stepUpBody?: object, action: StepUpAction');
    const required = claims('user: GateUser, action: StepUpAction, stepUpBody: object');
    const rest = claims('user: GateUser, action: StepUpAction, ...extra: unknown[]');
    const defaulted = claims("user: GateUser, action: StepUpAction, stepUpBody = 'none'");
    const shadow = claims('user: GateUser, action: StepUpAction, body?: object');
    refuseEach(f, GATE_KIT, [
      ['an optional parameter before an existing one', at(GATE.claims, before), before],
      ['a required parameter appended', at(GATE.claims, required), required],
      ['a rest parameter appended', at(GATE.claims, rest), rest],
      ['an appended parameter with a default value', at(GATE.claims, defaulted), defaulted],
      [
        'an optional parameter named like an identifier of the base (body)',
        at(GATE.claims, shadow),
        shadow,
      ],
    ]);
  },
  SLOW,
);

it(
  '[CT-06zzzzzj#6] P3 type positions pass: a return type, a type on a const, a type on a parameter with a default, an optional member appended to an interface or a type literal, an optional mark on an existing parameter; a required member added to an interface or a type literal, and an optional chain (no optional mark), are refused, naming the file and the line',
  () => {
    passEach(f, GATE_KIT, [
      [
        'a return type annotation',
        replacing(
          GATE.claims,
          'export function claims(user: GateUser, action: StepUpAction): object {',
        ),
      ],
      [
        'a type annotation on a const',
        replacing(GATE.stubPaths, 'export const STUB_PATHS: Record<string, string> = {'),
      ],
      [
        'a type annotation on a parameter with a default',
        replacing(
          GATE.issue,
          "  const issue = (action: string = 'payout_account_change') => sign(claims(user, action));",
        ),
      ],
      ['an optional member appended to an interface', adding(GATE.appId, '  summary?: string;')],
      [
        'an optional member appended to a type literal',
        replacing(
          GATE.bodyType,
          'export type GateBody = { amount: number; fee: number; summary?: string };',
        ),
      ],
      [
        'an optional mark on an existing parameter',
        replacing(
          GATE.gate,
          'export async function gate(app: App, user: GateUser, days?: number) {',
        ),
      ],
    ]);
    const member = '  summary: string;';
    const literal = 'export type GateBody = { amount: number; fee: number; summary: string };';
    const chained = claimsWith('level: user?.appId');
    refuseEach(f, GATE_KIT, [
      ['a required member added to an interface', after(GATE.appId, member), member],
      ['a required member added to a type literal', at(GATE.bodyType, literal), literal],
      ['an optional chain', at(GATE.claimsBody, chained), chained],
    ]);
  },
  SLOW,
);

it(
  '[CT-06zzzzzj#7] the expression grammar, each part in the value of a new const: an identifier, a member access (a.b, a.b.c), string / number / boolean / null literals, an object literal of these, calls of bare identifiers with arguments of the grammar (nested), await of a call or a name, spreads at the end of an object literal, Promise.resolve(…) (frozen #33) pass; a member call, a call whose callee is a call, and Promise.reject(…) are refused, naming the file and the line',
  () => {
    const value = (line: string) => adding(GATE.put, line);
    passEach(f, GATE_KIT, [
      ['an identifier', value('    const chosen = step;')],
      ['a member access', value('    const owner = user.id;')],
      ['a member access two deep', value('    const deep = app.config.phone;')],
      ['a string literal', value("    const label = 'phone';")],
      ['a number literal', value('    const retries = 2;')],
      ['a boolean literal', value('    const strict = false;')],
      ['null', value('    const none = null;')],
      [
        'an object literal of identifiers, member accesses and literals',
        value("    const shape = { owner: user.id, body, kind: 'phone', retries: 2 };"),
      ],
      ['an object literal nested', value('    const nested = { scope: { owner: user.id } };')],
      [
        'calls of bare identifiers, nested, arguments of the grammar',
        value('    const digest = digestOf(fillBody(body, { owner: user.id }), 2);'),
      ],
      [
        'await of a call',
        value("    const sent = await send(app, 'PUT', '/v1/me/phone', body, step);"),
      ],
      ['await of a name', adding(GATE.token, '    const awaited = await token;')],
      [
        'spreads of a name, a call and a member access at the end of an object literal',
        value('    const merged = { kind: 1, ...user, ...digestOf(body), ...user.extra };'),
      ],
      [
        'Promise.resolve(…), the one member call allowed (frozen #33)',
        value('    const echoed = await Promise.resolve(digestOf(body));'),
      ],
    ]);
    const member = '    const trimmed = user.id.trim();';
    const curried = '    const curried = digestOf(body)(step);';
    const rejected = '    const rejected = Promise.reject(body);';
    refuseEach(f, GATE_KIT, [
      ['a member call', after(GATE.put, member), member],
      ['a call whose callee is a call', after(GATE.put, curried), curried],
      [
        'Promise.reject(…), a member call other than Promise.resolve',
        after(GATE.put, rejected),
        rejected,
      ],
    ]);
  },
  SLOW,
);

it(
  '[CT-06zzzzzj#8] default deny, operators and assignments: a binary operator in an appended argument or property, an operand added to an existing argument, a unary operator (!, typeof, void), an assignment, a compound assignment or ++ through a name this change declares (an alias of an existing object), an assignment to an existing name, each refused, naming the file and the line',
  () => {
    const sum = postWith('days + 1');
    const operand = "    return send(app, 'POST', path, body, header + 1);";
    const not = postWith('!days');
    const compared = claimsWith("fresh: action === 'phone_change'");
    const concatenated = claimsWith("label: 'step_' + action");
    const typed = claimsWith('kind: typeof action');
    const voided = '    void body;';
    const assigned = '    alias.id = body;';
    const compound = '    counter.n += 1;';
    const increment = '    tally.n++;';
    const existing = "    step = 'phone';";
    refuseEach(f, GATE_KIT, [
      ['a binary operator in an appended argument', at(GATE.postSend, sum), sum],
      ['an operand added to an existing argument', at(GATE.postSend, operand), operand],
      ['a unary ! in an appended argument', at(GATE.postSend, not), not],
      ['a comparison in an appended property', at(GATE.claimsBody, compared), compared],
      [
        'a string concatenation in an appended property',
        at(GATE.claimsBody, concatenated),
        concatenated,
      ],
      ['typeof in an appended property', at(GATE.claimsBody, typed), typed],
      ['void as a statement', after(GATE.put, voided), voided],
      [
        'an assignment through a fresh alias of an existing object',
        after(GATE.put, `    const alias = user;\n${assigned}`),
        assigned,
      ],
      [
        'a compound assignment to a fresh object',
        after(GATE.put, `    const counter = { n: 0 };\n${compound}`),
        compound,
      ],
      [
        '++ on a fresh object',
        after(GATE.put, `    const tally = { n: 0 };\n${increment}`),
        increment,
      ],
      ['an assignment to an existing parameter', after(GATE.token, existing), existing],
    ]);
  },
  SLOW,
);

it(
  '[CT-06zzzzzj#9] default deny, functions and flow: an arrow function (a new const, an argument), a function expression or declaration, a class declaration or expression, new (a new const, a property, an argument), * after function (also async function), an optional chain, a conditional, an if, a short circuit and a comma expression, each refused, naming the file and the line',
  () => {
    const arrow = '    const pick = (b: object) => b;';
    const arrowArg = postWith('() => body');
    const fnExpr = '    const named = function () { void body; };';
    const fnDecl = 'function pick(b: object) {';
    const classDecl = 'class Summary {}';
    const classExpr = '    const Shape = class {};';
    const newConst = '    const now = new Date();';
    const newProp = claimsWith('issuedAt: new Date()');
    const newArg = postWith('new URL(path)');
    const star = 'export function* claims(user: GateUser, action: StepUpAction) {';
    const asyncStar = '  async function* put(body: object, step?: string) {';
    const chained = claimsWith('level: user?.appId');
    const ternary = '    const shown = step ? step : body;';
    const branch = '    if (step === undefined) void body;';
    const short = postWith('token && body');
    const comma = '    digestOf((step, body));';
    refuseEach(f, GATE_KIT, [
      ['an arrow function in a new const', after(GATE.put, arrow), arrow],
      ['an arrow function as an appended argument', at(GATE.postSend, arrowArg), arrowArg],
      ['a function expression', after(GATE.put, fnExpr), fnExpr],
      [
        'a function declaration',
        after(GATE.swappable, `${fnDecl}\n  void b;\n}`),
        [fnDecl, '  void b;'],
      ],
      ['a class declaration', after(GATE.swappable, classDecl), classDecl],
      ['a class expression', after(GATE.put, classExpr), classExpr],
      ['new in a new const', after(GATE.put, newConst), newConst],
      ['new in an appended property', at(GATE.claimsBody, newProp), newProp],
      ['new in an appended argument', at(GATE.postSend, newArg), newArg],
      ['* after function', at(GATE.claims, star), star],
      ['* after async function', at(GATE.put, asyncStar), asyncStar],
      ['an optional chain', at(GATE.claimsBody, chained), chained],
      ['a conditional', after(GATE.put, ternary), ternary],
      ['an if', after(GATE.put, branch), branch],
      ['a short circuit in an appended argument', at(GATE.postSend, short), short],
      ['a comma expression', after(GATE.put, comma), comma],
    ]);
  },
  2 * SLOW,
);

it(
  '[CT-06zzzzzj#10] default deny, member calls: vi.* (spyOn(…).mockResolvedValue(…), useFakeTimers(), fn() as a property), Object.* (assign, freeze, keys), other member calls (an appended argument, an appended property, a spread), .then / .catch after an existing call, each refused, naming the file and the line; Promise.resolve(…) in a new const (frozen #33) passes',
  () => {
    passEach(f, GATE_KIT, [
      [
        'Promise.resolve(…) in a new const',
        adding(GATE.put, '    const echoed = await Promise.resolve(digestOf(body));'),
      ],
    ]);
    const spy = "    vi.spyOn(app, 'inject').mockResolvedValue(body);";
    const timers = '    vi.useFakeTimers();';
    const fn = claimsWith('stub: vi.fn()');
    const assign = '    Object.assign(user, { id: body });';
    const freeze = '    Object.freeze(user);';
    const keys = '    const keys = Object.keys(user);';
    const memberArg = postWith('JSON.stringify(body)');
    const memberProp = claimsWith('label: action.toUpperCase()');
    const memberSpread = claimsWith('...user.toJSON()');
    const then = "    return send(app, 'PUT', '/v1/me/payout-account', body, token).then(String);";
    const caught =
      "    return send(app, 'PUT', '/v1/me/payout-account', body, token).catch(String);";
    refuseEach(f, GATE_KIT, [
      ['vi.spyOn(…).mockResolvedValue(…)', after(GATE.put, spy), spy],
      ['vi.useFakeTimers()', after(GATE.put, timers), timers],
      ['vi.fn() as an appended property', at(GATE.claimsBody, fn), fn],
      ['Object.assign(existing, …)', after(GATE.put, assign), assign],
      ['Object.freeze(existing)', after(GATE.put, freeze), freeze],
      ['Object.keys(…) in a new const', after(GATE.put, keys), keys],
      ['a member call as an appended argument', at(GATE.postSend, memberArg), memberArg],
      ['a member call as an appended property', at(GATE.claimsBody, memberProp), memberProp],
      ['a spread of a member call', at(GATE.claimsBody, memberSpread), memberSpread],
      ['.then(…) after an existing call', at(GATE.putSend, then), then],
      ['.catch(…) after an existing call', at(GATE.putSend, caught), caught],
    ]);
  },
  2 * SLOW,
);

it(
  '[CT-06zzzzzj#11] every position at once (P1 imports, a new const, a call statement, export const and export { … } at the end; P2 an import name, an argument, a property, a spread, an optional parameter; P3 an optional member; a comment) passes and the head is ok; the same head with .catch(String) after an existing call is refused, naming the file and that line',
  () => {
    const all: Edit[] = [
      ['P1 an import line from test_paths', adding(GATE.seed, IMPORT_STUB)],
      [
        'P1 an import line from a package',
        adding(GATE.crypto, "import { randomBytes } from 'node:crypto';"),
      ],
      [
        'P2 a name inside existing braces',
        replacing(GATE.http, "import { digestOf, send, sign } from './http.ts';"),
      ],
      ['P2 an optional parameter', replacing(GATE.mint, '    async mint(stepUpBody?: object) {')],
      [
        'P2 a property appended',
        replacing(
          GATE.swappable,
          'export const SWAPPABLE = { deletion: true, withdraw: true, phone: true };',
        ),
      ],
      [
        'P2 a spread of a call appended',
        replacing(GATE.claimsBody, claimsWith('...digestOf(user)')),
      ],
      [
        'P2 an argument appended',
        replacing(
          GATE.token,
          "    const token = step === undefined && days > 0 ? await stepUp('phone_change', body) : step;",
        ),
      ],
      ['P1 a call statement', adding(GATE.put, '    fillBody(body, step);')],
      [
        'P1 a new const with Promise.resolve(…)',
        adding(GATE.header, '    const echoed = await Promise.resolve(digestOf(body));'),
      ],
      ['P3 an optional member', adding(GATE.appId, '  summary?: string;')],
      [
        'a comment',
        adding(GATE.doc, '// B1-02zzzb: the token carries the digest of the account it is for.'),
      ],
      ['P1 export const at the end', (t) => `${t}export const PHONE = 'me/phone';\n`],
      ['P1 export { … } at the end', (t) => `${t}export { seedUser };\n`],
    ];
    const head = passAll(f, GATE_KIT, all);
    const caught =
      "    return send(app, 'PUT', '/v1/me/payout-account', body, token).catch(String);";
    refuseEach(f, GATE_KIT, [
      [
        'all of the above and .catch(String) after an existing call',
        replaceLine(head, GATE.putSend, caught),
        caught,
      ],
    ]);
  },
  SLOW,
);
