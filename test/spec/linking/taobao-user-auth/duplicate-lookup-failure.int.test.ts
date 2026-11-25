import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import { UnionBindingExchanger } from '../../../../apps/api/src/modules/linking/application/union-binding-exchanger.ts';
import { createUnionBindings } from '../../../../apps/api/src/modules/linking/application/union-bindings.ts';
import { createUnionAuthReads } from '../../../../apps/api/src/modules/linking/application/union-auth-reads.ts';
import {
  createIdempotency,
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
const APP_REF = 'synthetic-duplicate-lookup-app';
const USER_ID = '2200000000191';
const USER_NICK = '合成渠道昵称';
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
const LOOKUP_FAILURES = ['超时', '传输失败'] as const;
type LookupFailure = (typeof LOOKUP_FAILURES)[number];

async function checkLookupFailure(withEarlierAttempt: boolean, cause: LookupFailure) {
  const db = database();
  const f = await setupShop(db);
  const { account, appId, a: userId, device: deviceId, clock, options } = f;
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
  expect(adapter.bindPublisher).toBeTypeOf('function');
  const governed = createGovernedAdapter(adapter, {
    endpoint,
    scheduler: systemScheduler(),
    quota: { bucketKey: endpoint.quotaKey, tryAcquire: () => true },
  });
  expect(governed.bindPublisher).toBeTypeOf('function');
  connect(db);
  await requireTable('union_filing_attempts');

  async function authSession(usedAt: Date | null) {
    const state = randomUUID();
    await db
      .insertInto('union_auth_sessions')
      .values({
        state,
        app_id: appId,
        user_id: userId,
        device_id: deviceId,
        client: 'ios',
        platform: 'taobao',
        mode: 'bind',
        created_at: new Date(clock.now().getTime() - 60_000),
        expire_at: new Date(clock.now().getTime() + 300_000),
        used_at: usedAt,
        auth_methods: ['web_code'],
        auth_app_refs: { web_code: APP_REF },
      })
      .execute();
    return state;
  }

  const earlierId = withEarlierAttempt ? randomUUID() : null;
  if (earlierId !== null) {
    const startedAt = new Date(clock.now().getTime() - 10_000);
    await db
      .insertInto('union_filing_attempts')
      .values({
        id: earlierId,
        app_id: appId,
        user_id: userId,
        platform: 'taobao',
        union_account_id: account,
        state: await authSession(startedAt),
        started_at: startedAt,
        outcome: null,
        finished_at: null,
      })
      .execute();
  }
  const state = await authSession(null);
  const detail = `合成查回${cause} ${PRIVATE_MARKERS.join(' ')}`;
  const lookupFailure =
    cause === '超时' ? new DOMException(detail, 'TimeoutError') : new Error(detail);

  transport.mockImplementation(async ({ url, body }) => {
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
    if (method === GET) throw lookupFailure;
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
  expect(
    await db
      .selectFrom('union_bindings')
      .select('id')
      .where('app_id', '=', appId)
      .where('user_id', '=', userId)
      .execute(),
  ).toEqual([]);

  const warnings = [...warn.mock.calls, ...bindingWarn.mock.calls];
  const duplicateWarnings = warnings.flatMap(([entry, message]) => {
    const fields = entry !== null && typeof entry === 'object' ? entry : {};
    const kind = [entry, message, ...Object.values(fields)].find(
      (value) => value === 'duplicate_after_unknown_attempt' || value === 'duplicate_unverified',
    );
    return kind === undefined ? [] : [{ kind, fields }];
  });
  expect(duplicateWarnings).toEqual([
    earlierId === null
      ? { kind: 'duplicate_unverified', fields: expect.any(Object) }
      : {
          kind: 'duplicate_after_unknown_attempt',
          fields: expect.objectContaining({ earlier_attempt_id: earlierId }),
        },
  ]);
  if (earlierId === null) {
    expect(duplicateWarnings[0]?.fields).not.toHaveProperty('earlier_attempt_id');
  }
  expectRedacted([reply, warnings], PRIVATE_MARKERS);
}

it.each(LOOKUP_FAILURES)(
  '[AC-B1-04zzzzn#20] 重复备案查回%s，告警带更早的未知尝试编号',
  async (cause) => {
    await checkLookupFailure(true, cause);
  },
);

it.each(LOOKUP_FAILURES)(
  '[AC-B1-04zzzzn#21] 重复备案查回%s，无更早的未知尝试时告警 duplicate_unverified',
  async (cause) => {
    await checkLookupFailure(false, cause);
  },
);
