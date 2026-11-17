// CT-06zzzzzj (D10-1880, the third set of fixed cases): every insertion outside the blocks of the
// w1 frozen rewrites (B1-02zzzb / B1-02zzzc after D10-1780) passes, replayed on fixtures of the
// same shape (W1_KIT, GATE_TEST: made-up content, no real file read). Each case names the w1 file
// whose insertion it replays; the ten D10-1880 lists are all here: the spreads of calls ×4 (#15),
// the properties whose value is a call ×3 (#16), the trailing commas (#14 – #16), the object
// literal appended to OPERATIONS and the import line from outside test_paths (#17), the
// node:crypto import (#12). Each test also refuses the nearest insertion off the allow list,
// naming the file and the line, so a passing case does not pass for the wrong reason.
// Not replayed (D10-1888 / scan-1888 W-2): risk/risk-state/http.int.test.ts:65 'withdraw' →
// 'phone_change' changes a value outside the blocks, it inserts nothing; it is w1's class C review
// (D10-1780), not this rule.
import { afterAll, beforeAll, it } from 'vitest';
import {
  type Edit,
  type Fixture,
  GATE_TEST,
  GATE_TEST_BASE,
  ORDER,
  SLOW,
  W1,
  W1_BASE,
  W1_KIT,
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
  f = fixture('w1');
});
afterAll(cleanup);

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
/** W1_BASE with the line `line` replaced by `to`. */
const at = (line: string, to: string): string => replaceLine(W1_BASE, line, to);
/** W1_BASE with `added` inserted right after the line `line`. */
const after = (line: string, added: string): string => insertAfter(W1_BASE, line, added);

/** The import lines w1 inserted (the last one from outside the task's test_paths). */
const IMPORTS = {
  summaryClaim: "import { summaryClaim } from '../step-up-digest/payout-summary.ts';",
  two: "import { payoutSummary, resavedDigest } from '../step-up-digest/payout-summary.ts';",
  changeClaim: "import { payoutChangeClaim } from '../step-up-digest/payout-summary.ts';",
  longer: "import { payoutSummary } from '../../identity/step-up-digest/payout-summary.ts';",
  phoneStub:
    "import { detachPhoneReply, fillPhoneBody } from '../../payout/withdraw-no-step-up/phone-stub.ts';",
} as const;

// P1 import lines.
const httpKitImport: Edit = [
  'identity-level http-kit (B1-02zzzb): an import line between existing imports',
  adding(W1.tokens, IMPORTS.summaryClaim),
];
const payoutAccountImport: Edit = [
  'payout-account kit (B1-02zzzb): an import line of two names after the last import',
  adding(W1.reverify, IMPORTS.two),
];
const bankCardImport: Edit = [
  'payout-bank-card kit (B1-02zzzb): an import line after a multi-line import',
  adding(W1.signatureFrom, IMPORTS.changeClaim),
];
const badDebtImport: Edit = [
  'risk bad-debt-linked kit (B1-02zzzb): an import line through ../../identity/',
  adding(W1.signatureFrom, IMPORTS.longer),
];
const stepUpVerifyImport: Edit = [
  "step-up-verify kit (B1-02zzzc): an import line from outside the task's test_paths (payout/withdraw-no-step-up)",
  adding(W1.build, IMPORTS.phoneStub),
];

// P1 import lines and export { … } of the rule-test files.
const testCrypto: Edit = [
  'reverify-gates payout-account test (B1-02zzzb): an import line from node:crypto, first in the file',
  replacing(ORDER.vitest, `import { randomBytes } from 'node:crypto';\n${ORDER.vitest}`),
];
const testImport: Edit = [
  'payout-account concurrency test (B1-02zzzb): an import line after a multi-line import',
  adding(ORDER.kitImport, "import { bound } from '../step-up-digest/payout-summary.ts';"),
];
const testExport: Edit = [
  'step-up-verify withdraw-order test (B1-02zzzc): export { stepUpRequired }; after the last block, a comment above',
  (t) =>
    `${t}\n// B1-02zzzc: stepUpRequired is no longer called above; the import stays (frozen), used here.\nexport { stepUpRequired };\n`,
];

// P2 optional parameters, each with the comment w1 put above it.
const mintParam: Edit = [
  'identity-level http-kit (B1-02zzzb): async stepUp() to async stepUp(stepUpBody?: object), a doc comment above',
  replacing(
    W1.mint,
    [
      '    /**',
      '     * B1-02zzzb: the token carries the digest of the account `stepUpBody` saves.',
      '     */',
      '    async mint(stepUpBody?: object) {',
    ].join('\n'),
  ),
];
const stepUpParam: Edit = [
  "payout-bank-card kit (B1-02zzzb): (action = 'payout_account_change') gains , stepUpBody?: unknown, line comments above",
  replacing(
    W1.stepUp,
    [
      '  // B1-02zzzb: a payout_account_change token carries the digest of the account it is for;',
      '  // `stepUpBody` is the PUT body the token is taken for.',
      "  const stepUp = (action = 'payout_account_change', stepUpBody?: unknown) =>",
    ].join('\n'),
  ),
];
const gateParam: Edit = [
  'reverify-gates kit (B1-02zzzb): async (action: StepUpAction) gains , stepUpBody?: object, line comments above',
  replacing(
    W1.gate,
    [
      '  // B1-02zzzb: a payout_account_change token carries the digest of the account',
      '  // `stepUpBody` saves.',
      '  const gate = async (action: StepUpAction, stepUpBody?: object) =>',
    ].join('\n'),
  ),
];

// P2 / P4 arguments appended (the formatter re-wraps the lines).
const submitArgs: Edit = [
  "payout-bank-card kit (B1-02zzzb): token ?? (await stepUp()) to stepUp('payout_account_change', body), re-wrapped with a trailing comma",
  replacing(
    W1.submitSend,
    [
      '    return kit.post(',
      "      '/v1/me/bank-card',",
      '      body,',
      "      token ?? (await stepUp('payout_account_change', body)),",
      '    );',
    ].join('\n'),
  ),
];
const putArgs: Edit = [
  'reverify-gates kit (B1-02zzzb): stepUp(action) to stepUp(action, body) inside an existing conditional, re-wrapped over two lines',
  replacing(
    W1.putToken,
    [
      '    const token =',
      "      step === undefined && f.days > 0 ? await gate('payout_account_change', body) : step;",
    ].join('\n'),
  ),
];

// P2 / P4 spreads of calls appended to object literals (D10-1880: ×4).
const mintSpread: Edit = [
  'identity-level http-kit (B1-02zzzb): ...summaryClaim(f.crypto, stepUpBody, BODY), appended to the claims',
  adding(W1.mintJti, '          ...summaryClaim(kit.crypto, stepUpBody, BODY),'),
];
const stepUpSpread: Edit = [
  'payout-bank-card kit (B1-02zzzb): ...payoutChangeClaim(kit.crypto, action, stepUpBody, bankBody()), appended to the claims',
  adding(W1.stepUpJti, '        ...payoutChangeClaim(kit.crypto, action, stepUpBody, bankBody()),'),
];
const gateSpread: Edit = [
  'reverify-gates kit (B1-02zzzb): ...payoutChangeClaim(kit.crypto, action, stepUpBody), appended to the claims',
  adding(W1.gateJti, '        ...payoutChangeClaim(kit.crypto, action, stepUpBody),'),
];
const saveSpread: Edit = [
  'payout-account kit (B1-02zzzb): ...resavedDigest(kit.crypto, f.command, input) appended, the chain re-wrapped with a trailing comma, a comment above',
  replacing(
    W1.saveReturn,
    [
      '  // B1-02zzzb: the token digest follows the account this call saves, unless the input sets one.',
      '  return kit.db',
      '    .transaction()',
      '    .execute((trx) =>',
      '      app.save(trx, { ...f.command, ...input, ...resavedDigest(kit.crypto, f.command, input) }),',
      '    );',
    ].join('\n'),
  ),
];

// P2 / P4 properties whose value is a call (D10-1880: ×3).
// commandProperty is identity/payout-account/kit.ts:212–219 token for token (a method after the
// property, scan-1888 W-1): the inserted `, stepUpSummary: …(…, { … }),` is a whole property at
// the end of command, so base `}` / `,` stand for the outer ones, not for those of `{ alipayLogonId:
// LOGIN }` / `payoutSummary(…)`; an alignment pairing them with the inner ones refuses it wrongly.
const commandProperty: Edit = [
  'payout-account kit (B1-02zzzb): stepUpSummary: payoutSummary(kit.crypto, { alipayLogonId: LOGIN }) appended to command (a method follows), re-wrapped with trailing commas, a comment above',
  replacing(
    W1.command,
    [
      '    command: {',
      '      appId,',
      '      userId: uid,',
      '      alipayLogonId: LOGIN,',
      '      payeeName: NAME,',
      '      // B1-02zzzb: the step_up_token digest of the account this command saves.',
      '      stepUpSummary: payoutSummary(kit.crypto, { alipayLogonId: LOGIN }),',
      '    },',
    ].join('\n'),
  ),
];
const rebindProperty: Edit = [
  'realname-payout-invalidate kit (B1-02zzzb): stepUpSummary: payoutSummary(s.h.fields, { alipayLogonId }) appended, re-wrapped with trailing commas, a comment above',
  replacing(
    W1.rebindSave,
    [
      '      kit.service.save(trx, {',
      '        appId: target.appId,',
      '        userId: target.id,',
      '        alipayLogonId,',
      '        payeeName,',
      '        // B1-02zzzb: the step_up_token digest of the account this call saves.',
      '        stepUpSummary: payoutSummary(kit.h.fields, { alipayLogonId }),',
      '      }),',
    ].join('\n'),
  ),
];
const payeeProperty: Edit = [
  'risk bad-debt-linked kit (B1-02zzzb): stepUpSummary: payoutSummary(kit.crypto, { alipayLogonId: payee }) appended on a line of its own, a comment above',
  adding(
    W1.payeeName,
    [
      '      // B1-02zzzb: the step_up_token digest of the account this call saves.',
      '      stepUpSummary: payoutSummary(kit.crypto, { alipayLogonId: payee }),',
    ].join('\n'),
  ),
];

// B1-02zzzc step-up-verify kit: properties appended, two call statements, comments.
const operationsProperty: Edit = [
  'step-up-verify kit (B1-02zzzc): OPERATIONS gains phone: { path, action, operationId } (an object literal) after its last property, a comment above',
  adding(
    W1.withdrawOp,
    [
      '  // B1-02zzzc (D10-1699): the phone change (BR-ID-01 global order: ④a and ⑤ before ⑫).',
      "  phone: { path: '/v1/me/phone', action: 'phone_change', operationId: 'bindPhone' },",
    ].join('\n'),
  ),
];
const swappableProperty: Edit = [
  'step-up-verify kit (B1-02zzzc): { deletion: true, withdraw: true } gains , phone: true, comments above',
  replacing(
    W1.swappable,
    [
      "  // B1-02zzzc (D10-1699): bindPhone's real handler takes @Req() and @Res(); detachPhoneReply",
      '  // (below) drops the @Res() argument for the stub.',
      '  const swappable: Record<OperationName, boolean> = { deletion: true, withdraw: true, phone: true };',
    ].join('\n'),
  ),
];
const stubPathsProperty: Edit = [
  "step-up-verify kit (B1-02zzzc): phone: 'me/phone', appended to a literal on lines of their own",
  adding(W1.withdrawPath, "    phone: 'me/phone',"),
];
// detachPhoneReply({ … }); is a plain call statement and passes this rule. It changes the stub's
// route metadata: 这层改路由元数据的人工核对按 w1 的 C 类专项由编排按 #24 做，不靠本规则.
const detachCall: Edit = [
  'step-up-verify kit (B1-02zzzc): detachPhoneReply({ … }); as a statement of its own after the metadata copy, comments above',
  adding(
    W1.define,
    [
      '    // B1-02zzzc (D10-1699): bindPhone also takes @Res(); detachPhoneReply removes that argument',
      "    // from the stub's route metadata, so the framework calls it with @Req() only.",
      '    detachPhoneReply({ name, original, stub, kit });',
    ].join('\n'),
  ),
];
const fillCall: Edit = [
  'step-up-verify kit (B1-02zzzc): fillPhoneBody(operation, sendOptions); as the first statement of a method body',
  adding(W1.sendMethod, '      fillPhoneBody(operation, sendOptions);'),
];
const commentsOnly: Edit = [
  'reverify-gates kit (B1-02zzzc): comment lines only',
  adding(
    W1.opName,
    [
      '// (B1-02zzzc, D10-1665 / D10-1702: the withdrawal needs no step-up any more; the token',
      '// sent by default is neither judged nor consumed.)',
    ].join('\n'),
  ),
];

it(
  "[CT-06zzzzzj#12] w1 replay, P1 import lines: the five kits' import lines (between imports, after the last one, after a multi-line import, through ../../identity/, from outside test_paths) and the rule-test files' (node:crypto first in the file, after a multi-line import) pass; a bare side-effect import of the same module is refused, naming the file and the line",
  () => {
    passEach(f, W1_KIT, [
      httpKitImport,
      payoutAccountImport,
      bankCardImport,
      badDebtImport,
      stepUpVerifyImport,
    ]);
    passEach(f, GATE_TEST, [testCrypto, testImport]);
    const bare = "import '../../payout/withdraw-no-step-up/phone-stub.ts';";
    refuseEach(f, W1_KIT, [['a bare side-effect import', after(W1.build, bare), bare]]);
  },
  SLOW,
);

it(
  '[CT-06zzzzzj#13] w1 replay, P2 optional parameters (the empty list of a method, after a parameter with a default, an async arrow function), comments above them, pass; a required parameter appended, or an optional one before an existing parameter, is refused, naming the file and the line',
  () => {
    passEach(f, W1_KIT, [mintParam, stepUpParam, gateParam]);
    const required = '  const gate = async (action: StepUpAction, stepUpBody: object) =>';
    const before = "  const stepUp = (stepUpBody?: unknown, action = 'payout_account_change') =>";
    refuseEach(f, W1_KIT, [
      ['a required parameter appended', at(W1.gate, required), required],
      ['an optional parameter before an existing one', at(W1.stepUp, before), before],
    ]);
  },
  SLOW,
);

it(
  '[CT-06zzzzzj#14] w1 replay, P2 / P4 arguments appended (a literal and an identifier into an empty list behind ??, an identifier inside an existing conditional), re-wrapped by the formatter with a trailing comma, pass; an argument before or between existing ones is refused, naming the file and the line',
  () => {
    passEach(f, W1_KIT, [submitArgs, putArgs]);
    const before =
      "    const token = step === undefined && f.days > 0 ? await gate(body, 'payout_account_change') : step;";
    const between =
      "    return kit.post('/v1/me/bank-card', LOGIN, body, token ?? (await stepUp()));";
    refuseEach(f, W1_KIT, [
      ['an argument before an existing one', at(W1.putToken, before), before],
      ['an argument between existing ones', at(W1.submitSend, between), between],
    ]);
  },
  SLOW,
);

it(
  '[CT-06zzzzzj#15] w1 replay, P2 / P4 the four spreads of calls of bare identifiers appended to object literals (summaryClaim, payoutChangeClaim ×2, resavedDigest with the trailing comma of the re-wrapped chain) pass; a spread of a member call, or a spread before existing properties, is refused, naming the file and the line',
  () => {
    passEach(f, W1_KIT, [mintSpread, stepUpSpread, gateSpread, saveSpread]);
    const member = '          ...kit.crypto.summaryOf(stepUpBody),';
    const before = '        ...payoutChangeClaim(kit.crypto, action, stepUpBody),';
    refuseEach(f, W1_KIT, [
      ['a spread of a member call', after(W1.mintJti, member), member],
      [
        'a spread before existing properties',
        at(W1.gateDevice, `${before}\n${W1.gateDevice}`),
        before,
      ],
    ]);
  },
  SLOW,
);

it(
  '[CT-06zzzzzj#16] w1 replay, P2 / P4 the three properties whose value is a call of a bare identifier (payoutSummary(…, { … }): re-wrapped with trailing commas, on a line of its own) pass; a property whose value is a member call or new, or one before existing properties, is refused, naming the file and the line',
  () => {
    passEach(f, W1_KIT, [commandProperty, rebindProperty, payeeProperty]);
    const member = '      stepUpSummary: kit.crypto.digest(payee),';
    const created = '      stepUpSummary: new Summary(payee),';
    const before = '      stepUpSummary: payoutSummary(kit.crypto, { alipayLogonId: payee }),';
    refuseEach(f, W1_KIT, [
      ['a property whose value is a member call', after(W1.payeeName, member), member],
      ['a property whose value is new', after(W1.payeeName, created), created],
      ['a property before existing ones', at(W1.payeeAppId, `${before}\n${W1.payeeAppId}`), before],
    ]);
  },
  SLOW,
);

it(
  '[CT-06zzzzzj#17] w1 replay, B1-02zzzc step-up-verify kit: the import line from outside test_paths, the object literal appended to OPERATIONS, phone: true and phone: … appended, detachPhoneReply({ … }); and fillPhoneBody(…); as statements of their own, and comment-only changes pass; Object.defineProperty(…) or vi.spyOn(…) inserted, or a property before the existing ones of OPERATIONS, is refused, naming the file and the line',
  () => {
    passEach(f, W1_KIT, [
      stepUpVerifyImport,
      operationsProperty,
      swappableProperty,
      stubPathsProperty,
      detachCall,
      fillCall,
      commentsOnly,
    ]);
    const defined = "    Object.defineProperty(kit.proto, 'phone', { value: stub });";
    const spied = "    vi.spyOn(kit, 'handler');";
    const first =
      "  phone: { path: '/v1/me/phone', action: 'phone_change', operationId: 'bindPhone' },";
    refuseEach(f, W1_KIT, [
      ['Object.defineProperty(…) inserted', after(W1.define, defined), defined],
      ['vi.spyOn(…) inserted', after(W1.define, spied), spied],
      [
        'a property before the existing ones of OPERATIONS',
        at(W1.deletionOp, `${first}\n${W1.deletionOp}`),
        first,
      ],
    ]);
  },
  SLOW,
);

it(
  '[CT-06zzzzzj#18] w1 replay, a frozen rule-test file: export { stepUpRequired }; after the last block with a comment, with the node:crypto import and the import after a multi-line import on the same branch, passes; export { … } among the imports is refused, naming the file and the line',
  () => {
    passEach(f, GATE_TEST, [testExport]);
    passAll(f, GATE_TEST, [testCrypto, testImport, testExport]);
    const exported = 'export { stepUpRequired };';
    refuseEach(f, GATE_TEST, [
      [
        'export { … } among the imports',
        insertAfter(GATE_TEST_BASE, ORDER.kitImport, exported),
        exported,
      ],
    ]);
  },
  SLOW,
);

it(
  '[CT-06zzzzzj#19] w1 replay, all at once: every replayed insertion into the frozen kit on one branch passes and the head is ok; the same head with .catch(String) after an existing call is refused, naming the file and that line',
  () => {
    const head = passAll(f, W1_KIT, [
      httpKitImport,
      payoutAccountImport,
      bankCardImport,
      stepUpVerifyImport,
      mintParam,
      stepUpParam,
      gateParam,
      submitArgs,
      putArgs,
      mintSpread,
      stepUpSpread,
      gateSpread,
      saveSpread,
      commandProperty,
      rebindProperty,
      payeeProperty,
      operationsProperty,
      swappableProperty,
      stubPathsProperty,
      detachCall,
      fillCall,
      commentsOnly,
    ]);
    const caught = "    return kit.post('/v1/me/payout-account', body, token).catch(String);";
    refuseEach(f, W1_KIT, [
      [
        'every w1 insertion and .catch(String) after an existing call',
        replaceLine(head, W1.putSend, caught),
        caught,
      ],
    ]);
  },
  2 * SLOW,
);
