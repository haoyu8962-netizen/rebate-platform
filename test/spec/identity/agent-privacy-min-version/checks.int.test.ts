import { randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as agent from '../../../../apps/api/src/modules/identity/application/agent-privacy-consent.ts';
import type * as Privacy from '../../../../apps/api/src/modules/identity/application/privacy-consent.ts';
import { newGuest } from '../../agent/stream-mount/kit.ts';
import {
  MIN_KEY,
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
const MIN_CONFIG = { value: MIN_VERSION, version: 1 };

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

function readers(handle: Privacy.PrivacyConsentOptions['db']) {
  type ConfigValue = Privacy.PrivacyConsentConfigReader['configValue'];
  const configValue = vi.fn<ConfigValue>(async () => MIN_CONFIG);
  const warn = vi.fn();
  const options: Privacy.PrivacyConsentOptions = {
    db: handle,
    config: { pooled: { configValue }, on: () => ({ configValue }) },
    logger: { warn },
  };
  return { configValue, warn, options };
}

async function fixture() {
  const appId = `agent_privacy_${randomUUID()}`;
  const uid = await user(db, appId);
  return { appId, uid, input: request(appId, uid, 'GET', CURRENT), ...readers(db) };
}

const agentRoutes = [
  ['POST', '/v1/agent/sessions'],
  ['GET', CURRENT],
  ['GET', '/v1/agent/sessions/:id/messages'],
  ['POST', '/v1/agent/sessions/:id/messages'],
  ['POST', '/v1/agent/runs/:run_id/cancel'],
  ['POST', '/v1/agent/messages/:message_id/feedback'],
  ['POST', '/v1/agent/messages/:message_id/report'],
] as const;

it.each(agentRoutes)('[AC-B3-08zi#1] %s %s 隐私版本过低', async (method, path) => {
  const f = await fixture();
  await consent(db, f.appId, f.uid, { version: MIN_VERSION - 1 });
  const input = request(f.appId, f.uid, method, path);
  const checks = agent.createAgentPrivacyConsentChecks(f.options);
  await expect(activate(checks, input)).rejects.toMatchObject(privacyError(input.id));
  expect(f.configValue).toHaveBeenCalledWith(f.appId, MIN_KEY);
});

it('[AC-B3-08zi#2] 最新用户级隐私记录为撤回，即使版本达标也返回 10004 privacy', async () => {
  const f = await fixture();
  await consent(db, f.appId, f.uid, {
    accepted: false,
    version: MIN_VERSION,
    at: '2026-10-17T02:00:01Z',
  });
  await consent(db, f.appId, f.uid, { version: MIN_VERSION + 1, at: NOW });
  const checks = agent.createAgentPrivacyConsentChecks(f.options);
  await expect(activate(checks, f.input)).rejects.toMatchObject(privacyError(f.input.id));
});

it('[AC-B3-08zi#3] 最新用户级隐私同意恰好达到最低版本，随后设备级撤回仍放行', async () => {
  const f = await fixture();
  const device = await newGuest(db, f.appId);
  await consent(db, f.appId, f.uid, { version: MIN_VERSION - 1 });
  await consent(db, f.appId, f.uid, { version: MIN_VERSION, at: '2026-10-17T02:00:01Z' });
  await consent(db, f.appId, f.uid, {
    subject: 'device',
    device: device.deviceId,
    accepted: false,
    at: '2026-10-17T02:00:02Z',
  });
  const checks = agent.createAgentPrivacyConsentChecks(f.options);
  const input = { ...f.input, principal: { ...f.input.principal!, device_id: device.deviceId } };
  await expect(activate(checks, input)).resolves.toBe(true);
});

it('[AC-B3-08zi#4] 游客无令牌，调用 Agent 放行且不读库和配置', async () => {
  const f = readers(null);
  const input = { ...request('agent_guest', randomUUID(), 'GET', CURRENT) };
  delete input.principal;
  const checks = agent.createAgentPrivacyConsentChecks(f.options);
  await expect(activate(checks, input)).resolves.toBe(true);
  expect(f.configValue).not.toHaveBeenCalled();
});

const INTERNAL_ERROR = { code: 50001, statusCode: 500 };

const parityCases = [
  { name: '无用户级记录', record: false, config: MIN_CONFIG, failure: null, allow: true },
  { name: '最低版本缺失', record: true, config: null, failure: null, allow: true },
  {
    name: '最低版本不合法',
    record: true,
    config: { ...MIN_CONFIG, value: '3' },
    failure: null,
    allow: false,
  },
  { name: '读取配置失败', record: true, config: MIN_CONFIG, failure: 'config', allow: false },
  { name: '读取同意记录失败', record: true, config: MIN_CONFIG, failure: 'consent', allow: false },
] as const;

it.each(parityCases)('[AC-B3-08zi#5] $name 与 API 同结果', async (scenario) => {
  const { record, config, failure, allow } = scenario;
  const f = await fixture();
  if (record) await consent(db, f.appId, f.uid, { version: MIN_VERSION - 1 });
  f.configValue.mockResolvedValue(config);
  if (failure === 'config') f.configValue.mockRejectedValue(new Error('fixture config failed'));
  const handle =
    failure === 'consent'
      ? db.withPlugin({
          transformQuery() {
            throw new Error('fixture consent read failed');
          },
          async transformResult({ result }) {
            return result;
          },
        })
      : db;
  const api = (await import(
    new URL('apps/api/src/modules/identity/index.ts', ROOT).href
  )) as typeof Privacy;
  const agentChecks = agent.createAgentPrivacyConsentChecks({ ...f.options, db: handle });
  const apiWarn = vi.fn();
  const apiChecks = api.createPrivacyConsentChecks({
    ...f.options,
    db: handle,
    logger: { warn: apiWarn },
  });
  const calls = [
    [agentChecks, f.input],
    [apiChecks, request(f.appId, f.uid)],
  ] as const;
  for (const [checks, input] of calls) {
    const result = activate(checks, input);
    if (allow) await expect(result).resolves.toBe(true);
    else await expect(result).rejects.toMatchObject(INTERNAL_ERROR);
  }
  if (config === null) {
    expect(f.warn).toHaveBeenCalledWith({ config_key: MIN_KEY }, expect.any(String));
    expect(apiWarn).toHaveBeenCalledWith({ config_key: MIN_KEY }, expect.any(String));
  }
});

it.each(['/v1/me', '/v1/config', '/v1/agent-other/sessions'])(
  '[AC-B3-08zi#6] 非 Agent 路由 GET %s 放行且不读库和配置',
  async (path) => {
    const f = readers(null);
    const checks = agent.createAgentPrivacyConsentChecks(f.options);
    const input = request('agent_other', randomUUID(), 'GET', path);
    await expect(activate(checks, input)).resolves.toBe(true);
    expect(f.configValue).not.toHaveBeenCalled();
  },
);

it('[AC-B3-08zi#7] 隐私同意只在记录所属 app 生效', async () => {
  const f = await fixture();
  const otherApp = `agent_privacy_${randomUUID()}`;
  await consent(db, f.appId, f.uid, { version: MIN_VERSION });
  f.configValue.mockImplementation(async (appId) =>
    appId === otherApp ? { ...MIN_CONFIG, value: MIN_VERSION + 1 } : MIN_CONFIG,
  );
  const cross = request(otherApp, f.uid, 'GET', CURRENT);
  const checks = agent.createAgentPrivacyConsentChecks(f.options);
  // users.id 全局唯一，同一 uid 只能在所属 app 写同意记录。跨 app 查应找不到记录并放行。
  // 若遗漏 app_id 条件，借到的版本会低于请求 app 的门槛，导致错误拒绝。
  await expect(activate(checks, cross)).resolves.toBe(true);
  expect(f.configValue).toHaveBeenCalledWith(otherApp, MIN_KEY);
  await expect(activate(checks, f.input)).resolves.toBe(true);
});
