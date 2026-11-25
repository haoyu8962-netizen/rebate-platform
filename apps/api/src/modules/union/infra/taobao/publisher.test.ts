// B1-04zzzzm: unit tests of the publisher answer readers (synthetic bodies only).
import { expect, it } from 'vitest';
import { FixedClock } from '../../../platform/index.ts';
import { UnionError } from '../../domain/types.ts';
import type { UnionTransportRequest, UnionTransportResponse } from '../replay.ts';
import {
  queriedRelationId,
  savedRelationId,
  saveRefusalIsDefinite,
  TAOBAO_PUBLISHER_GET,
  TAOBAO_PUBLISHER_SAVE,
} from './publisher.ts';
import { TaobaoUnionAdapter } from './taobao-adapter.ts';

const getBody = (rows: string) =>
  `{"tbk_sc_publisher_info_get_response":{"data":{"inviter_list":{"map_data":[${rows}]}}}}`;

it('[AC-B1-04zzzzm#3] save 编号按原文取，非数字文本不当编号', () => {
  const save = (id: string) =>
    `{"tbk_sc_publisher_info_save_response":{"data":{"relation_id":${id}}}}`;
  expect(savedRelationId(save('12345678901234567890'))).toBe('12345678901234567890');
  expect(savedRelationId(save('"0042"'))).toBe('0042');
  expect(savedRelationId(save('"abc"'))).toBeNull();
  expect(savedRelationId(save('-1'))).toBeNull();
  expect(savedRelationId('not json')).toBeNull();
});

it('[AC-B1-04zzzzm#4] get 只认 common 场景的唯一编号，多个不同编号不猜', () => {
  expect(
    queriedRelationId(getBody('{"relation_app":"etao","relation_id":1},{"relation_id":2}')),
  ).toEqual({ kind: 'found', relationId: '2' });
  expect(
    queriedRelationId(
      getBody(
        '{"relation_app":"common","relation_id":3},{"relation_app":"common","relation_id":3}',
      ),
    ),
  ).toEqual({ kind: 'found', relationId: '3' });
  expect(
    queriedRelationId(
      getBody(
        '{"relation_app":"common","relation_id":3},{"relation_app":"common","relation_id":4}',
      ),
    ),
  ).toEqual({ kind: 'ambiguous' });
  expect(queriedRelationId(getBody(''))).toEqual({ kind: 'none' });
});

it('[AC-B1-04zzzzn#7] save 的业务拒绝算明确结局，网关系统错与非应答算未知', () => {
  const refusal = (fields: string) => `{"error_response":{"code":15${fields}}}`;
  expect(saveRefusalIsDefinite(200, refusal(''))).toBe(true);
  expect(saveRefusalIsDefinite(200, refusal(',"sub_code":"isv.invalid-parameter"'))).toBe(true);
  expect(saveRefusalIsDefinite(200, refusal(',"sub_code":"isp.call-limited"'))).toBe(true);
  expect(saveRefusalIsDefinite(200, refusal(',"sub_code":"isp.remote-service-timeout"'))).toBe(
    false,
  );
  expect(saveRefusalIsDefinite(502, refusal(''))).toBe(false);
  expect(saveRefusalIsDefinite(200, 'not json')).toBe(false);
  expect(saveRefusalIsDefinite(200, '{"tbk_sc_publisher_info_save_response":{}}')).toBe(false);
});

const UNIT_SECRET = 'unit-unit-unit-unit';
const UNIT_CODE = 'unit-once-code';
const UNIT_ACCESS = 'unit-access-access';
const UNIT_INVITER = 'unit-inviter-code';
const UNIT_USER_ID = '2200000000777';
const UNIT_NICK = 'unit-nick';

/** The adapter with a transport answering the token, a duplicate save and a failing get. */
function duplicateThenFailingGet(lookup: () => Promise<UnionTransportResponse>) {
  const methods: string[] = [];
  const json = (body: unknown): UnionTransportResponse => ({
    status: 200,
    headers: {},
    body: JSON.stringify(body),
  });
  const adapter = new TaobaoUnionAdapter({
    clock: new FixedClock('2032-01-01T00:00:00.000Z'),
    credentials: async () => ({
      appKey: 'unit-app-key',
      appSecret: UNIT_SECRET,
      userOAuth: { redirectUri: 'https://unit.invalid/cb', inviterCode: UNIT_INVITER },
    }),
    endpoint: {
      platform: 'taobao',
      mode: 'live',
      baseUrl: 'https://taobao-gateway.invalid/router/rest',
      quotaKey: 'unit',
    },
    transport: async (request: UnionTransportRequest) => {
      const method = new URLSearchParams(request.body ?? '').get('method') ?? 'oauth';
      methods.push(method);
      if (method === TAOBAO_PUBLISHER_SAVE) {
        return json({ tbk_sc_publisher_info_save_response: { data: { desc: '重复绑定渠道' } } });
      }
      if (method === TAOBAO_PUBLISHER_GET) return lookup();
      return json({
        access_token: UNIT_ACCESS,
        token_type: 'Bearer',
        expires_in: 86400,
        taobao_user_id: UNIT_USER_ID,
        taobao_user_nick: UNIT_NICK,
      });
    },
  });
  return { adapter, methods };
}

it.each([
  ['超时', () => new DOMException(`unit ${UNIT_ACCESS} ${UNIT_USER_ID}`, 'TimeoutError')],
  ['传输失败', () => new Error(`unit ${UNIT_ACCESS} ${UNIT_INVITER} ${UNIT_NICK}`)],
])(
  '[AC-B1-04zzzzn#20] save 回重复、get %s → 抛带 duplicateConfirmed 的错误，不含凭证与身份',
  async (_, cause) => {
    const { adapter, methods } = duplicateThenFailingGet(() => Promise.reject(cause()));
    const error: unknown = await adapter
      .bindPublisher(
        { authorizationCode: UNIT_CODE },
        { appId: 'unit-app', requestId: 'r', purpose: 'online' },
      )
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    expect(methods).toEqual(['oauth', TAOBAO_PUBLISHER_SAVE, TAOBAO_PUBLISHER_GET]);
    expect(error).toBeInstanceOf(UnionError);
    expect(error).toMatchObject({ code: 'upstream_unavailable', duplicateConfirmed: true });
    const text = JSON.stringify([String(error), { ...(error as object) }]);
    for (const marker of [
      UNIT_CODE,
      UNIT_ACCESS,
      UNIT_SECRET,
      UNIT_INVITER,
      UNIT_USER_ID,
      UNIT_NICK,
    ]) {
      expect(text).not.toContain(marker);
    }
  },
);

it('[AC-B1-04zzzzn#20] get 已应答但无编号不算查回失败：错误不带 duplicateConfirmed', async () => {
  const { adapter } = duplicateThenFailingGet(async () => ({
    status: 200,
    headers: {},
    body: '{"tbk_sc_publisher_info_get_response":{"data":{"inviter_list":{"map_data":[]}}}}',
  }));
  await expect(
    adapter.bindPublisher(
      { authorizationCode: UNIT_CODE },
      { appId: 'unit-app', requestId: 'r', purpose: 'online' },
    ),
  ).rejects.toMatchObject({ code: 'upstream_misconfigured', duplicateConfirmed: false });
});
