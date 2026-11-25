// CT-24zzv: the admin step-up tiers (BR-ID-34 二次验证分三档). Implementer unit test next to the
// rule test test/spec/contracts/admin-step-up-tiers: an operation that BR-ID-34 puts in none keeps
// no step-up requirement or wording in its description, the 10003 examples carry the tier or the
// verify_phone_missing reason, and the 10003 entry of the error-code table drops the old
// 动态码档 / 短信档 wording. Reads the raw contract (YAML only, no dereferencing).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { errorCodes } from './index.ts';

const { parseYamlLite } = createRequire(import.meta.url)('../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
};
const apiRequire = createRequire(new URL('../../../apps/api/package.json', import.meta.url));
const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
  Ajv2020: new (options: { strict: boolean; allErrors: true }) => {
    compile(schema: object): (data: unknown) => boolean;
  };
};

type Row = Record<string, unknown>;
const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

const contract = parseYamlLite(
  readFileSync(new URL('../../../contracts/openapi.yaml', import.meta.url), 'utf8'),
) as Row;

/** Follows a local `$ref` (`#/components/...`) until a plain object is reached. */
function resolve(value: unknown): Row {
  let current = value as Row;
  while (typeof current['$ref'] === 'string') {
    const path = (current['$ref'] as string).replace(/^#\//, '').split('/');
    current = path.reduce<Row>((node, key) => node[key] as Row, contract);
  }
  return current;
}

function adminOperations(): { id: string; operation: Row }[] {
  return Object.entries(contract['paths'] as Record<string, Row>).flatMap(([path, item]) => {
    if (!path.startsWith('/admin/v1/')) return [];
    return METHODS.flatMap((method) => {
      const operation = item[method] as Row | undefined;
      return operation === undefined ? [] : [{ id: String(operation['operationId']), operation }];
    });
  });
}

/** Every 10003 error example of an operation (inline `example` and named `examples`). */
function stepUpExamples(operation: Row): Row[] {
  return Object.entries(operation['responses'] as Row).flatMap(([status, response]) => {
    if (status !== 'default' && !/^[45]/.test(status)) return [];
    const content = resolve(response)['content'] as Record<string, Row> | undefined;
    const media = content?.['application/json'];
    if (media === undefined) return [];
    const named = Object.values((media['examples'] ?? {}) as Row).map((e) => resolve(e)['value']);
    return [media['example'], ...named].filter(
      (e): e is Row => typeof e === 'object' && e !== null && (e as Row)['code'] === 10003,
    );
  });
}

// The admin operations that took the admin step-up token before 2026-11-23 and are none now
// (BR-ID-34 细则「不在清单里的（none）」), adminRetestNotifySms excluded.
const NONE = [
  'adminSendMyVerifyPhoneCode',
  'adminCreateAdmin',
  'adminRegenerateAdminInitialPassword',
  'adminDisableAdmin',
  'adminEnableAdmin',
  'adminResetAdminTotp',
  'adminSendAdminVerifyPhoneCode',
  'adminDisableUserUnionBinding',
  'adminEnableUserUnionBinding',
  'adminChangeUserLevel',
  'adminChangeInviter',
  'adminEditUserProfile',
  'adminAddUserReverifiedDevice',
  'adminCorrectUserRealname',
  'adminCreateUserDataExport',
  'adminDownloadUserDataExport',
  'adminReassignOrder',
  'adminCreateRightsImport',
  'adminAddUnionAlertPhone',
  'adminRemoveUnionAlertPhone',
  'adminPublishAgreementVersion',
  'adminSaveDictItems',
  'adminRollbackDictItems',
  'adminSwitchNotifyChannels',
  'adminRegisterNotifySms',
  'adminEnableNotifySms',
  'adminSaveAppVersion',
  'adminEnableRiskRule',
  'adminDisableRiskRule',
  'resolveAdminPayOrder',
  'writeOffAdminReconDiff',
  'restoreAdminReconDiff',
  'blacklistClawbackAdminReconDiff',
  'recalcBalanceAdminReconDiff',
  'adminApproveSettleAdjustBatch',
  'adminRejectSettleAdjustBatch',
  'adminRunSettleAdjust',
  'adminBatchManualPaid',
  'adminQueryPayoutResult',
  'adminResolveUnknownPayout',
  'confirmAdminSettleBill',
  'createAdminSettleSupplementBatches',
  'cancelAdminSettleBatchSchedule',
  'rejectAdminSettleBatch',
  'resumeAdminSettleBatch',
  'adminCreateUnionReceipt',
  'adminReverseUnionReceipt',
  'adminCreatePayoutWatermark',
];
const FORBIDDEN = [
  'step-up token is a header',
  'step_up_token',
  'x-step-up-token',
  'data.tier',
  '10003',
  'totp tier',
  'totp-tier',
  'sms tier',
  'sms-tier',
  'and step-up',
  'step-up (',
  'step-up as above',
];
// Sentences that describe the step-up tokens an account already holds (they stop working when the
// account is disabled or its authenticator reset); these are not a requirement of the operation.
const HELD = String.raw`[^.]*\bstep-up token of the account stops working[^.]*\.`;
const HELD_TOKENS = new Set(['adminDisableAdmin', 'adminResetAdminTotp']);

it('[CT-24zzv] the none operations keep no step-up requirement or wording in their descriptions', () => {
  const byId = new Map(adminOperations().map((entry) => [entry.id, entry.operation]));
  expect(NONE).toHaveLength(48);
  for (const id of NONE) {
    const operation = byId.get(id);
    expect(operation, `${id} must exist`).toBeDefined();
    expect(operation!['x-step-up'], id).toBeUndefined();
    let text = String(operation!['description'] ?? '')
      .replaceAll('`', '')
      .replace(/\s+/g, ' ')
      .toLowerCase();
    if (HELD_TOKENS.has(id)) {
      expect(text, id).toMatch(new RegExp(HELD));
      text = text.replace(new RegExp(HELD, 'g'), '');
    }
    text = text.replace(/\bno step-up\b/g, '');
    for (const phrase of FORBIDDEN) expect(text, `${id}: ${phrase}`).not.toContain(phrase);
  }
});

it('[CT-24zzv] the contract shows a sudo and a strict 10003 example; the SMS retest only the reason', () => {
  const all = adminOperations().flatMap(({ id, operation }) =>
    stepUpExamples(operation).map((example) => ({ id, data: example['data'] })),
  );
  expect(all.some(({ data }) => JSON.stringify(data) === '{"tier":"sudo"}')).toBe(true);
  expect(all.some(({ data }) => JSON.stringify(data) === '{"tier":"strict"}')).toBe(true);
  const retest = all.filter(({ id }) => id === 'adminRetestNotifySms');
  expect(retest.length).toBeGreaterThan(0);
  for (const { data } of retest) expect(data).toEqual({ reason: 'verify_phone_missing' });
});

it('[CT-24zzv] the 10003 entry lists sudo and strict and drops the 动态码档 / 短信档 wording', () => {
  const entry = errorCodes[10003];
  expect(entry.data.tier).toEqual(expect.arrayContaining(['sudo', 'strict']));
  expect(entry.data.reason).toEqual(['verify_phone_missing']);
  for (const text of [entry.meaning, entry.action]) {
    for (const stale of ['动态码档', '短信档', '持动态码档 token 调短信档操作'])
      expect(text).not.toContain(stale);
  }
  expect(entry.meaning).toContain('data.tier ∈ {sudo, strict}');
  expect(entry.action).toContain('按 data.tier（sudo / strict）弹 StepUpModal');
});

it('[CT-24zzv] issuing a step-up token picks a method, not a tier: no per-method tier wording left', () => {
  const byId = new Map(adminOperations().map((entry) => [entry.id, entry.operation]));
  for (const id of ['adminStepUp', 'adminSendStepUpSms']) {
    const operation = byId.get(id);
    expect(operation, `${id} must exist`).toBeDefined();
    expect(operation!['x-step-up'], id).toBeUndefined();
    const text = String(operation!['description'] ?? '')
      .replaceAll('`', '')
      .replace(/\s+/g, ' ')
      .replace(/\s*=\s*/g, '=')
      .toLowerCase();
    expect(text, id).toContain('method=sms');
    for (const stale of [
      'sms tier',
      'totp tier',
      'data.tier=sms',
      'data.tier=totp',
      '短信档',
      '动态码档',
    ])
      expect(text, `${id}: ${stale}`).not.toContain(stale);
    const examples = stepUpExamples(operation!);
    expect(examples.length, id).toBeGreaterThan(0);
    for (const example of examples)
      expect(example['data'], id).toEqual({ reason: 'verify_phone_missing' });
  }
  const schemas = (contract['components'] as Row)['schemas'] as Record<string, Row>;
  const properties = schemas['AdminStepUpRequest']!['properties'] as Record<string, Row>;
  const methodRef = { $ref: '#/components/schemas/AdminStepUpMethod' };
  expect(properties['method']).toEqual(methodRef);
  expect(properties['tier']).toEqual(methodRef);
});

// Codex money review r1 (D10-2900): the issue operation, the token header and me/permissions state
// how a strict token binds, how long a token lives and what happens to it after each outcome.
function flat(value: unknown): string {
  return String(value ?? '')
    .replaceAll('`', '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
const components = contract['components'] as Record<string, Record<string, Row>>;
const issueText = flat(
  ((contract['paths'] as Record<string, Row>)['/admin/v1/auth/step-up']!['post'] as Row)[
    'description'
  ],
);
const tokenText = flat(components['parameters']!['AdminStepUpToken']!['description']);

it('[CT-24zzv] a strict token is bound to the first strict operation that takes it, not at issue', () => {
  for (const text of [issueText, tokenText]) {
    expect(text).toContain('the first time a strict operation takes');
    expect(text).toContain('bound to that operation');
    expect(text).toContain('only the same operation may retry with it');
    expect(text).not.toMatch(/\bany live, unused token\b/);
  }
  expect(issueText).toContain('no operation is named at issue');
});

it('[CT-24zzv] a step-up token lives 5 minutes from the successful verification', () => {
  for (const text of [issueText, tokenText]) {
    expect(text).toContain('5 minutes from the successful verification');
    expect(text).not.toMatch(/300 seconds|\b5 min\b/);
  }
  expect(issueText).not.toContain('token lifetime');
  expect(issueText).not.toContain('the server decides');
  // The open question on the login-failure lock stays.
  expect(issueText).toContain(
    'left open here: whether wrong step-up codes count towards the login-failure lock.',
  );
});

it('[CT-24zzv] a token is spent on success, retried after a definite failure, held when unknown', () => {
  expect(tokenText).toContain(
    'the token is spent when the operation succeeds: code=0 and, for an operation whose answer carries an outcome, an outcome other than rejected',
  );
  expect(tokenText).toContain(
    'after a definite rejection or failure it is not spent and can be sent again until its expire_at',
  );
  expect(tokenText).toContain('when the outcome is unknown, it stays held until it expires');
  expect(issueText).toContain('after a definite rejection or failure of that operation');
  expect(issueText).toContain('when the outcome is unknown');
  expect(issueText).toContain('the token stays held until it expires');
  for (const text of [issueText, tokenText]) {
    expect(text).not.toContain('it is released and can be sent again');
    expect(text).not.toContain('the server may release the token');
  }
});

it('[CT-24zzv] me/permissions: step_up_tier is the highest tier, display only', () => {
  const me = (contract['paths'] as Record<string, Row>)['/admin/v1/me/permissions']!['get'] as Row;
  const text = flat(me['description']);
  expect(text).toContain('step_up_tier is the highest tier among the operations of that point');
  expect(text).toContain('display only');
  expect(text).not.toMatch(/display-only|informational/);
  expect(text).toContain("decided by that operation's own x-step-up and its 10003 answer");
  expect(text).toContain('must not block an operation in advance');
  expect(text).toContain('rejecting or withdrawing an adjustment needs no verification');
  const ok = resolve(me['responses'] as Row);
  const media = (resolve(ok['200'])['content'] as Record<string, Row>)['application/json']!;
  const finance = resolve((media['examples'] as Row)['finance'])['value'] as Row;
  const permissions = (finance['data'] as Row)['permissions'] as Row[];
  expect(permissions.find((entry) => entry['key'] === 'fund.adjust')).toEqual({
    key: 'fund.adjust',
    step_up_tier: 'strict',
    step_up_operations: [],
  });
});

it('[CT-24zzv] AdminStepUpRequest: method and tier take totp or sms only; method wins when both differ', () => {
  const schemas = components['schemas']!;
  const request = schemas['AdminStepUpRequest']!;
  expect(Object.keys(request['properties'] as Row).toSorted()).toEqual(['code', 'method', 'tier']);
  expect(flat(request['description'])).toContain(
    'when both are sent and differ, method is used and only it is verified',
  );
  const properties = Object.fromEntries(
    Object.entries(request['properties'] as Row).map(([key, value]) => [key, resolve(value)]),
  );
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile({ ...request, properties });
  const code = '123456';
  expect(validate({ code })).toBe(true);
  for (const field of ['method', 'tier']) {
    for (const value of ['totp', 'sms']) expect(validate({ code, [field]: value })).toBe(true);
    for (const value of ['sudo', 'strict', 'none'])
      expect(validate({ code, [field]: value }), `${field}=${value}`).toBe(false);
  }
});

// Codex money review r2 (D10-2943) ①: every permission point of every me/permissions example shows
// the highest tier of its operations (BR-ID-34 sudo and strict lists, each operation's x-step-up);
// a point on neither list shows null; step_up_operations only lists operations of a lower tier.
const HIGHEST_TIER: Record<string, 'sudo' | 'strict'> = {
  'fund.adjust': 'strict',
  'fund.writeoff': 'strict',
  'payout.execute': 'strict',
  'switch.all': 'strict',
  'config.business': 'strict',
  'fund.recon': 'sudo',
  'withdraw.review': 'sudo',
  'union.pid': 'sudo',
  'union.binding_reset': 'sudo',
  'union.account_auth': 'sudo',
  'risk.freeze': 'sudo',
  'risk.appeal': 'sudo',
  'pii.reveal_phone': 'sudo',
  'pii.reveal_identity': 'sudo',
  'tax.export_full': 'sudo',
};
const RANK: Record<string, number> = { sudo: 1, strict: 2 };

it('[CT-24zzv] me/permissions examples: each point shows its highest tier; listed operations are lower', () => {
  const me = (contract['paths'] as Record<string, Row>)['/admin/v1/me/permissions']!['get'] as Row;
  const ok = resolve((me['responses'] as Row)['200']);
  const media = (ok['content'] as Record<string, Row>)['application/json']!;
  const examples = Object.entries((media['examples'] ?? {}) as Row).map(
    ([name, entry]) => [name, resolve(entry)['value'] as Row] as const,
  );
  if (media['example'] !== undefined) examples.push(['example', media['example'] as Row]);
  expect(examples.length).toBeGreaterThan(0);
  let points = 0;
  for (const [name, value] of examples) {
    for (const grant of ((value['data'] as Row)['permissions'] ?? []) as Row[]) {
      points += 1;
      const key = String(grant['key']);
      const tier = grant['step_up_tier'] as string | null;
      expect(tier, `${name} ${key}`).toBe(HIGHEST_TIER[key] ?? null);
      for (const entry of grant['step_up_operations'] as Row[]) {
        const rank = RANK[String(entry['tier'])];
        expect(rank, `${name} ${key} ${String(entry['operation'])}`).toBeDefined();
        expect(rank, `${name} ${key} ${String(entry['operation'])}`).toBeLessThan(
          tier === null ? 0 : RANK[tier]!,
        );
      }
    }
  }
  expect(points).toBeGreaterThan(0);
});

// Codex money review r2 (D10-2943) ②: code=0 with outcome=rejected is a definite rejection, so the
// strict token is not spent and the same operation may retry with it. The token header, the issue
// operation and the payout batch say so alike, and each marks the 2xx-means-spent server behaviour
// as transitional until B1-18l.
it('[CT-24zzv] code=0 with outcome=rejected leaves the token unspent, said alike in three places', () => {
  const payout = flat(
    ((contract['paths'] as Record<string, Row>)['/admin/v1/payout-batches']!['post'] as Row)[
      'description'
    ],
  );
  for (const [name, text] of [
    ['AdminStepUpToken', tokenText],
    ['adminStepUp', issueText],
    ['adminCreatePayoutBatch', payout],
  ] as const) {
    expect(text, name).toMatch(/outcome=rejected[^.]*\bnot spent\b/);
    expect(text, name).toMatch(/\bsame operation may be retried with\b/);
    expect(text, name).toContain('transitional until b1-18l');
    expect(text, name).not.toContain('(http 2xx with code=0)');
    // Any sentence about 2xx is the transitional note that names outcome=rejected.
    for (const sentence of text.split(/(?<=[.!?])\s+/).filter((s) => s.includes('2xx')))
      expect(sentence, name).toMatch(/^transitional until b1-18l:.*outcome=rejected included/);
  }
  for (const text of [tokenText, issueText])
    expect(text).toContain('an outcome other than rejected');
  expect(payout).toContain('only an executed answer is that success');
});
