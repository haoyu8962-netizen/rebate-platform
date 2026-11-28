import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import { createUnionAuthReads } from '../../../../apps/api/src/modules/linking/application/union-auth-reads.ts';
import { createUnionAuthUrl } from '../../../../apps/api/src/modules/linking/application/union-auth-url.ts';
import { UnionBindingExchanger } from '../../../../apps/api/src/modules/linking/application/union-binding-exchanger.ts';
import { createUnionBindings } from '../../../../apps/api/src/modules/linking/application/union-bindings.ts';
import {
  createTaobaoUnionAuthApps,
  resolveIssuedTaobaoOAuthApp,
} from '../../../../apps/api/src/modules/linking/infra/auth-apps.ts';
import {
  createRootLogger,
  systemScheduler,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createGovernedAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { createArchivingTransport } from '../../../../apps/api/src/modules/union/infra/archive.ts';
import type { UnionTransport } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import { logTaobaoWarning } from '../../../../apps/api/src/modules/union/union.module.ts';
import { endpoint, formFields, response, sent, setup } from '../../union/taobao-core/kit.ts';
import {
  APP_KEY,
  CODE,
  SECRET,
  TOKEN_ENDPOINT,
  tokenAnswer,
} from '../../union/taobao-site-oauth/kit.ts';
import { setup as setupShop } from '../shop-open/kit.ts';
import { INVITER_CODE, USER_REDIRECT } from '../taobao-user-auth/kit.ts';

// 合成凭证刻意包含表单保留字符，便于识别被截断、解码或二次编码的 session。
export const SDK_TOKEN = 'synthetic-sdk+access/%2B=token';
export const RELATION = '000819712';
export const SAVE = 'taobao.tbk.sc.publisher.info.save';
export const GET = 'taobao.tbk.sc.publisher.info.get';
export const ACCEPTED = { status: 200, envelope: { code: 0 } };
export const UNAVAILABLE = { status: 500, envelope: { code: 50001 } };
export const METHOD_NOT_ALLOWED = {
  status: 422,
  envelope: { code: 30104, data: { reason: 'method_not_allowed' } },
};
export const CREDENTIAL_INVALID = {
  status: 422,
  envelope: { code: 30104, data: { reason: 'credential_invalid' } },
};

type Environment = 'staging' | 'prod';

export async function fixture(db: Kysely<DB>) {
  const shop = await setupShop(db);
  const { account, appId, a: userId, device, clock, options } = shop;
  await db
    .updateTable('devices')
    .set({ platform: 'android', id_source: 'android_id' })
    .where('app_id', '=', appId)
    .where('id', '=', device)
    .execute();
  const configKey = 'union.taobao.auth_methods.android';
  shop.config.set(configKey, ['sdk_token', 'web_code']);

  const transport = vi.fn<UnionTransport>(async ({ url, body }) => {
    if (url === TOKEN_ENDPOINT) return response(tokenAnswer());
    if (new URLSearchParams(body ?? '').get('method') === SAVE) {
      return response({
        tbk_sc_publisher_info_save_response: { data: { relation_id: RELATION } },
      });
    }
    throw new Error('合成传输收到未预期的淘宝请求');
  });
  const archiveLogger = { warn: vi.fn(), error: vi.fn() };
  const topLogs: string[] = [];
  const rootLogger = createRootLogger(
    { level: 'warn', entry: 'api', appEnv: 'staging' },
    {
      write: (line) => {
        topLogs.push(line);
      },
    },
  );
  const { adapter } = setup({
    clock,
    transport: createArchivingTransport(transport, { db, clock, logger: archiveLogger }),
    warn: (warning) => logTaobaoWarning(rootLogger, warning),
    credentials: async () => ({
      appKey: APP_KEY,
      appSecret: SECRET,
      userOAuth: {
        // 网页授权使用 state 引用里的回调地址。SDK 引用只有应用标识。
        redirectUri: null,
        inviterCode: INVITER_CODE,
        inviterAccountId: account,
      },
    }),
  });
  const governed = createGovernedAdapter(adapter, {
    endpoint,
    scheduler: systemScheduler(),
    quota: { bucketKey: endpoint.quotaKey, tryAcquire: () => true },
  });
  const adapterErrors: unknown[] = [];
  const publisher = vi.fn(async (...args: Parameters<typeof adapter.bindPublisher>) => {
    try {
      return await governed.bindPublisher!(...args);
    } catch (error) {
      adapterErrors.push(error);
      throw error;
    }
  });
  const exchanger = new UnionBindingExchanger(() => publisher, {
    resolveApp: resolveIssuedTaobaoOAuthApp,
  });
  const linkingWarn = vi.fn<(...args: unknown[]) => void>();

  const session = (state: string) =>
    db
      .selectFrom('union_auth_sessions')
      .select(['client', 'auth_methods', 'auth_app_refs', 'used_at'])
      .where('app_id', '=', appId)
      .where('state', '=', state)
      .executeTakeFirstOrThrow();

  async function issue(appEnv: Environment = 'staging', appKey = APP_KEY) {
    const authApps = createTaobaoUnionAuthApps({ appKey, redirectUri: USER_REDIRECT });
    const issued = await createUnionAuthUrl({
      ...options,
      appEnv,
      authApps,
      logger: { warn: linkingWarn },
    }).get({
      platform: 'taobao',
      reportedClient: 'android',
      traceId: randomUUID(),
    });
    expect(issued).toMatchObject({
      status: 200,
      envelope: { code: 0, data: { state: expect.any(String) } },
    });
    const { state } = issued.envelope.data as { state: string };
    return { state, issued, row: await session(state) };
  }

  async function issueSdk(appKey = APP_KEY) {
    const issuance = await issue('staging', appKey);
    const methods = ['sdk_token', 'web_code'];
    expect(issuance.issued.envelope.data).toMatchObject({ auth_methods: methods });
    expect(issuance.row).toMatchObject({
      client: 'android',
      auth_methods: methods,
      auth_app_refs: { sdk_token: expect.any(String), web_code: expect.any(String) },
      used_at: null,
    });
    return issuance;
  }

  const submit = (
    state: string,
    appEnv: Environment = 'staging',
    authMethod: 'sdk_token' | 'web_code' = 'sdk_token',
  ) =>
    createUnionBindings({
      db,
      clock,
      callerContext: options.callerContext,
      reads: createUnionAuthReads({ ...options, appEnv }),
      idempotency: shop.idempotency,
      exchanger,
      logger: { warn: linkingWarn },
    }).bind({
      platform: 'taobao',
      body:
        authMethod === 'sdk_token'
          ? { state, auth_method: authMethod, access_token: SDK_TOKEN, expires_in: 3600 }
          : { state, auth_method: authMethod, code: CODE },
      idempotencyKey: randomUUID(),
      traceId: randomUUID(),
    });

  const attempts = (state: string) =>
    db
      .selectFrom('union_filing_attempts')
      .select(['state', 'union_account_id', 'outcome', 'finished_at'])
      .where('app_id', '=', appId)
      .where('user_id', '=', userId)
      .where('state', '=', state)
      .execute();
  const bindings = () =>
    db
      .selectFrom('union_bindings')
      .select(['id', 'user_id', 'union_account_id', 'relation_id', 'status'])
      .where('app_id', '=', appId)
      .where('platform', '=', 'taobao')
      .execute();
  const archive = () =>
    db.selectFrom('union_raw_payloads').select('id').where('app_id', '=', appId).execute();

  function expectSdkCalls(...methods: string[]) {
    expect(transport).toHaveBeenCalledTimes(methods.length);
    for (const [index, method] of methods.entries()) {
      const request = sent(transport, index);
      expect(request).toMatchObject({ platform: 'taobao', url: endpoint.baseUrl, method: 'POST' });
      expect(request.archive).toBeUndefined();
      const form = formFields(request);
      expect(form).toMatchObject({ app_key: APP_KEY, session: SDK_TOKEN, method, info_type: '1' });
      expect(form).not.toHaveProperty('code');
      if (method === SAVE) expect(form).toHaveProperty('inviter_code', INVITER_CODE);
      if (method === GET) expect(form).toHaveProperty('relation_app', 'common');
    }
  }

  return {
    ...shop,
    adapterErrors,
    archive,
    attempts,
    bindings,
    configKey,
    expectSdkCalls,
    issue,
    issueSdk,
    logs: () => [
      ...topLogs,
      ...linkingWarn.mock.calls,
      ...archiveLogger.warn.mock.calls,
      ...archiveLogger.error.mock.calls,
    ],
    publisher,
    session,
    submit,
    topLogs,
    transport,
  };
}
