// CT-06zzzzzj (FU-SUPPORT-TOKENS-HARDEN; D10-1795, allow list rewritten by D10-1880) rule-test kit.
// Outside its it / test blocks, from the merge base to the head, a file with a file-level support
// entry (modify_existing, scope: support) passes only when every inserted token is on the allow
// list, two layers deep; anything off the list is refused, the refusal naming the file and the
// line of the inserted token. Comments are no tokens; the rules of CT-06zzzzzi stay (base tokens
// kept in order, bracket tree unchanged, no name of the base declared again, nothing inserted into
// a statement holding an assertion call).
// Positions (where inserted tokens may stand):
//   P1 a whole statement between existing ones: an import declaration with a binding (any
//      source; a bare side-effect import is refused), const <new name> = <expression> (export
//      const too), [await] <call> as an expression statement, export { … } at the end of the file;
//   P2 the tail of an existing list: the end of a call's arguments, a property or a spread at the
//      end of an object literal, an optional parameter (no default, no name of the base) at the
//      end of a parameter list; a name inside the braces of an existing import (any place);
//   P3 type positions: type annotations, optional marks, optional members of an interface or a
//      type literal;
//   P4 formatting: the trailing comma that comes with one of the above.
// Expressions (what P1 / P2 write, recursively): identifiers, member access (a.b), literals,
// object literals of these, calls whose callee is a bare identifier (arguments of this grammar),
// await, spreads of these at the end of an object literal; a member call is never a callee, the
// one exception the Promise.resolve(…) frozen CT-06zzzzzi #33 pins.
// D10-1888 (frozen CT-06zzzzzi #32), each widening the narrow way: ① array literals (elements of
// this grammar); ② binary + - * / % < > <= >= === !== in the value of a new P1 const only (not in
// P2, not in the arguments of a call statement; assignment, short circuits, comma, conditional,
// ++ / -- stay refused); ③ the one member call standing as a statement, <name>.push(<arguments of
// this grammar>), <name> a local of the base file (const / let / parameter; no import binding, no
// global, no name this change declares); ④ a bare callee is no const this change declares; ⑤ a
// P1 const declares one plain name (no destructuring).
// Every case goes through checkEvidence (tools/ci/evidence-check.ts) on a git repository under
// <repo>/.tmp/ (the modify-existing-support kit, imported, not changed); each support file has its
// own trusted ledger with one support entry.
import { expect } from 'vitest';
import type { EvidenceReport } from '../../../../tools/ci/evidence-check.ts';
import {
  ADMIN_BASE,
  ADMIN_KIT,
  type Repo,
  branch,
  check,
  ledger,
  lineAt,
  lineProblem,
  makeRepo,
  problemsOf,
  refusal,
  support,
  supportRecord,
  trusted,
} from '../modify-existing-support/kit.ts';

export {
  ADMIN,
  ADMIN_BASE,
  ADMIN_KIT,
  SLOW,
  cleanup,
  insertAfter,
  lineAt,
  replaceLine,
  replaceOnce,
} from '../modify-existing-support/kit.ts';

/** The fixture task's test_paths (since D10-1880 no limit on the source of an import line). */
export const TEST_PATHS = ['test/spec/identity/step-up-digest/**'] as const;
/** Modules under TEST_PATHS. */
export const DIGEST = 'test/spec/identity/step-up-digest/payout-summary.ts';
export const STUB = 'test/spec/identity/step-up-digest/phone-stub.ts';
/** A module outside TEST_PATHS exporting the same name as DIGEST. */
export const ELSEWHERE = 'test/spec/identity/step-up-other/digest.ts';
/** A frozen shared kit (not money) and a frozen rule-test file importing it. */
export const GATE_KIT = 'test/spec/identity/step-up-gate/kit.ts';
export const GATE_TEST = 'test/spec/identity/step-up-gate/order.int.test.ts';
/** A frozen shared kit shaped after the w1 kits B1-02zzzb / B1-02zzzc changed (made-up content). */
export const W1_KIT = 'test/spec/identity/step-up-replay/kit.ts';

/** Import lines: from TEST_PATHS (DIGEST, STUB) and from outside it (ELSEWHERE). */
export const IMPORT_DIGEST = "import { digestOf } from '../step-up-digest/payout-summary.ts';";
export const IMPORT_STUB = "import { fillBody } from '../step-up-digest/phone-stub.ts';";
export const IMPORT_ELSEWHERE = "import { digestOf } from '../step-up-other/digest.ts';";

// Eighteen comment lines first, so that every changed line is at line 19 or later (a two-digit
// number that the file paths, ruling ids and BR ids do not contain alone).
const PAD = ['// fixture (CT-06zzzzzj)', ...Array.from({ length: 17 }, () => '// padding')];

/** Lines of GATE_BASE the cases edit or insert after (each exactly once in the file). */
export const GATE = {
  crypto: "import { randomUUID } from 'node:crypto';",
  http: "import { send, sign } from './http.ts';",
  seed: "import { seedUser } from '../registration/kit.ts';",
  doc: '// The step-up gate of the payout account and the phone change.',
  bodyType: 'export type GateBody = { amount: number; fee: number };',
  iface: 'export interface GateUser {',
  appId: '  appId: string;',
  deletionOp: "  deletion: { path: '/v1/me/deletion', action: 'account_deletion' },",
  withdrawOp: "  withdraw: { path: '/v1/withdrawals', action: 'withdraw' },",
  stubPaths: 'export const STUB_PATHS = {',
  deletionPath: "  deletion: 'me/deletion',",
  withdrawPath: "  withdraw: 'withdrawals',",
  swappable: 'export const SWAPPABLE = { deletion: true, withdraw: true };',
  claims: 'export function claims(user: GateUser, action: StepUpAction) {',
  claimsBody: '  return { sub: user.id, app_id: user.appId, action, jti: randomUUID() };',
  gate: 'export async function gate(app: App, user: GateUser, days: number) {',
  stepUp: '  const stepUp = async (action: StepUpAction) => sign(claims(user, action));',
  issue: "  const issue = (action = 'payout_account_change') => sign(claims(user, action));",
  /** A local array of the base (D10-1888 ③: <base local>.push(…) may stand as a statement). */
  calls: '  const calls: string[] = [];',
  mint: '    async mint() {',
  put: '  async function put(body: object, step?: string) {',
  token: "    const token = step === undefined && days > 0 ? await stepUp('phone_change') : step;",
  putSend: "    return send(app, 'PUT', '/v1/me/payout-account', body, token);",
  post: '  async function post(path: string, body: object, token?: string) {',
  header: '    const header = token ?? (await issue());',
  postSend: "    return send(app, 'POST', path, body, header);",
} as const;

/** GATE_KIT at the merge base: no assertion call anywhere, so only the allow list is judged. */
export const GATE_BASE = [
  ...PAD,
  GATE.crypto,
  GATE.http,
  GATE.seed,
  '',
  GATE.doc,
  "export type StepUpAction = 'payout_account_change' | 'phone_change';",
  GATE.bodyType,
  '',
  GATE.iface,
  '  id: string;',
  GATE.appId,
  '}',
  '',
  'export const OPERATIONS = {',
  GATE.deletionOp,
  GATE.withdrawOp,
  '} as const;',
  '',
  GATE.stubPaths,
  GATE.deletionPath,
  GATE.withdrawPath,
  '};',
  '',
  GATE.swappable,
  '',
  GATE.claims,
  GATE.claimsBody,
  '}',
  '',
  GATE.gate,
  GATE.stepUp,
  GATE.issue,
  GATE.calls,
  '  const client = {',
  GATE.mint,
  '      return issue();',
  '    },',
  '  };',
  GATE.put,
  GATE.token,
  GATE.putSend,
  '  }',
  GATE.post,
  GATE.header,
  GATE.postSend,
  '  }',
  '  return { client, put, post, seeded: seedUser(app) };',
  '}',
  '',
].join('\n');

/** Lines of GATE_TEST_BASE the cases edit or insert after. */
export const ORDER = {
  vitest: "import { expect, it } from 'vitest';",
  kitImport: "} from './kit.ts';",
  lastLine: '});',
} as const;

/** GATE_TEST at the merge base: a multi-line import, then one it block (unchanged by every case). */
export const GATE_TEST_BASE = [
  ...PAD,
  ORDER.vitest,
  'import {',
  '  claims,',
  '  gate,',
  '  type GateUser,',
  ORDER.kitImport,
  "import { stepUpRequired } from '../step-up-verify/kit.ts';",
  '',
  "it('[AC-B9-02#1] refuses a phone change without a step-up token', async () => {",
  "  const user: GateUser = { id: 'u', appId: 'a' };",
  '  await stepUpRequired(await gate(app, user, 0));',
  "  expect(claims(user, 'phone_change')).toHaveProperty('action');",
  ORDER.lastLine,
  '',
].join('\n');

/**
 * Lines of W1_BASE the w1 replays edit or insert after (each exactly once in the file). Each is
 * the shape of a line one of the w1 kits had at the base (B1-02zzzb / B1-02zzzc after D10-1780).
 */
export const W1 = {
  tokens: "import { access, signScopedToken } from './tokens.ts';",
  build: "import { buildApp } from '../sms-codes/http-kit.ts';",
  signatureFrom: "} from '../../risk/signature/kit.ts';",
  reverify: "import { closeKit, type Kit } from '../reverify/kit.ts';",
  deletionOp:
    "  deletion: { path: '/v1/me/deletion', action: 'account_deletion', operationId: 'requestDeletion' },",
  withdrawOp:
    "  withdraw: { path: '/v1/withdrawals', action: 'withdraw', operationId: 'createWithdrawal' },",
  opName: 'export type OperationName = keyof typeof OPERATIONS;',
  stepUp: "  const stepUp = (action = 'payout_account_change') =>",
  stepUpJti: '        jti: randomUUID(),',
  gate: '  const gate = async (action: StepUpAction) =>',
  gateDevice: '        device_id: f.device,',
  gateJti: '        jti: kit.nextJti(),',
  mint: '    async mint() {',
  mintJti: '          jti,',
  sendMethod: '    send(operation: OperationName, sendOptions: SendOptions) {',
  swappable:
    '  const swappable: Record<OperationName, boolean> = { deletion: true, withdraw: true };',
  withdrawPath: "    withdraw: 'withdrawals',",
  define: '      kit.metadata.define(key, kit.metadata.get(key, original), stub);',
  putToken:
    "    const token = step === undefined && f.days > 0 ? await gate('payout_account_change') : step;",
  putSend: "    return kit.post('/v1/me/payout-account', body, token);",
  submitSend: "    return kit.post('/v1/me/bank-card', body, token ?? (await stepUp()));",
  /** The base line of identity/payout-account/kit.ts the scan names W-1 (a method follows it). */
  command: '    command: { appId, userId: uid, alipayLogonId: LOGIN, payeeName: NAME },',
  saveReturn:
    '  return kit.db.transaction().execute((trx) => app.save(trx, { ...f.command, ...input }));',
  rebindSave:
    '      kit.service.save(trx, { appId: target.appId, userId: target.id, alipayLogonId, payeeName }),',
  payeeAppId: '      appId: p.appId,',
  payeeName: '      payeeName: p.name,',
} as const;

/** W1_KIT at the merge base: no assertion call anywhere. */
export const W1_BASE = [
  ...PAD,
  "import { randomUUID } from 'node:crypto';",
  W1.tokens,
  "import { seedUser } from '../registration/kit.ts';",
  W1.build,
  'import {',
  '  apiRequire,',
  '  factory,',
  W1.signatureFrom,
  W1.reverify,
  '',
  'export const OPERATIONS = {',
  W1.deletionOp,
  W1.withdrawOp,
  '} as const;',
  W1.opName,
  '',
  'export function bankBody() {',
  "  return { payout_method: 'bank_card', card_no: CARD };",
  '}',
  '',
  'export async function fixture(kit: Kit, f: Fixture) {',
  W1.stepUp,
  '    signScopedToken(kit.keys, {',
  "      audience: 'step_up',",
  '      claims: {',
  '        sub: f.uid,',
  '        action,',
  W1.stepUpJti,
  '      },',
  '      ttlSeconds: 300,',
  '    });',
  W1.gate,
  '    access.sign(kit.keys, {',
  '      claims: {',
  W1.gateDevice,
  '        action,',
  W1.gateJti,
  '      },',
  '    });',
  '  const client = {',
  W1.mint,
  '      const jti = randomUUID();',
  '      return signScopedToken(kit.keys, {',
  "        audience: 'step_up',",
  '        claims: {',
  '          sub: f.uid,',
  W1.mintJti,
  '        },',
  '      });',
  '    },',
  W1.sendMethod,
  '      const path = OPERATIONS[operation].path;',
  '      return kit.post(path, sendOptions.body);',
  '    },',
  '  };',
  W1.swappable,
  '  const stubPaths: Record<OperationName, string> = {',
  "    deletion: 'me/deletion',",
  W1.withdrawPath,
  '  };',
  '  for (const name of kit.planned) {',
  '    const original = kit.handler(name);',
  '    const stub = function (...args: unknown[]) {',
  '      return args[0];',
  '    };',
  '    for (const key of kit.metadata.keysOf(original))',
  W1.define,
  '    Object.defineProperty(kit.proto, name, { value: stub });',
  '  }',
  '  async function put(body: object, step?: string) {',
  W1.putToken,
  W1.putSend,
  '  }',
  '  async function submit(body: object, token?: string) {',
  W1.submitSend,
  '  }',
  '  return {',
  '    client,',
  '    put,',
  '    submit,',
  '    swappable,',
  '    stubPaths,',
  W1.command,
  "    async get(mode: 'app' | 'h5' | 'guest' = 'app') {",
  '      return kit.db.session(mode);',
  '    },',
  '  };',
  '}',
  '',
  "export async function save(kit: Kit, f: Fixture, input: Partial<Fixture['command']> = {}) {",
  '  const app = await kit.service();',
  W1.saveReturn,
  '}',
  '',
  'export async function rebind(kit: Kit, target: User, alipayLogonId: string, payeeName: string) {',
  '  return kit.db',
  '    .transaction()',
  '    .execute((trx) =>',
  W1.rebindSave,
  '    );',
  '}',
  '',
  'export async function rebindPayee(kit: Kit, p: Person, payee: string) {',
  '  const result = await kit.db.transaction().execute((trx) =>',
  '    kit.service.save(trx, {',
  W1.payeeAppId,
  '      userId: p.userId,',
  '      alipayLogonId: payee,',
  W1.payeeName,
  '    }),',
  '  );',
  '  return result;',
  '}',
  '',
].join('\n');

/** Every file of the fixture repository at the merge base. */
export const BASE_FILES: Record<string, string> = {
  [DIGEST]: [
    'export function digestOf(value: unknown) {',
    '  return JSON.stringify(value);',
    '}',
    'export function bound(command: object) {',
    '  return command;',
    '}',
    '',
  ].join('\n'),
  [STUB]: [
    'export function fillBody(body: object, step?: string) {',
    '  void body;',
    '  void step;',
    '}',
    '',
  ].join('\n'),
  [ELSEWHERE]: 'export function digestOf(value: unknown) {\n  return String(value);\n}\n',
  [GATE_KIT]: GATE_BASE,
  [GATE_TEST]: GATE_TEST_BASE,
  [W1_KIT]: W1_BASE,
  [ADMIN_KIT]: ADMIN_BASE,
};

export type Fixture = { repo: Repo; trusted: Record<string, string> };

/** The fixture repository and, per support file, a trusted root with its ledger. */
export function fixture(name: string): Fixture {
  const repo = makeRepo(`allowlist-${name}`, BASE_FILES);
  const dirs: Record<string, string> = {};
  [GATE_KIT, GATE_TEST, W1_KIT, ADMIN_KIT].forEach((file, i) => {
    const text = ledger([support(file)], { testPaths: TEST_PATHS });
    const refused = refusal(text);
    if (refused !== '') throw new Error(`fixture: the ledger of ${file} is refused: ${refused}`);
    dirs[file] = trusted(`allowlist-${name}-${i}`, text);
  });
  return { repo, trusted: dirs };
}

function baseOf(f: Fixture, file: string): string {
  const text = f.repo.files[file];
  if (text === undefined) throw new Error(`fixture: no base content for ${file}`);
  return text;
}

/** checkEvidence on a branch changing `file` to `head` (base → head), with its correct record. */
export function judge(f: Fixture, file: string, head: string): EvidenceReport {
  const dir = f.trusted[file];
  if (dir === undefined) throw new Error(`fixture: no trusted root for ${file}`);
  const sha = branch(f.repo, 'allowlist', { [file]: head }, [
    supportRecord(file, baseOf(f, file), head),
  ]);
  return check(f.repo, sha, dir);
}

/** [name, the edit of the file's text] */
export type Edit = readonly [name: string, edit: (text: string) => string];

/** Each edit of `file`'s base, on its own branch with its correct record: no problem at all. */
export function passEach(f: Fixture, file: string, edits: readonly Edit[]): void {
  const base = baseOf(f, file);
  for (const [name, edit] of edits) {
    const head = edit(base);
    expect(head, name).not.toBe(base);
    const report = judge(f, file, head);
    expect(report.problems, name).toEqual([]);
  }
}

/** All edits applied to `file`'s base on one branch: no problem, the head ok. */
export function passAll(f: Fixture, file: string, edits: readonly Edit[]): string {
  const base = baseOf(f, file);
  const head = edits.reduce((text, [, edit]) => edit(text), base);
  expect(head).not.toBe(base);
  const report = judge(f, file, head);
  expect(report.problems).toEqual([]);
  expect(report).toMatchObject({ ok: true });
  return head;
}

/** [name, the head, the head line(s) holding an inserted token, each exactly once in the head] */
export type Refusal = readonly [name: string, head: string, lines: string | readonly string[]];

/**
 * Each head on its own branch with its correct record: refused, a problem naming `file` and the
 * number of a head line holding an inserted token as a number of its own (lineProblem).
 */
export function refuseEach(f: Fixture, file: string, cases: readonly Refusal[]): void {
  const base = baseOf(f, file);
  for (const [name, head, at] of cases) {
    expect(head, name).not.toBe(base);
    const lines = (typeof at === 'string' ? [at] : at).map((l) => lineAt(head, l));
    expect(Math.min(...lines), name).toBeGreaterThan(18);
    const report = judge(f, file, head);
    const why = `${name}\n${problemsOf(report)}`;
    expect(report.ok, why).toBe(false);
    expect(lineProblem(report, file, lines), why).toBeDefined();
  }
}
