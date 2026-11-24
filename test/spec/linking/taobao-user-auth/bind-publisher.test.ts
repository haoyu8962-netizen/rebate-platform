import { expect, it } from 'vitest';
import { UnionBindingExchanger } from '../../../../apps/api/src/modules/linking/application/union-binding-exchanger.ts';
import {
  ctx,
  endpoint,
  expectRedacted,
  formFields,
  response,
  sent,
  setup,
} from '../../union/taobao-core/kit.ts';
import {
  ACCESS,
  APP_KEY,
  CODE,
  REFRESH,
  SECRET,
  TOKEN_ENDPOINT,
  refusal,
  tokenAnswer,
} from '../../union/taobao-site-oauth/kit.ts';
import { INVITER_CODE, USER_REDIRECT } from './kit.ts';

const SAVE = 'taobao.tbk.sc.publisher.info.save';
const GET = 'taobao.tbk.sc.publisher.info.get';
const MARKERS = [CODE, ACCESS, REFRESH, INVITER_CODE, SECRET];

function publisher(inviterCode: string | null = INVITER_CODE) {
  const { adapter, transport, warn } = setup({
    credentials: async () => ({
      appKey: APP_KEY,
      appSecret: SECRET,
      userOAuth: { redirectUri: USER_REDIRECT, inviterCode },
    }),
  });
  transport.mockReset().mockRejectedValue(new Error('合成传输收到未预期的上游请求'));
  const exchanger = new UnionBindingExchanger(() => adapter.bindPublisher.bind(adapter));
  const exchange = (code = CODE) =>
    exchanger.exchange({
      appId: ctx.appId,
      traceId: ctx.requestId,
      method: 'web_code',
      credential: { code },
      appRef: 'synthetic-app-ref',
    });
  return { adapter, exchange, transport, warn };
}

function duplicateSave() {
  return response({ tbk_sc_publisher_info_save_response: { data: { desc: '重复绑定渠道' } } });
}

function expectPublisherRequest(
  transport: ReturnType<typeof publisher>['transport'],
  index: number,
  method: string,
) {
  const request = sent(transport, index);
  expect(request).toMatchObject({ platform: 'taobao', url: endpoint.baseUrl, method: 'POST' });
  expect(request.archive).toBeUndefined();
  const form = formFields(request);
  expect(form).toMatchObject({ method, session: ACCESS, info_type: '1' });
  expect(form).not.toHaveProperty('code');
  return form;
}

function expectSafeWarning(warn: ReturnType<typeof publisher>['warn']) {
  expect(warn).toHaveBeenCalledTimes(1);
  const fields = warn.mock.calls[0]?.[0];
  expect(fields).toEqual(expect.any(Object));
  for (const value of Object.values(fields ?? {})) {
    expect(value === null || ['string', 'number', 'boolean'].includes(typeof value)).toBe(true);
  }
  expectRedacted(warn.mock.calls, MARKERS);
}

it.each([
  ['数字', '9007199254740993', '9007199254740993'],
  ['字符串', '"000811796"', '000811796'],
])('[AC-B1-04zzzzm#3] 用用户令牌备案，保留%s relation_id', async (_, wireId, expectedId) => {
  const { exchange, transport, warn } = publisher();
  const saved = response({});
  transport.mockResolvedValueOnce(response(tokenAnswer())).mockResolvedValueOnce({
    ...saved,
    body: `{"tbk_sc_publisher_info_save_response":{"data":{"relation_id":${wireId},"account_name":"合成昵称"}}}`,
  });

  expect(await exchange()).toEqual({ kind: 'bound', relationId: expectedId });
  expect(transport).toHaveBeenCalledTimes(2);
  const oauth = sent(transport);
  expect(oauth).toMatchObject({ platform: 'taobao', method: 'POST', url: TOKEN_ENDPOINT });
  const contentType = Object.entries(oauth.headers).find(
    ([name]) => name.toLowerCase() === 'content-type',
  );
  expect(contentType?.[1]).toMatch(/^application\/x-www-form-urlencoded(?:\s*;|$)/i);
  expect(formFields(oauth)).toEqual({
    grant_type: 'authorization_code',
    client_id: APP_KEY,
    client_secret: SECRET,
    code: CODE,
    redirect_uri: USER_REDIRECT,
  });
  expect(oauth.archive).toBeUndefined();
  expect(expectPublisherRequest(transport, 1, SAVE)).toHaveProperty('inviter_code', INVITER_CODE);
  expectRedacted(warn.mock.calls, MARKERS);
});

it('[AC-B1-04zzzzm#4] 保存和查询均无编号时备案失败并告警', async () => {
  const { exchange, transport, warn } = publisher();
  transport
    .mockResolvedValueOnce(response(tokenAnswer()))
    .mockResolvedValueOnce(duplicateSave())
    .mockResolvedValueOnce(
      response({
        tbk_sc_publisher_info_get_response: {
          data: { total_count: 0, inviter_list: { map_data: [] } },
        },
      }),
    );

  const [result] = await Promise.allSettled([exchange()]);
  expect(transport).toHaveBeenCalledTimes(3);
  expectPublisherRequest(transport, 1, SAVE);
  expectPublisherRequest(transport, 2, GET);
  if (result?.status === 'fulfilled') {
    expect(result.value).toEqual({ kind: 'credential_invalid' });
  } else {
    expect(result?.reason).toBeInstanceOf(Error);
  }
  expectRedacted(result, MARKERS);
  expectSafeWarning(warn);
});

it('[AC-B1-04zzzzm#5] 缺备案邀请码时失败并告警，不向淘宝发请求', async () => {
  const { exchange, transport, warn } = publisher(null);
  await expect(exchange()).rejects.toBeInstanceOf(Error);
  expect(transport).not.toHaveBeenCalled();
  expectSafeWarning(warn);
});

it('[AC-B1-04zzzzm#5] 无效授权码返回 credential_invalid，隐藏凭据', async () => {
  const { exchange, transport, warn } = publisher();
  transport.mockResolvedValueOnce(
    response({ error: 'invalid_grant', error_description: MARKERS.join(' ') }, 400),
  );

  expect(await exchange()).toEqual({ kind: 'credential_invalid' });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(sent(transport).archive).toBeUndefined();
  expectRedacted(warn.mock.calls, MARKERS);
});

it('[AC-B1-04zzzzm#5] 备案传输失败时，错误与告警不泄漏凭据', async () => {
  const { exchange, transport, warn } = publisher();
  transport
    .mockResolvedValueOnce(response(tokenAnswer()))
    .mockRejectedValue(new Error(MARKERS.join(' ')));

  const [result] = await Promise.allSettled([exchange()]);
  expect(transport.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(result).toMatchObject({ status: 'rejected', reason: expect.any(Error) });
  expectRedacted(result, MARKERS);
  expectRedacted(warn.mock.calls, MARKERS);
  expectPublisherRequest(transport, 1, SAVE);
});

it('[AC-B1-04zzzzm#5] 同一适配器的后续备案使用本次授权换得的令牌', async () => {
  const { exchange, transport, warn } = publisher();
  const nextCode = 'synthetic-next-user-code';
  const nextAccess = 'synthetic-next-user-access';
  const saved = (relation_id: number) =>
    response({ tbk_sc_publisher_info_save_response: { data: { relation_id } } });
  transport
    .mockResolvedValueOnce(response(tokenAnswer()))
    .mockResolvedValueOnce(saved(111178))
    .mockResolvedValueOnce(response(tokenAnswer({ access_token: nextAccess })))
    .mockResolvedValueOnce(saved(222279));

  expect(await exchange()).toEqual({ kind: 'bound', relationId: '111178' });
  expect(await exchange(nextCode)).toEqual({ kind: 'bound', relationId: '222279' });
  expect(transport).toHaveBeenCalledTimes(4);
  expect(formFields(sent(transport, 0))).toHaveProperty('code', CODE);
  expect(formFields(sent(transport, 1))).toMatchObject({ method: SAVE, session: ACCESS });
  expect(formFields(sent(transport, 2))).toHaveProperty('code', nextCode);
  expect(formFields(sent(transport, 3))).toMatchObject({ method: SAVE, session: nextAccess });
  expectRedacted(warn.mock.calls, [...MARKERS, nextCode, nextAccess]);
});

const USER_ID = '2200000000042';
const USER_NICK = '合成授权用户+昵称';
const SAVE_ACCOUNT_NAME = '合成保存账号';
const GET_ACCOUNT_NAME = '合成查询账号';
const PERSONAL_MARKERS = [USER_ID, USER_NICK, SAVE_ACCOUNT_NAME, GET_ACCOUNT_NAME];
const PRIVATE_MARKERS = [
  ...MARKERS,
  ...PERSONAL_MARKERS,
  ...PERSONAL_MARKERS.map(encodeURIComponent),
];
const TOKEN_USER = { taobao_user_id: USER_ID, taobao_user_nick: encodeURIComponent(USER_NICK) };

function duplicateSaveWithAccount() {
  return response({
    tbk_sc_publisher_info_save_response: {
      data: { desc: '重复绑定渠道', account_name: SAVE_ACCOUNT_NAME },
    },
  });
}

function publisherRejection(accountName: string) {
  return response({
    error_response: { code: 15, msg: PRIVATE_MARKERS.join(' '), account_name: accountName },
  });
}

it('[AC-B1-04zzzzm#5] 保存备案成功时，个人信息不出现在返回值或日志', async () => {
  const { adapter, transport, warn } = publisher();
  transport.mockResolvedValueOnce(response(tokenAnswer(TOKEN_USER)));
  transport.mockResolvedValueOnce(
    response({
      tbk_sc_publisher_info_save_response: {
        data: { relation_id: '811796', account_name: SAVE_ACCOUNT_NAME },
      },
    }),
  );

  const result = await adapter.bindPublisher({ authorizationCode: CODE }, ctx);
  expect(result).toEqual({ relationId: '811796' });
  expect(transport).toHaveBeenCalledTimes(2);
  expectPublisherRequest(transport, 1, SAVE);
  expectRedacted([result, warn.mock.calls], PRIVATE_MARKERS);
});

it.each([
  {
    format: '普通数字',
    wireId: '731082',
    relationId: '731082',
    unverified: [
      { label: '没有历史绑定', owner: null },
      {
        label: '属于其他用户',
        owner: { user_id: '0199a3b4-5c6d-7000-8000-000000000043' },
      },
      {
        label: '属于其他联盟账号',
        owner: { union_account_id: '0199a3b4-5c6d-7000-8000-0000000000a2' },
      },
      { label: '属于其他应用', owner: { app_id: 'other_synthetic_app' } },
    ],
  },
  {
    format: '大整数',
    wireId: '9007199254740993',
    relationId: '9007199254740993',
    unverified: [{ label: '只有舍入后的编号', owner: { relation_id: '9007199254740992' } }],
  },
  {
    format: '前导零字符串',
    wireId: '"000811796"',
    relationId: '000811796',
    unverified: [{ label: '只有去掉前导零的编号', owner: { relation_id: '811796' } }],
  },
])(
  '[AC-B1-04zzzzm#4] 重复备案用同一令牌查回$format 编号，校验历史归属并隐藏个人信息',
  async ({ wireId, relationId, unverified }) => {
    const { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } =
      await import('kysely');
    const { createUnionBindings } =
      await import('../../../../apps/api/src/modules/linking/application/union-bindings.ts');
    const { resolveIssuedTaobaoOAuthApp, taobaoUserOAuthRef } =
      await import('../../../../apps/api/src/modules/linking/infra/auth-apps.ts');
    type Db = import('@couli/db').DB;
    type Query = import('kysely').CompiledQuery;
    type QueryResult<Row> = import('kysely').QueryResult<Row>;

    const caller = {
      appId: 'synthetic_app',
      userId: '0199a3b4-5c6d-7000-8000-000000000041',
      deviceId: '0199a3b4-5c6d-7000-8000-000000000042',
    };
    const account = '0199a3b4-5c6d-7000-8000-0000000000a1';
    const state = 'synthetic-duplicate-state';
    const device = { platform: 'ios', revoked_at: null };
    const appRef = taobaoUserOAuthRef({ appKey: APP_KEY, redirectUri: USER_REDIRECT });
    const owned = {
      app_id: caller.appId,
      user_id: caller.userId,
      union_account_id: account,
      relation_id: relationId,
      platform: 'taobao',
    };

    async function submit(owner: Partial<typeof owned> | null) {
      const { adapter, clock, transport, warn } = setup({
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
      const queried = {
        ...response({}),
        body: `{"tbk_sc_publisher_info_get_response":{"data":{"total_count":1,"inviter_list":{"map_data":[{"relation_app":"common","relation_id":${wireId},"account_name":${JSON.stringify(GET_ACCOUNT_NAME)}}]}}}}`,
      };
      transport
        .mockReset()
        .mockResolvedValueOnce(response(tokenAnswer(TOKEN_USER)))
        .mockResolvedValueOnce(duplicateSaveWithAccount())
        .mockResolvedValueOnce(queried)
        .mockRejectedValue(new Error('合成传输收到未预期的上游请求'));

      const now = clock.now().getTime();
      // 冷却已结束，匹配的历史记录可以证实归属，随后正常写入 active。
      const rows =
        owner === null
          ? []
          : [
              {
                ...owned,
                ...owner,
                id: '0199a3b4-5c6d-7000-8000-0000000000b1',
                status: 'released',
                released_at: new Date(now - 60_000),
                cooldown_until: new Date(now - 1_000),
                row_version: 1,
              },
            ];
      const session = {
        state,
        app_id: caller.appId,
        user_id: caller.userId,
        device_id: caller.deviceId,
        client: device.platform,
        platform: 'taobao',
        mode: 'bind',
        used_at: null,
        expire_at: new Date(now + 60_000),
        auth_methods: ['web_code'],
        auth_app_refs: { web_code: appRef },
      };

      const writes: Query[] = [];
      const bindingWarnings: unknown[][] = [];
      const driver = new DummyDriver();
      const connection = await driver.acquireConnection();
      const scope = /"(app_id|user_id|union_account_id|platform|relation_id)" (=|!=|<>) \$(\d+)/g;
      function answer(query: Query): QueryResult<unknown> {
        const { sql, parameters } = query;
        if (sql.includes('from "devices"')) return { rows: [device] };
        if (sql.includes('from "union_auth_sessions"')) return { rows: [session] };
        if (sql.includes('from "users"')) {
          return { rows: [{ id: caller.userId, status: 'active' }] };
        }
        if (/^(?:insert into|update|delete from) "union_bindings"/i.test(sql)) {
          writes.push(query);
          return { rows: [], numAffectedRows: 1n };
        }
        if (sql.startsWith('update "union_auth_sessions"')) {
          return { rows: [], numAffectedRows: 1n };
        }
        if (sql.includes('from "union_bindings"')) {
          const predicates = [...sql.matchAll(scope)];
          return {
            rows: rows.filter((row) =>
              predicates.every(([, column, operator, position]) => {
                const same = row[column as keyof typeof owned] === parameters[Number(position) - 1];
                return operator === '=' ? same : !same;
              }),
            ),
          };
        }
        return { rows: [] };
      }
      connection.executeQuery = async <Row>(query: Query) => answer(query) as QueryResult<Row>;
      driver.acquireConnection = async () => connection;
      const db = new Kysely<Db>({
        dialect: {
          createDriver: () => driver,
          createAdapter: () => new PostgresAdapter(),
          createIntrospector: (handle) => new PostgresIntrospector(handle),
          createQueryCompiler: () => new PostgresQueryCompiler(),
        },
      });

      try {
        const bindings = createUnionBindings({
          db,
          clock,
          callerContext: { current: async () => caller },
          reads: {
            binding: async () => ({ status: 'unbound', accountId: null }),
            authAccountId: async () => account,
            siteAuthAvailable: async () => true,
            configuredMethods: async () => ['web_code'],
            userBanned: async () => false,
          },
          idempotency: {
            executeInTransaction: async (_request, handler) => {
              const { status, envelope } = await db.transaction().execute(handler);
              return { status, body: JSON.stringify(envelope), source: 'handler' };
            },
          },
          exchanger: new UnionBindingExchanger(() => adapter.bindPublisher.bind(adapter), {
            resolveApp: resolveIssuedTaobaoOAuthApp,
          }),
          logger: {
            warn: (...args: unknown[]) => {
              bindingWarnings.push(args);
            },
          },
        });
        const result = await bindings.bind({
          platform: 'taobao',
          body: { state, auth_method: 'web_code', code: CODE },
          idempotencyKey: 'synthetic-duplicate-binding',
          traceId: 'synthetic-duplicate-trace',
        });
        const warnings = [...warn.mock.calls, ...bindingWarnings];
        expect(transport).toHaveBeenCalledTimes(3);
        expectPublisherRequest(transport, 1, SAVE);
        expectPublisherRequest(transport, 2, GET);
        expectRedacted([result, writes, warnings], PRIVATE_MARKERS);
        return { result, writes, warnings };
      } finally {
        await db.destroy();
      }
    }

    const accepted = await submit(owned);
    expect(accepted.result).toMatchObject({
      status: 200,
      envelope: { code: 0, data: { platform: 'taobao', status: 'active' } },
    });
    expect(accepted.writes).toEqual([
      expect.objectContaining({
        sql: expect.stringMatching(/^insert into "union_bindings"/),
        parameters: expect.arrayContaining([
          caller.appId,
          caller.userId,
          account,
          relationId,
          'active',
        ]),
      }),
    ]);

    for (const { label, owner } of unverified) {
      const refused = await submit(owner);
      expect(refused.result.status, label).toBeGreaterThanOrEqual(400);
      expect(refused.result.envelope.code, label).not.toBe(0);
      expect(refused.writes, label).toEqual([]);
      const warning = refused.warnings
        .map(([fields]) => fields as Record<string, unknown> | undefined)
        .find((fields) =>
          [fields?.reason, fields?.failure, fields?.code].includes('duplicate_unverified'),
        );
      expect(warning, label).toEqual(expect.any(Object));
      for (const value of Object.values(warning ?? {})) {
        const flat = value === null || ['string', 'number', 'boolean'].includes(typeof value);
        expect(flat, label).toBe(true);
      }
    }
  },
);

it.each([
  {
    scenario: '保存和查询都没有编号',
    answers: [
      response(tokenAnswer(TOKEN_USER)),
      duplicateSaveWithAccount(),
      response({
        tbk_sc_publisher_info_get_response: {
          data: {
            total_count: 1,
            inviter_list: {
              map_data: [{ relation_app: 'common', account_name: GET_ACCOUNT_NAME }],
            },
          },
        },
      }),
    ],
  },
  {
    scenario: '淘宝拒绝保存备案',
    answers: [response(tokenAnswer(TOKEN_USER)), publisherRejection(SAVE_ACCOUNT_NAME)],
  },
  {
    scenario: '淘宝拒绝备案查询',
    answers: [
      response(tokenAnswer(TOKEN_USER)),
      duplicateSaveWithAccount(),
      publisherRejection(GET_ACCOUNT_NAME),
    ],
  },
  {
    scenario: '授权码换令牌失败',
    answers: [
      response(
        { ...TOKEN_USER, error: 'invalid_grant', error_description: PRIVATE_MARKERS.join(' ') },
        400,
      ),
    ],
  },
])('[AC-B1-04zzzzm#5] $scenario 时，原始异常和日志隐藏个人信息', async ({ answers }) => {
  const { adapter, transport, warn } = publisher();
  for (const answer of answers) transport.mockResolvedValueOnce(answer);

  const error = await refusal(() => adapter.bindPublisher({ authorizationCode: CODE }, ctx));
  expect(transport).toHaveBeenCalledTimes(answers.length);
  expectRedacted([error, warn.mock.calls], PRIVATE_MARKERS);
});

it.each([
  ['空串', ''],
  ['纯空白', '  '],
])('[AC-B1-04zzzzm#5] 备案邀请码为%s时失败并告警，不发保存请求', async (_, inviterCode) => {
  const { adapter, transport, warn } = publisher(inviterCode);
  transport.mockResolvedValueOnce(response(tokenAnswer(TOKEN_USER)));

  const error = await refusal(() => adapter.bindPublisher({ authorizationCode: CODE }, ctx));
  const methods = transport.mock.calls.map(([request]) =>
    new URLSearchParams(request.body ?? '').get('method'),
  );
  expect(methods).not.toContain(SAVE);
  expectSafeWarning(warn);
  const warningText = Object.values(warn.mock.calls[0]?.[0] ?? {}).join(' ');
  expect(warningText).toMatch(/invit(?:e|er)[_ -]?code|邀请码/i);
  expect(warningText).toMatch(
    /missing|unconfigured|required|empty|blank|unset|缺失|缺少|未配置|未设置|为空/i,
  );
  expectRedacted([error, warn.mock.calls], PRIVATE_MARKERS);
});
