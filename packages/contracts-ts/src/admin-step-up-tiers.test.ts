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
