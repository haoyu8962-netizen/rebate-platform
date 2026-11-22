import { randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createAgentPrivacyConsentChecks } from '../../../../apps/api/src/modules/identity/application/agent-privacy-consent.ts';
import type * as Privacy from '../../../../apps/api/src/modules/identity/application/privacy-consent.ts';
import {
  NOW,
  ROOT,
  activate,
  consent,
  privacyError,
  request,
  user,
} from '../privacy-min-version/kit.ts';

const CURRENT = '/v1/agent/sessions/current';
const MIN_VERSION = 3;
const LATER = '2026-10-17T02:00:01Z';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: ReturnType<typeof createDb>;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 3 });
}, 180_000);

afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
});

async function fixture() {
  const appId = `agent_privacy_${randomUUID()}`;
  const uid = await user(db, appId);
  const configValue = vi.fn<Privacy.PrivacyConsentConfigReader['configValue']>(async () => ({
    value: MIN_VERSION,
    version: 1,
  }));
  const options: Privacy.PrivacyConsentOptions = {
    db,
    config: { pooled: { configValue }, on: () => ({ configValue }) },
    logger: { warn: vi.fn() },
  };
  return { appId, uid, options, configValue, input: request(appId, uid, 'GET', CURRENT) };
}

it('[AC-B3-08zi#11] 同一 app 只读调用者的隐私同意，即使另一用户的记录更新', async () => {
  const f = await fixture();
  const other = await user(db, f.appId);
  await consent(db, f.appId, f.uid, { version: MIN_VERSION });
  await consent(db, f.appId, other, { version: MIN_VERSION - 1, at: LATER });
  const checks = createAgentPrivacyConsentChecks(f.options);
  await expect(activate(checks, f.input)).resolves.toBe(true);

  await consent(db, f.appId, f.uid, { version: MIN_VERSION - 1, at: LATER });
  await consent(db, f.appId, other, { version: MIN_VERSION, at: '2026-10-17T02:00:02Z' });
  await expect(activate(checks, f.input)).rejects.toMatchObject(privacyError(f.input.id));
});

it('[AC-B3-08zi#11] 调用者更新的 agreement 撤回不影响隐私同意', async () => {
  const f = await fixture();
  await consent(db, f.appId, f.uid, { version: MIN_VERSION });
  await consent(db, f.appId, f.uid, { type: 'agreement', accepted: false, at: LATER });
  const checks = createAgentPrivacyConsentChecks(f.options);
  await expect(activate(checks, f.input)).resolves.toBe(true);
});

it('[AC-B3-08zi#11] server_at 相同的用户级隐私记录按最大 id 判定', async () => {
  const f = await fixture();
  const checks = createAgentPrivacyConsentChecks(f.options);
  const first = await consent(db, f.appId, f.uid, { version: MIN_VERSION + 1, at: NOW });
  const withdrawal = await consent(db, f.appId, f.uid, {
    version: MIN_VERSION,
    accepted: false,
    at: NOW,
  });
  expect(BigInt(withdrawal.id)).toBeGreaterThan(BigInt(first.id));
  await expect(activate(checks, f.input)).rejects.toMatchObject(privacyError(f.input.id));

  const latest = await consent(db, f.appId, f.uid, { version: MIN_VERSION, at: NOW });
  expect(BigInt(latest.id)).toBeGreaterThan(BigInt(withdrawal.id));
  await expect(activate(checks, f.input)).resolves.toBe(true);
});

it.each([
  { name: '最低版本为 0', minVersion: 0, hasDb: true },
  { name: '最低版本为 1.5', minVersion: 1.5, hasDb: true },
  { name: '最低版本超出 int32', minVersion: 2147483648, hasDb: true },
  { name: '最低版本合法但缺少数据库', minVersion: MIN_VERSION, hasDb: false },
])('[AC-B3-08zi#12] $name，Agent 与 API 都返回 50001', async ({ minVersion, hasDb }) => {
  const f = await fixture();
  await consent(db, f.appId, f.uid, { version: MIN_VERSION });
  f.configValue.mockResolvedValue({ value: minVersion, version: 1 });
  const options = { ...f.options, db: hasDb ? db : null };
  const api = (await import(
    new URL('apps/api/src/modules/identity/index.ts', ROOT).href
  )) as typeof Privacy;
  const agentChecks = createAgentPrivacyConsentChecks(options);
  const apiChecks = api.createPrivacyConsentChecks(options);
  const error = { code: 50001, statusCode: 500 };

  await expect(activate(agentChecks, f.input)).rejects.toMatchObject(error);
  await expect(activate(apiChecks, request(f.appId, f.uid))).rejects.toMatchObject(error);
});
