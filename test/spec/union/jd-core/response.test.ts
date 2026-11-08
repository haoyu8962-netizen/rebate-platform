import { isDeepStrictEqual } from 'node:util';
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  UnionError,
  type UnionErrorCode,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import { JdUnionAdapter } from '../../../../apps/api/src/modules/union/infra/jd/jd-adapter.ts';
import {
  unwrapJdResponse,
  type JdInnerCodeMap,
  type JdResponseKeys,
  type JdWarning,
} from '../../../../apps/api/src/modules/union/infra/jd/response.ts';
import type {
  UnionTransport,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';
import {
  appKey,
  endpoint,
  envelope,
  expectRedacted,
  innerOk,
  instant,
  keys,
  method,
  rawText,
  requestMarker,
  response,
  resultKey,
  secret,
  setup,
  unionFailure,
  wrapped,
} from './kit.ts';

// 合成、非录制：外层键、结果键与方法名都是合成值；外层 / 内层分层、code 2 / 28 / 403 / 429 的含义
// 取自任务书（官方接入指南与实测），报文其余内容自拟。

// Upstream text in malformed answers. Short on purpose: a JSON.parse error quotes a text of up to
// 20 characters whole and a longer one only 10 characters around the failure, so a copied error
// message shows this marker only when it and its row stay this small.
const wireMarker = 'wire-mark';
const markers = [secret, appKey, 'msg-marker', 'request-id-marker', requestMarker, wireMarker];
const noise = {
  message: `${secret} ${appKey} msg-marker`,
  requestId: 'request-id-marker',
};

/** Fails the same way directly and through the adapter; returns what must stay redacted. */
async function failsBothWays(
  wire: UnionTransportResponse,
  code: UnionErrorCode,
  events: readonly JdWarning[] = [],
  innerCodes?: JdInnerCodeMap,
  registered: JdResponseKeys = keys,
): Promise<readonly UnionError[]> {
  const warn = vi.fn<(event: JdWarning) => void>();
  const direct = await unionFailure(
    () => unwrapJdResponse(method, registered, wire, warn, innerCodes),
    code,
  );
  expect(warn.mock.calls).toEqual(events.map((event) => [event]));

  const fixture = setup();
  fixture.transport.mockResolvedValue(wire);
  const viaAdapter = await unionFailure(
    () =>
      fixture.adapter.request(
        method,
        { q: requestMarker },
        { ...registered, ...(innerCodes === undefined ? {} : { innerCodes }) },
      ),
    code,
  );
  expect(fixture.warn.mock.calls).toEqual(events.map((event) => [event]));
  expectRedacted([direct, viaAdapter, warn.mock.calls, fixture.warn.mock.calls], markers);
  return [direct, viaAdapter];
}

it('[AC-B1-04za#24] returns the object parsed from the inner JSON string, directly and through the adapter', async () => {
  const text =
    '{"code":200,"message":"success","requestId":"req-inner","data":{"list":["a",true,null]}}';
  const expected = {
    message: 'success',
    requestId: 'req-inner',
    data: { list: ['a', true, null] },
  };
  const direct = unwrapJdResponse(method, keys, wrapped(text));
  expect(direct).toMatchObject(expected);
  expect(rawText(direct.code)).toBe('200');
  expect(direct).not.toHaveProperty(resultKey);

  const { adapter, transport } = setup();
  transport.mockResolvedValue(wrapped(text));
  expect(await adapter.request(method, {}, keys)).toMatchObject(expected);
});

it('[AC-B1-04za#25] the envelope key comes from the caller, never from the method name, and `_response` is not `_responce`', async () => {
  const other = { envelope: 'jd_union_open_other_get_responce', resultKey };
  const body = { code: '0', [resultKey]: '{"code":200,"which":"other"}' };
  expect(unwrapJdResponse(method, other, response({ [other.envelope]: body }))).toMatchObject({
    which: 'other',
  });
  // A key that looks derived from the method name is not accepted in place of the given one.
  await unionFailure(
    () => unwrapJdResponse(method, other, response({ [envelope]: body })),
    'upstream_unavailable',
  );
  const { adapter, transport } = setup();
  transport.mockResolvedValue(response({ [envelope]: body }));
  await unionFailure(() => adapter.request(method, {}, other), 'upstream_unavailable');

  // Neither is the regular spelling accepted for a registered `_responce` key.
  const respelt = envelope.replace('_responce', '_response');
  await unionFailure(
    () => unwrapJdResponse(method, keys, response({ [respelt]: body })),
    'upstream_unavailable',
  );
});

it('[AC-B1-04za#26] the result key comes from the caller: only the registered key is read, with no fallback', async () => {
  const wire = response({
    [envelope]: {
      code: '0',
      getResult: '{"code":200,"which":"get"}',
      queryResult: '{"code":200,"which":"query"}',
    },
  });
  expect(unwrapJdResponse(method, { envelope, resultKey: 'getResult' }, wire)).toMatchObject({
    which: 'get',
  });
  expect(unwrapJdResponse(method, { envelope, resultKey: 'queryResult' }, wire)).toMatchObject({
    which: 'query',
  });
  await unionFailure(
    () =>
      unwrapJdResponse(
        method,
        { envelope, resultKey: 'queryResult' },
        response({ [envelope]: { code: '0', getResult: innerOk } }),
      ),
    'upstream_unavailable',
  );
});

it.each<[string, string]>([
  [envelope, '{}'],
  [envelope, `{"other_synthetic_responce":{"m":"${wireMarker}"}}`],
  [envelope, `{"${envelope}":null}`],
  [envelope, `{"${envelope}":[]}`],
  [envelope, `{"${envelope}":["${wireMarker}"]}`],
  [envelope, `{"${envelope}":"${wireMarker}"}`],
  [envelope, `{"${envelope}":42}`],
  [envelope, `{"${envelope}":true}`],
  [envelope, 'null'],
  [envelope, '[]'],
  [envelope, `["${wireMarker}"]`],
  [envelope, `"${wireMarker}"`],
  [envelope, '42'],
  [envelope, ''],
  [envelope, `<p>${wireMarker}</p>`],
  [envelope, wireMarker],
  [envelope, `{${wireMarker}`],
  ['toString', '{}'],
  ['constructor', '{}'],
  ['__proto__', '{}'],
  ['hasOwnProperty', '{}'],
])(
  '[AC-B1-04za#27] envelope %s with body %s is upstream_unavailable (missing, not an object or not JSON)',
  async (key, body) => {
    const wire = { status: 200, headers: {}, body };
    const registered = { envelope: key, resultKey };
    await failsBothWays(wire, 'upstream_unavailable', [], undefined, registered);
  },
);

interface CodeRow {
  readonly code: number | string;
  readonly expected: UnionErrorCode;
}

const gatewayCodes: readonly CodeRow[] = [
  // App Call Limited, and 429: rate limited.
  { code: 2, expected: 'rate_limited' },
  { code: 429, expected: 'rate_limited' },
  // Interface retired: rejected, with one warning (below).
  { code: 28, expected: 'upstream_rejected' },
  // The inner meanings of 200 and 403 do not apply at the gateway level.
  { code: 403, expected: 'upstream_rejected' },
  { code: 200, expected: 'upstream_rejected' },
  { code: 0, expected: 'upstream_rejected' },
  { code: 99999, expected: 'upstream_rejected' },
];

const gatewayRows: readonly CodeRow[] = [
  ...gatewayCodes.flatMap((row) => [row, { ...row, code: String(row.code) }]),
  { code: 'SYNTHETIC_CODE', expected: 'upstream_rejected' },
];

it.each(gatewayRows)(
  '[AC-B1-04za#28] error_response code=$code maps to $expected for both wire representations',
  async ({ code, expected }) => {
    const wire = response({ error_response: { code, ...noise } });
    const events = String(code) === '28' ? [{ method, code: '28' }] : [];
    for (const error of await failsBothWays(wire, expected, events)) {
      expect(error.message).toContain(method);
      expect(error.message).toContain(String(code));
    }
  },
);

it('[AC-B1-04za#29] the gateway classifies by code alone: a limit message under another code is not rate limiting', async () => {
  const wire = response({ error_response: { code: 99999, message: 'App Call Limited' } });
  await failsBothWays(wire, 'upstream_rejected');
});

it('[AC-B1-04za#30] error_response takes precedence over a simultaneous success envelope', async () => {
  const wire = response({
    error_response: { code: 2 },
    [envelope]: { code: '0', [resultKey]: innerOk },
  });
  await failsBothWays(wire, 'rate_limited');
});

it.each([500, 502, 503, 599])(
  '[AC-B1-04za#31] HTTP %s is upstream_unavailable whatever the body says, without a warning',
  async (status) => {
    for (const body of [
      wrapped().body,
      wrapped('{"code":403}').body,
      response({ error_response: { code: 2 } }).body,
      response({ error_response: { code: 28 } }).body,
      '<html>private-upstream-page</html>',
    ]) {
      const errors = await failsBothWays({ status, headers: {}, body }, 'upstream_unavailable');
      expectRedacted(errors, ['private-upstream-page']);
    }
  },
);

it.each<[Record<string, unknown>]>([
  [{ code: '1' }],
  [{ code: 1 }],
  [{ code: '403' }],
  [{ code: '429' }],
  [{ code: '2' }],
  [{ code: '28' }],
  [{ code: '200' }],
  [{ code: '00' }],
  [{ code: '-1' }],
  [{ code: 'SYNTHETIC_CODE' }],
  [{ code: null }],
  [{}],
])(
  '[AC-B1-04za#32] outer %j is upstream_rejected even when the inner result says 200, without a warning',
  async (outer) => {
    const good = response({ [envelope]: { ...outer, [resultKey]: innerOk, ...noise } });
    for (const error of await failsBothWays(good, 'upstream_rejected')) {
      expect(error.message).toContain(method);
    }
    // The outer code is judged before the result key is looked at.
    await failsBothWays(response({ [envelope]: outer }), 'upstream_rejected');
  },
);

/** A valid start with a success code: what follows decides, so the whole text must be JSON. */
const validStart = `{"code":200,"m":"${wireMarker}"`;
const malformedNumbers = ['1.2.3', '012', '1.', '.5', '+1', '1e', '-', '0x10', 'NaN'];

it.each<[string, unknown]>([
  ['null', null],
  ['a number', 42],
  ['a boolean', true],
  ['an already parsed object', { code: 200, m: wireMarker }],
  ['an array', [wireMarker]],
  ['an empty string', ''],
  ['broken JSON', `{${wireMarker}`],
  ['HTML', `<p>${wireMarker}</p>`],
  ['a bare word', wireMarker],
  ['an unquoted member value', `{"code":200,"m":${wireMarker}}`],
  ['JSON null', 'null'],
  ['a JSON array', `[{"code":200,"m":"${wireMarker}"}]`],
  ['a JSON number', '200'],
  ['a JSON string', `"${wireMarker}"`],
  ['JSON true', 'true'],
  ['an object cut off after a member', validStart],
  ['an object cut off after a number', `${validStart},"actualFee":12.35`],
  ['an object cut off inside an array', `${validStart},"rows":[1,2`],
  ['an object cut off inside a string', `{"code":200,"m":"${wireMarker}`],
  ['an object with text after the closing brace', `${validStart}} trailing`],
  ['an object followed by a second object', `${validStart}}{"code":200}`],
  ['an object with a stray closing brace', `${validStart}}}`],
  ['an object with a trailing comma', `${validStart},}`],
  ...malformedNumbers.map((text): [string, unknown] => [
    `an object with the malformed number ${text}`,
    `${validStart},"actualFee":${text}}`,
  ]),
])('[AC-B1-04za#33] a result value that is %s is upstream_unavailable', async (_label, value) => {
  const wire = response({ [envelope]: { code: '0', [resultKey]: value } });
  await failsBothWays(wire, 'upstream_unavailable');
});

it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty'])(
  '[AC-B1-04za#34] a missing result key %s is upstream_unavailable, not an inherited property',
  async (key) => {
    await unionFailure(
      () => unwrapJdResponse(method, { envelope, resultKey: key }, wrapped()),
      'upstream_unavailable',
    );
  },
);

it.each([
  '{}',
  `{"data":["${wireMarker}"]}`,
  `{"message":"${wireMarker}"}`,
  `{"code":null,"message":"${wireMarker}"}`,
])(
  '[AC-B1-04za#35] an inner object without a code (%s) is upstream_unavailable, never a success',
  async (text) => {
    await failsBothWays(wrapped(text), 'upstream_unavailable');
  },
);

const innerFailures: readonly CodeRow[] = [
  { code: 429, expected: 'rate_limited' },
  // The gateway meanings of 2 and 28, and the outer success code 0, do not apply to the inner code.
  { code: 2, expected: 'upstream_rejected' },
  { code: 28, expected: 'upstream_rejected' },
  { code: 0, expected: 'upstream_rejected' },
  { code: 201, expected: 'upstream_rejected' },
  { code: 500, expected: 'upstream_rejected' },
  { code: 2001707, expected: 'upstream_rejected' },
];

const innerRows: readonly CodeRow[] = [
  ...innerFailures.flatMap((row) => [row, { ...row, code: String(row.code) }]),
  { code: 'SYNTHETIC_CODE', expected: 'upstream_rejected' },
];

it.each(innerRows)(
  '[AC-B1-04za#36] inner code=$code under outer code "0" maps to $expected',
  async ({ code, expected }) => {
    const wire = wrapped(JSON.stringify({ code, data: [], ...noise }));
    const events = String(code) === '403' ? [{ method, code: '403' }] : [];
    for (const error of await failsBothWays(wire, expected, events)) {
      expect(error.message).toContain(method);
      expect(error.message).toContain(String(code));
    }
  },
);

it.each([200, '200'])('[AC-B1-04za#37] inner code %j is the only success', (code) => {
  const inner = unwrapJdResponse(method, keys, wrapped(JSON.stringify({ code, marker: 'kept' })));
  expect(inner).toMatchObject({ marker: 'kept' });
});

it('[AC-B1-04za#38] outer code "0" with inner 403 is a failure, warned once, and no inner data escapes', async () => {
  const text = JSON.stringify({ code: 403, data: { rows: ['inner-data-marker'] }, ...noise });
  const wire = wrapped(text);
  const warn = vi.fn<(event: JdWarning) => void>();
  let returned: unknown;
  const error = await unionFailure(() => {
    returned = unwrapJdResponse(method, keys, wire, warn);
  }, 'upstream_misconfigured');
  expect(returned).toBeUndefined();
  expect(warn.mock.calls).toEqual([[{ method, code: '403' }]]);
  expectRedacted([error, warn.mock.calls], [...markers, 'inner-data-marker']);

  const { adapter, transport, warn: adapterWarn } = setup();
  transport.mockResolvedValue(wire);
  const viaAdapter = await unionFailure(
    () => adapter.request(method, { q: requestMarker }, keys),
    'upstream_misconfigured',
  );
  expect(adapterWarn.mock.calls).toEqual([[{ method, code: '403' }]]);
  expectRedacted([viaAdapter, adapterWarn.mock.calls], [...markers, 'inner-data-marker']);
});

it('[AC-B1-04za#39] under outer code "0" no inner code but 200 ever returns', () => {
  const code = fc.oneof(
    fc.constantFrom(0, 2, 28, 403, 429),
    fc.integer({ min: -1000, max: 9_999_999 }),
  );
  expect(() =>
    fc.assert(
      fc.property(
        code.filter((value) => value !== 200),
        fc.boolean(),
        (value, asText) => {
          const events: JdWarning[] = [];
          const text = JSON.stringify({ code: asText ? String(value) : value, data: [] });
          try {
            unwrapJdResponse(method, keys, wrapped(text), (event) => events.push(event));
            return false;
          } catch (error) {
            // Anything but a classified failure propagates: the skeleton's NotImplemented stays
            // the visible cause, since a bare false is no valid red (tools/guard/lib/red-check.ts).
            if (!(error instanceof UnionError)) throw error;
            return (
              error.code ===
                (value === 429
                  ? 'rate_limited'
                  : value === 403
                    ? 'upstream_misconfigured'
                    : 'upstream_rejected') &&
              error.platform === 'jd' &&
              isDeepStrictEqual(events, value === 403 ? [{ method, code: '403' }] : [])
            );
          }
        },
      ),
      propParams(),
    ),
  ).not.toThrow();
}, 900_000);

it('[AC-B1-04za#40] the warned codes without an injected warn callback are still only upstream_rejected', async () => {
  for (const wire of [response({ error_response: { code: 28 } })]) {
    await unionFailure(() => unwrapJdResponse(method, keys, wire), 'upstream_rejected');
    const transport = vi.fn<UnionTransport>().mockResolvedValue(wire);
    await unionFailure(async () => {
      const adapter = new JdUnionAdapter({
        clock: new FixedClock(instant),
        credentials: async () => ({ appKey, appSecret: secret }),
        transport,
        endpoint,
      });
      await adapter.request(method, {}, keys);
    }, 'upstream_rejected');
    expect(transport).toHaveBeenCalledTimes(1);
  }
});

const oddCodes: readonly [string, unknown][] = [
  ['a long text', 'odd-code-marker'.repeat(30)],
  ['a text with markup', '<b>odd-code-marker</b>'],
  ['a text with spaces', 'odd code marker'],
  ['a multi-line text', 'odd-code-marker\nsecond-line'],
  ['an object', { marker: 'odd-code-marker' }],
  ['an array', ['odd-code-marker']],
];

it.each(oddCodes)(
  '[AC-B1-04za#41] a code that is %s is not echoed: a gateway error stays upstream_rejected',
  async (_label, code) => {
    const wire = response({ error_response: { code } });
    const errors = await failsBothWays(wire, 'upstream_rejected');
    expectRedacted(errors, ['odd-code-marker', 'odd code marker']);
  },
);

it.each(oddCodes)(
  '[AC-B1-04za#42] an inner code that is %s counts as missing and is not echoed',
  async (_label, code) => {
    const errors = await failsBothWays(wrapped(JSON.stringify({ code })), 'upstream_unavailable');
    expectRedacted(errors, ['odd-code-marker', 'odd code marker']);
  },
);

const detail: JdInnerCodeMap = Object.freeze({
  '2001707': 'item_unavailable',
  '2001701': 'link_unrecognized',
  '429': 'item_unavailable',
});

it.each<[number | string, UnionErrorCode]>([
  [2001707, 'item_unavailable'],
  ['2001707', 'item_unavailable'],
  [2001701, 'link_unrecognized'],
  // Outside the table the default stands.
  [2001702, 'upstream_rejected'],
  // Rate limiting is judged before the table.
  [429, 'rate_limited'],
  ['429', 'rate_limited'],
  // The table is a plain object: inherited names are not entries.
  ['constructor', 'upstream_rejected'],
  ['toString', 'upstream_rejected'],
])('[AC-B1-04za#43] the per-method table maps inner code %j to %s', async (code, expected) => {
  await failsBothWays(wrapped(JSON.stringify({ code })), expected, [], detail);
});

it('[AC-B1-04za#44] the per-method table never applies to the gateway or the outer code, and leaves 403 warned', async () => {
  await failsBothWays(
    response({ error_response: { code: 2001707 } }),
    'upstream_rejected',
    [],
    detail,
  );
  await failsBothWays(wrapped(innerOk, '2001707'), 'upstream_rejected', [], detail);
  await failsBothWays(
    wrapped('{"code":403}'),
    'upstream_misconfigured',
    [{ method, code: '403' }],
    detail,
  );
});
