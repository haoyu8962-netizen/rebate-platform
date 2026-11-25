import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import { UnionBindingExchanger } from '../../../../apps/api/src/modules/linking/application/union-binding-exchanger.ts';
import { createUnionBindings } from '../../../../apps/api/src/modules/linking/application/union-bindings.ts';
import { createUnionAuthReads } from '../../../../apps/api/src/modules/linking/application/union-auth-reads.ts';
import {
  createIdempotency,
  createResilienceRegistry,
  GovernanceError,
  systemScheduler,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createGovernedAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { connect, requireTable } from '../../db/linking-bindings/kit.ts';
import { endpoint, expectRedacted, response, setup } from '../../union/taobao-core/kit.ts';
import {
  ACCESS,
  APP_KEY,
  CODE,
  REFRESH,
  SECRET,
  TOKEN_ENDPOINT,
  tokenAnswer,
} from '../../union/taobao-site-oauth/kit.ts';
import { databaseFixture } from '../open-requote/kit.ts';
import { setup as setupShop } from '../shop-open/kit.ts';
import { INVITER_CODE, USER_REDIRECT } from './kit.ts';

const database = databaseFixture(createTestDatabase);
const SAVE = 'taobao.tbk.sc.publisher.info.save';
const GET = 'taobao.tbk.sc.publisher.info.get';
const APP_REF = 'synthetic-governed-lookup-app';
const USER_ID = '2200000000208';
const USER_NICK = '合成备案用户昵称';
const PRIVATE_MARKERS = [
  CODE,
  ACCESS,
  REFRESH,
  SECRET,
  INVITER_CODE,
  USER_ID,
  USER_NICK,
  encodeURIComponent(USER_NICK),
];

it('[AC-B1-04zzzzn#22] 重复备案查回被治理层超时取消时，告警带更早的未知尝试编号', async () => {
  const db = database();
  const { account, appId, a: userId, device: deviceId, clock, options } = await setupShop(db);
  connect(db);
  await requireTable('union_filing_attempts');

  const earlierId = randomUUID();
  const earlierState = randomUUID();
  const state = randomUUID();
  const earlierStartedAt = new Date(clock.now().getTime() - 10_000);
  const session = {
    app_id: appId,
    user_id: userId,
    device_id: deviceId,
    client: 'ios',
    platform: 'taobao',
    mode: 'bind',
    created_at: new Date(clock.now().getTime() - 60_000),
    expire_at: new Date(clock.now().getTime() + 300_000),
    auth_methods: ['web_code'],
    auth_app_refs: { web_code: APP_REF },
  };
  await db
    .insertInto('union_auth_sessions')
    .values([
      { ...session, state: earlierState, used_at: earlierStartedAt },
      { ...session, state, used_at: null },
    ])
    .execute();
  await db
    .insertInto('union_filing_attempts')
    .values({
      id: earlierId,
      app_id: appId,
      user_id: userId,
      platform: 'taobao',
      union_account_id: account,
      state: earlierState,
      started_at: earlierStartedAt,
      outcome: null,
      finished_at: null,
    })
    .execute();

  const oauthApp = { appKey: APP_KEY, redirectUri: USER_REDIRECT };
  const { adapter, transport, warn } = setup({
    clock,
    credentials: async () => ({
      appKey: APP_KEY,
      appSecret: SECRET,
      userOAuth: {
        redirectUri: USER_REDIRECT,
        inviterCode: INVITER_CODE,
        inviterAccountId: account,
      },
    }),
  });
  const governed = createGovernedAdapter(adapter, {
    endpoint,
    scheduler: systemScheduler(),
    // 同一个时限也覆盖 save 前的数据库写入，给它留出余量。
    resilience: createResilienceRegistry({ 'union.search': { timeoutMs: 250 } }),
    quota: { bucketKey: endpoint.quotaKey, tryAcquire: () => true },
  });
  expect(governed.bindPublisher).toBeTypeOf('function');

  const lookupAborted = vi.fn<(reason: unknown) => void>();
  transport.mockImplementation(async ({ url, body, signal }) => {
    if (url === TOKEN_ENDPOINT) {
      return response(
        tokenAnswer({ taobao_user_id: USER_ID, taobao_user_nick: encodeURIComponent(USER_NICK) }),
      );
    }
    const method = new URLSearchParams(body ?? '').get('method');
    if (method === SAVE) {
      return response({
        tbk_sc_publisher_info_save_response: { data: { desc: '重复绑定渠道' } },
      });
    }
    if (method === GET && signal !== undefined) {
      signal.throwIfAborted();
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            lookupAborted(signal.reason);
            reject(new Error(`合成查回被取消 ${PRIVATE_MARKERS.join(' ')}`));
          },
          { once: true },
        );
      });
    }
    throw new Error('合成备案夹具收到未预期的请求');
  });

  const bindingWarn = vi.fn<(...args: unknown[]) => void>();
  const [reply] = await Promise.allSettled([
    (async () => {
      const service = createUnionBindings({
        db,
        clock,
        callerContext: options.callerContext,
        reads: createUnionAuthReads({ ...options, appEnv: 'staging' }),
        idempotency: createIdempotency({ db, clock, logger: { warn: bindingWarn } }),
        exchanger: new UnionBindingExchanger(() => governed.bindPublisher?.bind(governed) ?? null, {
          resolveApp: (ref, method) => (ref === APP_REF && method === 'web_code' ? oauthApp : null),
        }),
        logger: { warn: bindingWarn },
      });
      return service.bind({
        platform: 'taobao',
        body: { state, auth_method: 'web_code', code: CODE },
        idempotencyKey: randomUUID(),
        traceId: randomUUID(),
      });
    })(),
  ]);

  expect(reply).toMatchObject({
    status: 'fulfilled',
    value: { status: 500, envelope: { code: 50001 } },
  });
  expect(
    transport.mock.calls.map(([{ url, body }]) =>
      url === TOKEN_ENDPOINT ? 'oauth' : new URLSearchParams(body ?? '').get('method'),
    ),
  ).toEqual(['oauth', SAVE, GET]);
  expect(lookupAborted).toHaveBeenCalledTimes(1);
  expect(lookupAborted.mock.calls[0]?.[0]).toBeInstanceOf(GovernanceError);
  expect(lookupAborted.mock.calls[0]?.[0]).toMatchObject({ code: 'timeout' });
  expect(
    await db
      .selectFrom('union_bindings')
      .select('id')
      .where('app_id', '=', appId)
      .where('user_id', '=', userId)
      .execute(),
  ).toEqual([]);
  expect(
    await db
      .selectFrom('union_filing_attempts')
      .select(['id', 'state', 'outcome', 'finished_at'])
      .where('app_id', '=', appId)
      .where('user_id', '=', userId)
      .where('platform', '=', 'taobao')
      .where('union_account_id', '=', account)
      .orderBy('started_at')
      .execute(),
  ).toEqual([
    { id: earlierId, state: earlierState, outcome: null, finished_at: null },
    { id: expect.any(String), state, outcome: 'duplicate', finished_at: expect.any(Date) },
  ]);

  const warnings = [...warn.mock.calls, ...bindingWarn.mock.calls];
  expectRedacted([reply, warnings], PRIVATE_MARKERS);
  const duplicateWarnings = warnings.flatMap(([entry, message]) => {
    const fields = entry !== null && typeof entry === 'object' ? entry : {};
    const kind = [entry, message, ...Object.values(fields)].find(
      (value) => value === 'duplicate_after_unknown_attempt' || value === 'duplicate_unverified',
    );
    return kind === undefined ? [] : [{ kind, fields }];
  });
  expect(duplicateWarnings).toEqual([
    {
      kind: 'duplicate_after_unknown_attempt',
      fields: expect.objectContaining({ earlier_attempt_id: earlierId }),
    },
  ]);
});
