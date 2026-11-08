import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect, it, vi } from 'vitest';
import {
  UnionError,
  type UnionErrorCode,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  unwrapDataokeResponse,
  type DataokeWarning,
} from '../../../../apps/api/src/modules/union/infra/dataoke/response.ts';
import {
  unwrapTaobaoResponse,
  type TaobaoWarning,
} from '../../../../apps/api/src/modules/union/infra/taobao/response.ts';
import * as dtk from '../dataoke-core/kit.ts';
import * as tconvert from '../taobao-convert/kit.ts';
import * as top from '../taobao-core/kit.ts';
import * as goods from '../taobao-goods/kit.ts';
import {
  LINK,
  NEW_OUTER,
  OTHER_OUTER,
  PERMISSION_SUB_CODE,
  RATE_LIMITED_OUTER,
  UNAVAILABLE_OUTER,
  UPSTREAM_TEXT,
  expectRedacted,
  visible,
} from './cred-kit.ts';

// 编排者补充第 1–4 条：大淘客外层凭据 / 签名 / 权限组 → upstream_misconfigured，站长授权组 →
// site_auth_invalid；淘宝 TOP code 11（直连与大淘客 data 内）→ upstream_misconfigured；其余码不变；
// 每个新码恰好告警一次，字段同现状，不带上游说明、request_id 与凭据。

const PARAM_MARKER = 'cred-param-marker';
const hidden = [dtk.secret, UPSTREAM_TEXT, 'cred-request-id-marker', PARAM_MARKER];
/** The client's signature for the dataoke kit's fixed clock / nonce, worked out independently. */
const signRan = dtk.expectedSignRan(dtk.appKey, dtk.timer, dtk.nonce, dtk.secret);

const outerRows = NEW_OUTER.flatMap(([code, expected]) => [
  { code: code as number | string, expected },
  { code: String(code), expected },
]);

it.each(outerRows)(
  '[AC-B1-04zzzx#1] 大淘客外层 code $code → $expected：直调解包与经 DataokeClient 两路同码，各告警一次只带 path / code，不重发',
  async ({ code, expected }) => {
    // The upstream text carries our appKey: neither the error nor the warning may repeat it.
    const wire = dtk.response({
      time: 1793500000000,
      code,
      msg: `${dtk.secret} ${UPSTREAM_TEXT} ${dtk.appKey}`,
    });
    const events: [DataokeWarning][] = [[{ path: dtk.path, code: String(code) }]];

    const warn = vi.fn<(event: DataokeWarning) => void>();
    const direct = await dtk.unionFailure(
      () => unwrapDataokeResponse(dtk.path, wire, warn),
      expected,
    );
    expect(direct.message).toContain(dtk.path);
    expect(direct.message).toContain(String(code));
    expect(warn.mock.calls).toEqual(events);
    expectRedacted([direct, warn.mock.calls], [...hidden, dtk.appKey]);

    const fixture = dtk.setup();
    fixture.transport.mockResolvedValue(wire);
    const viaClient = await dtk.unionFailure(
      () => fixture.client.request('GET', dtk.path, { q: PARAM_MARKER }, { version: dtk.version }),
      expected,
    );
    expect(viaClient.message).toContain(dtk.path);
    expect(viaClient.message).toContain(String(code));
    expect(fixture.transport).toHaveBeenCalledTimes(1);
    expect(fixture.warn.mock.calls).toEqual(events);
    expectRedacted([viaClient, fixture.warn.mock.calls], [...hidden, dtk.appKey, signRan]);
  },
);

it('[AC-B1-04zzzx#2] 其余外层分组不变（限流 8 码、不可用组、表外 10071 / 10077 / 99999，都不告警）；同一解包下两类新码各成其码', async () => {
  const unchanged: (readonly [number, UnionErrorCode])[] = [
    ...RATE_LIMITED_OUTER.map((code) => [code, 'rate_limited'] as const),
    ...UNAVAILABLE_OUTER.map((code) => [code, 'upstream_unavailable'] as const),
    ...OTHER_OUTER.map((code) => [code, 'upstream_rejected'] as const),
  ];
  for (const [code, expected] of unchanged) {
    for (const wireCode of [code, String(code)]) {
      const warn = vi.fn<(event: DataokeWarning) => void>();
      await dtk.unionFailure(
        () => unwrapDataokeResponse(dtk.path, dtk.response({ code: wireCode }), warn),
        expected,
      );
      expect(warn).not.toHaveBeenCalled();
    }
  }
  for (const [code, expected] of [
    [10021, 'upstream_misconfigured'],
    [10072, 'site_auth_invalid'],
  ] as const) {
    const warn = vi.fn<(event: DataokeWarning) => void>();
    await dtk.unionFailure(
      () => unwrapDataokeResponse(dtk.path, dtk.response({ code }), warn),
      expected,
    );
    expect(warn).toHaveBeenCalledTimes(1);
  }
});

const permissionRows = ([11, '11'] as const).flatMap((code) => [
  { code, sub_code: PERMISSION_SUB_CODE as string | undefined },
  { code, sub_code: undefined },
]);

function topError(code: number | string, subCode: string | undefined): Record<string, unknown> {
  return {
    code,
    msg: `${dtk.secret} ${UPSTREAM_TEXT}`,
    ...(subCode === undefined ? {} : { sub_code: subCode }),
    sub_msg: `${UPSTREAM_TEXT} 1001,1002`,
    request_id: 'cred-request-id-marker',
  };
}

it.each(permissionRows)(
  '[AC-B1-04zzzx#3] TOP code $code（sub_code $sub_code）→ upstream_misconfigured：直连解包 / adapter.request 与大淘客 data 内两处同码，各告警一次',
  async ({ code, sub_code }) => {
    const wire = top.response({ error_response: topError(code, sub_code) });
    const topEvents: [TaobaoWarning][] = [
      [
        sub_code === undefined
          ? { method: top.method, code: '11' }
          : { method: top.method, code: '11', sub_code },
      ],
    ];
    // The sub_code, when the answer carries one, must reach the error message (as before).
    const named = sub_code === undefined ? ['11'] : ['11', sub_code];

    const warn = vi.fn<(event: TaobaoWarning) => void>();
    const direct = await top.unionFailure(
      () => unwrapTaobaoResponse(top.method, top.envelope, wire, warn),
      'upstream_misconfigured',
    );
    expect(direct.message).toContain(top.method);
    for (const part of named) expect(direct.message).toContain(part);
    expect(warn.mock.calls).toEqual(topEvents);
    expectRedacted([direct, warn.mock.calls], hidden);

    const fixture = top.setup();
    fixture.transport.mockResolvedValue(wire);
    const viaAdapter = await top.unionFailure(
      () => fixture.adapter.request(top.method, {}, { envelope: top.envelope }),
      'upstream_misconfigured',
    );
    expect(fixture.transport).toHaveBeenCalledTimes(1);
    expect(fixture.warn.mock.calls).toEqual(topEvents);
    expectRedacted([viaAdapter, fixture.warn.mock.calls], hidden);

    const inside = dtk.ok({ error_response: topError(code, sub_code) });
    const dataokeEvents: [DataokeWarning][] = [
      [
        sub_code === undefined
          ? { path: dtk.path, code: '11' }
          : { path: dtk.path, code: '11', sub_code },
      ],
    ];
    const dataokeWarn = vi.fn<(event: DataokeWarning) => void>();
    const insideError = await dtk.unionFailure(
      () => unwrapDataokeResponse(dtk.path, inside, dataokeWarn),
      'upstream_misconfigured',
    );
    expect(insideError.message).toContain(dtk.path);
    for (const part of named) expect(insideError.message).toContain(part);
    expect(dataokeWarn.mock.calls).toEqual(dataokeEvents);
    expectRedacted([insideError, dataokeWarn.mock.calls], hidden);

    const client = dtk.setup();
    client.transport.mockResolvedValue(inside);
    const viaClient = await dtk.unionFailure(
      () => client.client.request('GET', dtk.path, { q: PARAM_MARKER }, { version: dtk.version }),
      'upstream_misconfigured',
    );
    expect(client.transport).toHaveBeenCalledTimes(1);
    expect(client.warn.mock.calls).toEqual(dataokeEvents);
    expectRedacted([viaClient, client.warn.mock.calls], [...hidden, dtk.appKey, signRan]);
  },
);

it('[AC-B1-04zzzx#4] code 11 只在不是限流时成新码：带 isp.call-limited* 子码仍 rate_limited（先后不变），code 7 / 15 / 表外 code 不变', async () => {
  const unchanged: [number | string, string | undefined, UnionErrorCode][] = [
    [11, 'isp.call-limited', 'rate_limited'],
    ['11', 'isp.call-limited-synthetic', 'rate_limited'],
    [7, 'synthetic.limit', 'rate_limited'],
    [15, '2000', 'upstream_rejected'],
    [99999, 'isv.synthetic-sub-code', 'upstream_rejected'],
  ];
  for (const [code, subCode, expected] of unchanged) {
    await top.unionFailure(
      () =>
        unwrapTaobaoResponse(
          top.method,
          top.envelope,
          top.response({ error_response: topError(code, subCode) }),
        ),
      expected,
    );
    await dtk.unionFailure(
      () => unwrapDataokeResponse(dtk.path, dtk.ok({ error_response: topError(code, subCode) })),
      expected,
    );
  }
  await top.unionFailure(
    () =>
      unwrapTaobaoResponse(
        top.method,
        top.envelope,
        top.response({ error_response: topError(11, 'isv.synthetic-other') }),
      ),
    'upstream_misconfigured',
  );
  await dtk.unionFailure(
    () =>
      unwrapDataokeResponse(
        dtk.path,
        dtk.ok({ error_response: topError(11, 'isv.synthetic-other') }),
      ),
    'upstream_misconfigured',
  );
});

it('[AC-B1-04zzzx#5] 详情与淘口令：15 的细分（50001 / 1911 / 26 / 23）、7、HTTP 5xx（不告警）不变；code 11 → upstream_misconfigured 且告警一次', async () => {
  const detailRows: [unknown, UnionErrorCode][] = [
    [goods.errorBody(15, '50001'), 'item_unavailable'],
    [goods.errorBody(15, '1911'), 'upstream_rejected'],
    [goods.errorBody(7), 'rate_limited'],
    [goods.withStatus(503, 'synthetic outage'), 'upstream_unavailable'],
  ];
  for (const [answer, code] of detailRows) {
    const h = goods.setup(() => answer);
    await goods.unionFailure(() => h.adapter.getItem(goods.ref, goods.ctx), code);
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(h.warn).not.toHaveBeenCalled();
  }
  const shareRows: [unknown, UnionErrorCode][] = [
    [goods.errorBody(15, '26'), 'link_unrecognized'],
    [goods.errorBody(15, '23'), 'link_unrecognized'],
    [goods.errorBody(15, '50001'), 'upstream_rejected'],
    [goods.errorBody(7), 'rate_limited'],
    [goods.withStatus(502, 'synthetic outage'), 'upstream_unavailable'],
  ];
  for (const [answer, code] of shareRows) {
    const h = goods.setup(() => answer);
    await goods.unionFailure(() => h.adapter.taobaoShareCode(LINK, goods.ctx), code);
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(h.warn).not.toHaveBeenCalled();
  }

  const detail = goods.setup(() => goods.errorBody(11, '50001'));
  await goods.unionFailure(
    () => detail.adapter.getItem(goods.ref, goods.ctx),
    'upstream_misconfigured',
  );
  expect(detail.transport).toHaveBeenCalledTimes(1);
  expect(detail.warn.mock.calls).toEqual([
    [{ method: goods.DETAIL, code: '11', sub_code: '50001' }],
  ]);

  const share = goods.setup(() => goods.errorBody(11, '26'));
  await goods.unionFailure(
    () => share.adapter.taobaoShareCode(LINK, goods.ctx),
    'upstream_misconfigured',
  );
  expect(share.transport).toHaveBeenCalledTimes(1);
  expect(share.warn.mock.calls).toEqual([[{ method: goods.TPWD, code: '11', sub_code: '26' }]]);
});

it('[AC-B1-04zzzx#6] 大淘客转链：表内细分 10031 / 10212 / 10213 仍 item_unavailable、10014 仍 rate_limited；10021 / 401 → upstream_misconfigured、10072 / 10210 / 10211 → site_auth_invalid，客户端告警一次，不另造 30101 / 30102', async () => {
  const unchanged: [number, UnionErrorCode][] = [
    [10031, 'item_unavailable'],
    [10212, 'item_unavailable'],
    [10213, 'item_unavailable'],
    [10014, 'rate_limited'],
  ];
  const NEXT_URL = 'https://s.click.taobao.com/synthetic-cred-class-next';
  const reply = (code: number) =>
    tconvert.response({ time: 1793500984000, code, msg: UPSTREAM_TEXT, data: {} });
  for (const [code, expected] of unchanged) {
    const h = tconvert.setup({ reply: reply(code) });
    await tconvert.unionFailure(
      () => h.adapter.convert(tconvert.req, tconvert.identity, tconvert.ctx),
      expected,
    );
    expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
    expect(h.dataokeWarn).not.toHaveBeenCalled();
  }
  const refined: [number, UnionErrorCode][] = [
    [10021, 'upstream_misconfigured'],
    [401, 'upstream_misconfigured'],
    [10072, 'site_auth_invalid'],
    [10210, 'site_auth_invalid'],
    [10211, 'site_auth_invalid'],
  ];
  for (const [code, expected] of refined) {
    const h = tconvert.setup({ reply: reply(code) });
    const error = await tconvert.unionFailure(
      () => h.adapter.convert(tconvert.req, tconvert.identity, tconvert.ctx),
      expected,
    );
    expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
    expect(h.taobaoTransport).not.toHaveBeenCalled();
    expect(h.dataokeWarn.mock.calls).toEqual([
      [{ path: tconvert.PRIVILEGE_PATH, code: String(code) }],
    ]);
    expect(tconvert.visible(error)).not.toMatch(/3010[12]/);
    expect(tconvert.visible(error)).not.toContain(UPSTREAM_TEXT);
    // The same adapter converts as usual on the next normal answer (not "refuse from now on").
    h.dataokeTransport.mockResolvedValueOnce(
      tconvert.response({ time: 1793500984000, code: 0, msg: 'ok', data: { shortUrl: NEXT_URL } }),
    );
    const next = await tconvert.converted(() =>
      h.adapter.convert(tconvert.req, tconvert.identity, tconvert.ctx),
    );
    expect(next.url).toBe(NEXT_URL);
  }
});

it('[AC-B1-04zzzx#7] 性质：任一新码、任一写法（数字 / 字符串 / 两侧空格）、任意上游说明 → 对应新码，恰好一次告警 { path, code }，错误与告警不带说明', () => {
  // One collector for every run (no vi.fn per run); emptied at the start of each run.
  const events: DataokeWarning[] = [];
  const warn = (event: DataokeWarning): void => {
    events.push(event);
  };
  let checked = 0;
  fc.assert(
    fc.property(
      fc.constantFrom(...NEW_OUTER),
      fc.constantFrom('number', 'string', 'padded'),
      fc.string({ maxLength: 40 }),
      ([code, expected], form, text) => {
        events.length = 0;
        const wireCode = form === 'number' ? code : form === 'string' ? String(code) : ` ${code} `;
        const wire = dtk.response({
          time: 1793500000000,
          code: wireCode,
          msg: `${UPSTREAM_TEXT}${text}`,
        });
        let caught: unknown;
        try {
          unwrapDataokeResponse(dtk.path, wire, warn);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(UnionError);
        expect(caught).toMatchObject({ code: expected, platform: 'taobao' });
        expect(events).toEqual([{ path: dtk.path, code: String(code) }]);
        expect(visible([caught, events])).not.toContain(UPSTREAM_TEXT);
        checked += 1;
        return true;
      },
    ),
    { numRuns: Math.max(50, Math.floor(propRuns() / 100)), seed: propSeed() },
  );
  expect(checked).toBeGreaterThan(0);
});

// 原 [AC-B1-04m#30] 表里「外层 10021 压过 data 内淘宝 error_response code 7」一行的新期望。
it('[AC-B1-04zzzx#20] 外层 10021 优先于 data 内淘宝 error_response code 7 → upstream_misconfigured：直调解包与经 DataokeClient 两路各告警一次 { path, code }，不重发', async () => {
  const body = { code: 10021, data: { error_response: { code: 7 } } };
  const events: [DataokeWarning][] = [[{ path: dtk.path, code: '10021' }]];

  const warn = vi.fn<(event: DataokeWarning) => void>();
  await dtk.unionFailure(
    () => unwrapDataokeResponse(dtk.path, dtk.response(body), warn),
    'upstream_misconfigured',
  );
  expect(warn.mock.calls).toEqual(events);

  const fixture = dtk.setup();
  fixture.transport.mockResolvedValue(dtk.response(body));
  await dtk.unionFailure(
    () => fixture.client.request('POST', dtk.path, {}, { version: dtk.version }),
    'upstream_misconfigured',
  );
  expect(fixture.transport).toHaveBeenCalledTimes(1);
  expect(fixture.warn.mock.calls).toEqual(events);
});
