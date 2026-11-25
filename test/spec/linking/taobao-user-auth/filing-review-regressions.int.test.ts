import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it, vi } from 'vitest';
import { createUnionAuthReads } from '../../../../apps/api/src/modules/linking/application/union-auth-reads.ts';
import { UnionBindingExchanger } from '../../../../apps/api/src/modules/linking/application/union-binding-exchanger.ts';
import { createUnionBindings } from '../../../../apps/api/src/modules/linking/application/union-bindings.ts';
import {
  createIdempotency,
  systemScheduler,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createGovernedAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { connect, newBinding, requireTable } from '../../db/linking-bindings/kit.ts';
import { endpoint, response, setup } from '../../union/taobao-core/kit.ts';
import {
  APP_KEY,
  CODE,
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
const APP_REF = 'synthetic-filing-review-app';
const RELATION = '819712';
const DEPENDENCY_FAILURE = {
  status: 'fulfilled',
  value: { status: 500, envelope: { code: 50001 } },
};

function duplicateSave(data: { relation_id?: string } = {}) {
  return { tbk_sc_publisher_info_save_response: { data: { desc: '重复绑定渠道', ...data } } };
}

async function fixture(saveAnswer: unknown) {
  const db = database();
  connect(db);
  await requireTable('union_filing_attempts');
  const shop = await setupShop(db);
  const { account, appId, a: userId, device: deviceId, clock, options } = shop;
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
  transport.mockImplementation(async ({ url, body }) => {
    if (url === TOKEN_ENDPOINT) return response(tokenAnswer());
    const method = new URLSearchParams(body ?? '').get('method');
    if (method === SAVE) return response(saveAnswer);
    if (method === GET) {
      return response({
        tbk_sc_publisher_info_get_response: {
          data: { inviter_list: { map_data: [{ relation_app: 'common', relation_id: RELATION }] } },
        },
      });
    }
    throw new Error('合成备案夹具收到未预期的请求');
  });

  expect(adapter.bindPublisher).toBeTypeOf('function');
  const governed = createGovernedAdapter(adapter, {
    endpoint,
    scheduler: systemScheduler(),
    quota: { bucketKey: endpoint.quotaKey, tryAcquire: () => true },
  });
  expect(governed.bindPublisher).toBeTypeOf('function');
  const bindingWarn = vi.fn<(...args: unknown[]) => void>();
  const service = createUnionBindings({
    db,
    clock,
    callerContext: options.callerContext,
    reads: createUnionAuthReads({ ...options, appEnv: 'staging' }),
    idempotency: createIdempotency({ db, clock, logger: { warn: bindingWarn } }),
    exchanger: new UnionBindingExchanger(() => governed.bindPublisher?.bind(governed) ?? null, {
      resolveApp: (ref, method) =>
        ref === APP_REF && method === 'web_code'
          ? { appKey: APP_KEY, redirectUri: USER_REDIRECT }
          : null,
    }),
    logger: { warn: bindingWarn },
  });
  expect(service.bind).toBeTypeOf('function');

  const scope = { app_id: appId, user_id: userId, platform: 'taobao', union_account_id: account };

  async function newState(usedAt: Date | null = null) {
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

  function submission(state: string) {
    const request = {
      platform: 'taobao',
      body: { state, auth_method: 'web_code', code: CODE },
      idempotencyKey: randomUUID(),
      traceId: randomUUID(),
    } as const;
    return async function submit() {
      try {
        return { status: 'fulfilled' as const, value: await service.bind(request) };
      } catch (reason) {
        return { status: 'rejected' as const, reason };
      }
    };
  }

  async function attempts(state: string) {
    const result = await sql<{
      id: string;
      started_at: Date;
      outcome: string | null;
      finished_at: Date | null;
    }>`
      SELECT id, started_at, outcome, finished_at FROM app.union_filing_attempts
      WHERE app_id = ${appId} AND user_id = ${userId} AND platform = 'taobao'
        AND union_account_id = ${account} AND state = ${state}
    `.execute(db);
    return result.rows;
  }

  function bindings() {
    return db
      .selectFrom('union_bindings')
      .select(['id', 'union_account_id', 'relation_id', 'status'])
      .where('app_id', '=', appId)
      .where('user_id', '=', userId)
      .where('platform', '=', 'taobao')
      .execute();
  }

  function duplicateWarnings() {
    return [...warn.mock.calls, ...bindingWarn.mock.calls].flatMap(([entry, message]) => {
      const fields = entry !== null && typeof entry === 'object' ? entry : {};
      const kind = [entry, message, ...Object.values(fields)].find(
        (value) => value === 'duplicate_unverified' || value === 'duplicate_after_unknown_attempt',
      );
      const id = 'earlier_attempt_id' in fields ? fields.earlier_attempt_id : undefined;
      return kind === undefined ? [] : [{ kind, earlierAttemptId: id }];
    });
  }

  const methods = () =>
    transport.mock.calls.map(([{ url, body }]) =>
      url === TOKEN_ENDPOINT ? 'oauth' : new URLSearchParams(body ?? '').get('method'),
    );
  return {
    db,
    scope,
    clock,
    addAccount: shop.addAccount,
    newState,
    submission,
    attempts,
    bindings,
    duplicateWarnings,
    methods,
  };
}

it('[AC-B1-04zzzzp#1] save 同时返回重复标志和编号时，按重复落单且仅接受同归属的历史编号', async () => {
  const f = await fixture(duplicateSave({ relation_id: RELATION }));
  const otherAccount = await f.addAccount();
  const otherHistory = await newBinding({
    ...f.scope,
    union_account_id: otherAccount,
    relation_id: RELATION,
    status: 'released',
  });
  const released = {
    id: otherHistory['id'],
    union_account_id: otherAccount,
    relation_id: RELATION,
    status: 'released',
  };
  const state = await f.newState();
  const refused = await f.submission(state)();

  expect(refused).toMatchObject(DEPENDENCY_FAILURE);
  expect(await f.attempts(state)).toMatchObject([
    { outcome: 'duplicate', finished_at: expect.any(Date) },
  ]);
  expect(await f.bindings()).toEqual([released]);
  expect(f.duplicateWarnings()).toEqual([
    { kind: 'duplicate_unverified', earlierAttemptId: undefined },
  ]);

  const history = await newBinding({ ...f.scope, relation_id: RELATION, status: 'invalid' });
  const nextState = await f.newState();
  const accepted = await f.submission(nextState)();

  expect(accepted).toMatchObject({ status: 'fulfilled', value: { envelope: { code: 0 } } });
  expect(await f.attempts(nextState)).toMatchObject([
    { outcome: 'duplicate', finished_at: expect.any(Date) },
  ]);
  const bindings = await f.bindings();
  expect(bindings).toHaveLength(2);
  expect(bindings).toEqual(
    expect.arrayContaining([
      released,
      {
        id: history['id'],
        union_account_id: f.scope.union_account_id,
        relation_id: RELATION,
        status: 'active',
      },
    ]),
  );
});

it('[AC-B1-04zzzzp#2] save 的网关系统超时保留未知结局，首次答复和同键重放均不报凭证无效', async () => {
  const f = await fixture({ error_response: { code: 15, sub_code: 'isp.remote-service-timeout' } });
  const state = await f.newState();
  const submit = f.submission(state);
  const first = await submit();
  const firstAttempts = await f.attempts(state);
  const replay = await submit();

  expect(first).toMatchObject(DEPENDENCY_FAILURE);
  expect(replay).toMatchObject({ status: 'fulfilled' });
  expect(replay).not.toMatchObject({
    value: { envelope: { code: 30104, data: { reason: 'credential_invalid' } } },
  });
  expect(firstAttempts).toMatchObject([{ outcome: null, finished_at: null }]);
  expect(await f.attempts(state)).toEqual(firstAttempts);
  expect(await f.bindings()).toEqual([]);
  expect(f.methods().filter((method) => method === SAVE)).toHaveLength(1);
});
