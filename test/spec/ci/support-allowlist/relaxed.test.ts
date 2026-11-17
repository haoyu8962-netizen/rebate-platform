// CT-06zzzzzj (D10-1888 on the two layers of D10-1880; kit.ts has the list): the three narrow
// widenings frozen CT-06zzzzzi #32 needs and the two rules against aliases. #21 ① array literals
// pass (a new const, an appended argument, an appended property), elements of the grammar only;
// #22 ② the binary operators + - * / % < > <= >= === !== pass in the value of a new const only,
// every other operator there, and these operators in P2 or in a call statement's arguments, are
// refused; #23 ③ <base local>.push(…) passes as a statement (a const, a parameter), any other
// member call statement, a push on an import binding, a global, a fresh const or a member, or with
// arguments off the grammar, is refused; #24 ④ a bare callee that is a const this change declares
// is refused; #25 ⑤ a destructuring const, or one declaring two names, is refused; #26 the three
// lines of #32 and every widening at once pass, one member call statement more is refused. Each
// refusal names the file and the line of the inserted token.
// Not pinned (D10-1888 does not say): an operator nested inside the value of a new const (in an
// array element, an argument or a property of it), a unary minus, a spread inside an array.
import { afterAll, beforeAll, it } from 'vitest';
import {
  type Edit,
  type Fixture,
  GATE,
  GATE_BASE,
  GATE_KIT,
  type Refusal,
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
  f = fixture('relaxed');
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
/** An edit inserting `added` as the first statement of put(). */
const inPut = (added: string) => adding(GATE.put, added);
/** `line` inserted as the first statement of put(), refused naming that line. */
const putRefused = (name: string, line: string): Refusal => [name, after(GATE.put, line), line];

/** claims()'s return line with `inner` appended to its properties. */
const claimsWith = (inner: string): string =>
  `  return { sub: user.id, app_id: user.appId, action, jti: randomUUID(), ${inner} };`;
/** post()'s send(…) with `args` appended to its arguments. */
const postWith = (args: string): string =>
  `    return send(app, 'POST', path, body, header, ${args});`;

it(
  '[CT-06zzzzzj#21] D10-1888 ① array literals pass, elements of the expression grammar (bigint, identifiers, member accesses, literals, a call of a bare identifier, an object literal, a nested array, none): in the value of a new const, as an appended argument, as an appended property; an element that is a member call, new or an arrow function, and an operator in an element of an appended argument, are refused, naming the file and the line',
  () => {
    passEach(f, GATE_KIT, [
      ['frozen #32: const expectedMore = [3n];', inPut('    const expectedMore = [3n];')],
      [
        'elements of every kind of the grammar',
        inPut(
          "    const list = [user.id, step, 'phone', 2, null, true, digestOf(body), { kind: 1 }, [days]];",
        ),
      ],
      ['an empty array', inPut('    const queue = [];')],
      ['an array as an appended argument', replacing(GATE.postSend, postWith('[user.id, 2]'))],
      [
        'an array as an appended property',
        replacing(GATE.claimsBody, claimsWith('scopes: [action, user.appId]')),
      ],
    ]);
    const member = '    const trimmed = [user.id.trim()];';
    const created = '    const dates = [new Date()];';
    const arrow = '    const picks = [() => body];';
    const operator = postWith('[days + 1]');
    refuseEach(f, GATE_KIT, [
      ['a member call as an element', after(GATE.put, member), member],
      ['new as an element', after(GATE.put, created), created],
      ['an arrow function as an element', after(GATE.put, arrow), arrow],
      [
        'an operator in an element of an appended argument (P2)',
        at(GATE.postSend, operator),
        operator,
      ],
    ]);
  },
  SLOW,
);

it(
  '[CT-06zzzzzj#22] D10-1888 ② each of + - * / % < > <= >= === !== passes in the value of a new const (operands: identifiers, member accesses, literals; chained; export const at the end of the file; frozen #32 const assertedToo = rows.length + 1); == != ** | & << in instanceof ! ?? || a conditional ++ an assignment and a comma there, and an arithmetic or comparison operator in an appended argument or property, in the arguments of a call statement (awaited too), are refused, naming the file and the line',
  () => {
    passEach(f, GATE_KIT, [
      [
        'frozen #32 shape: + on a member access',
        inPut('    const assertedToo = calls.length + 1;'),
      ],
      ['+', inPut('    const next = days + 1;')],
      ['-', inPut('    const before = days - 1;')],
      ['*', inPut('    const minutes = days * 1440;')],
      ['/', inPut('    const weeks = days / 7;')],
      ['%', inPut('    const weekday = days % 7;')],
      ['<', inPut('    const fresh = days < 7;')],
      ['>', inPut('    const stale = days > 30;')],
      ['<=', inPut('    const atMost = days <= 7;')],
      ['>=', inPut('    const atLeast = days >= 1;')],
      ['===', inPut("    const isPhone = step === 'phone';")],
      ['!==', inPut('    const changed = user.appId !== user.id;')],
      ['chained', inPut('    const span = days * 2 + 1;')],
      ['export const at the end of the file', (t) => `${t}export const TTL = 60 * 5;\n`],
    ]);
    const refused: readonly (readonly [string, string])[] = [
      ['==', "    const loose = step == 'phone';"],
      ['!=', "    const unlike = step != 'phone';"],
      ['**', '    const squared = days ** 2;'],
      ['|', '    const bits = days | 1;'],
      ['&', '    const masked = days & 1;'],
      ['<<', '    const shifted = days << 1;'],
      ['in', "    const has = 'id' in user;"],
      ['instanceof', '    const isUser = user instanceof Object;'],
      ['unary !', '    const none = !step;'],
      ['??', "    const chosen = step ?? 'phone';"],
      ['||', "    const either = step || 'phone';"],
      ['a conditional', '    const shown = days > 0 ? step : body;'],
      ['++ on an existing name', '    const bumped = days++;'],
      ['an assignment', "    const set = (step = 'phone');"],
      ['a comma', '    const last = (days, step);'],
    ];
    const sum = postWith('days + 1');
    const compared = claimsWith('fresh: days < 7');
    const statement = '    fillBody(body, days + 1);';
    const awaited = '    await fillBody(body, days * 2);';
    refuseEach(f, GATE_KIT, [
      ...refused.map(([name, line]) => putRefused(`${name} in the value of a new const`, line)),
      ['+ in an appended argument (P2)', at(GATE.postSend, sum), sum],
      ['< in an appended property (P2)', at(GATE.claimsBody, compared), compared],
      ['+ in the arguments of a call statement', after(GATE.put, statement), statement],
      ['* in the arguments of an awaited call statement', after(GATE.put, awaited), awaited],
    ]);
  },
  2 * SLOW,
);

it(
  '[CT-06zzzzzj#23] D10-1888 ③ <base local>.push(…) passes as a statement (a const of the base, a parameter; a literal, an object literal as frozen #32 has it, several arguments with a call and an array); any other member call statement (unshift, splice, a method of a parameter), a push on an import binding, a global, a const this change declares or a member, a push whose argument holds an operator or a member call, and a push as an expression, are refused, naming the file and the line',
  () => {
    passEach(f, GATE_KIT, [
      [
        'a literal pushed on a const of the base',
        adding(GATE.calls, "  calls.push('phone_change');"),
      ],
      [
        'frozen #32 shape: an object literal pushed',
        inPut("    calls.push({ id: 'b', amount: 300n });"),
      ],
      [
        'several arguments: a member access, a call, an array',
        inPut('    calls.push(user.id, digestOf(body), [step]);'),
      ],
      ['a push on a parameter', adding(GATE.post, '    body.push(path);')],
    ]);
    const statements: readonly (readonly [string, string])[] = [
      ['unshift on a const of the base', "    calls.unshift('phone');"],
      ['splice on a const of the base', '    calls.splice(0, 1);'],
      ['a method of a parameter', '    user.toString();'],
      ['push on an import binding', '    seedUser.push(body);'],
      ['push on a global', '    history.push(body);'],
      ['push on a member', '    client.mint.push(body);'],
      ['push with an operator in its argument', '    calls.push(days + 1);'],
      ['push with a member call in its argument', '    calls.push(user.id.trim());'],
      ['push as an expression', "    const size = calls.push('phone');"],
    ];
    const fresh = '    queue.push(body);';
    refuseEach(f, GATE_KIT, [
      ...statements.map(([name, line]) => putRefused(name, line)),
      [
        'push on a const this change declares',
        after(GATE.put, `    const queue = [];\n${fresh}`),
        fresh,
      ],
    ]);
  },
  2 * SLOW,
);

it(
  '[CT-06zzzzzj#24] D10-1888 ④ a new const may hold a member access or a name and be an argument (const assign = Object.assign; const pick = digestOf; digestOf(pick)), but calling it as a bare callee (a statement, the value of another new const, an appended argument, an appended spread) is refused, naming the file and the line of the call',
  () => {
    passEach(f, GATE_KIT, [
      ['a member access as the value of a new const', inPut('    const assign = Object.assign;')],
      [
        'a new const of a name, passed as an argument',
        inPut('    const pick = digestOf;\n    const picked = digestOf(pick);'),
      ],
    ]);
    const statement = '    assign(user, body);';
    const valued = '    const picked = pick(body);';
    const argument = postWith('wrap(body)');
    const spread = claimsWith('...wrap(user)');
    refuseEach(f, GATE_KIT, [
      [
        'const assign = Object.assign; assign(…) as a statement',
        after(GATE.put, `    const assign = Object.assign;\n${statement}`),
        statement,
      ],
      [
        'const pick = digestOf; pick(…) as the value of another new const',
        after(GATE.put, `    const pick = digestOf;\n${valued}`),
        valued,
      ],
      [
        'a new const called in an appended argument',
        insertAfter(at(GATE.postSend, argument), GATE.post, '    const wrap = digestOf;'),
        argument,
      ],
      [
        'a new const called in an appended spread',
        insertAfter(at(GATE.claimsBody, spread), GATE.claims, '  const wrap = digestOf;'),
        spread,
      ],
    ]);
  },
  SLOW,
);

it(
  '[CT-06zzzzzj#25] D10-1888 ⑤ a new const declares one plain name: const env = vi; passes (its members then are no push on a base local); const { stubEnv } = vi, const [first] = calls, const { id: owner } = user, export const { … } at the end and const a = …, b = … are refused, naming the file and the line, and so is env.stubEnv(…) after const env = vi',
  () => {
    passEach(f, GATE_KIT, [['a plain name holding vi', inPut('    const env = vi;')]]);
    const destructured: readonly (readonly [string, string])[] = [
      ['const { stubEnv } = vi', '    const { stubEnv } = vi;'],
      ['an array pattern', '    const [first] = calls;'],
      ['a renaming pattern', '    const { id: owner } = user;'],
      ['two names in one const', '    const one = 1, two = 2;'],
    ];
    const exported = 'export const { deletion: DELETION } = OPERATIONS;';
    const member = "    env.stubEnv('X', '1');";
    refuseEach(f, GATE_KIT, [
      ...destructured.map(([name, line]) => putRefused(name, line)),
      ['export const { … } at the end', `${GATE_BASE}${exported}\n`, exported],
      [
        'env.stubEnv(…) after const env = vi',
        after(GATE.put, `    const env = vi;\n${member}`),
        member,
      ],
    ]);
  },
  SLOW,
);

it(
  '[CT-06zzzzzj#26] the three lines of frozen #32 (an array, <base local>.push({ … }), an operator in a new const) with every D10-1888 widening on one branch pass and the head is ok; the same head with calls.unshift(…) after the base local is refused, naming the file and that line',
  () => {
    const all: Edit[] = [
      [
        'frozen #32, three lines at once',
        inPut(
          [
            '    const expectedMore = [3n];',
            "    calls.push({ id: 'b', amount: 300n });",
            '    const assertedToo = calls.length + 1;',
          ].join('\n'),
        ),
      ],
      ['an array as an appended argument', replacing(GATE.postSend, postWith('[user.id, 2]'))],
      ['a push on a parameter', adding(GATE.post, '    body.push(path);')],
      ['a comparison in a new const', adding(GATE.token, '    const fresh = days < 7;')],
      [
        'a new const of a name, passed as an argument',
        adding(GATE.header, '    const pick = digestOf;\n    const picked = digestOf(pick);'),
      ],
      ['export const at the end of the file', (t) => `${t}export const TTL = 60 * 5;\n`],
    ];
    const head = passAll(f, GATE_KIT, all);
    const unshift = "  calls.unshift('phone');";
    refuseEach(f, GATE_KIT, [
      ['all of the above and calls.unshift(…)', insertAfter(head, GATE.calls, unshift), unshift],
    ]);
  },
  SLOW,
);
