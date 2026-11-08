// B1-04zzzze (D10-1072 ②): the archived error_code also reads the 淘宝 error_response that 大淘客
// forwards inside `data`, when the body has no top-level error_response object. Synthetic data only.
import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { responseErrorCode } from '../../../../apps/api/src/modules/union/infra/archive.ts';
import type { UnionTransportResponse } from '../../../../apps/api/src/modules/union/infra/replay.ts';

function reply(status: number, body: string): UnionTransportResponse {
  return { status, headers: { 'x-synthetic': 'reply' }, body };
}

/** A 大淘客 reply that forwards a 淘宝 error inside data (the shape this task is about). */
const NESTED =
  '{"code":0,"data":{"error_response":{"code":11,"sub_code":"isv.synthetic","msg":"合成说明"}}}';

/** Both levels carry an error_response object. */
const BOTH = '{"error_response":{"code":7},"data":{"error_response":{"code":11}}}';

it.each([
  [200, NESTED, '11'],
  [201, '{"code":0,"data":{"error_response":{"code":"E-synthetic"}}}', 'E-synthetic'],
  [299, '{"code":0,"data":{"error_response":{"error_code":50001,"code":8}}}', '50001'],
  [200, '{"code":0,"data":{"error_response":{"error_code":null,"code":27}}}', '27'],
  [200, '{"code":0,"data":{"error_response":{"error_code":0,"code":8}}}', '0'],
  [200, '{"code":0,"data":{"error_response":{"error_code":"isv.e-syn"}}}', 'isv.e-syn'],
  [200, '{"data":{"error_response":{}}}', 'undefined'],
  [200, '{"code":0,"data":{"list":[],"error_response":{"code":15,"msg":"x"}}}', '15'],
  // No top-level error_response *object*: null / array / string / number there fall through to data.
  [200, '{"error_response":null,"data":{"error_response":{"code":12}}}', '12'],
  [200, '{"error_response":[{"code":1}],"data":{"error_response":{"code":13}}}', '13'],
  [200, '{"error_response":"synthetic","data":{"error_response":{"code":14}}}', '14'],
  [200, '{"error_response":3,"data":{"error_response":{"error_code":16}}}', '16'],
] as const)(
  '[AC-B1-04zzzze#1] status=%s body=%s：顶层无 error_response 对象时取 data.error_response 的 error_code ?? code → %s',
  (status, body, code) => {
    expect(responseErrorCode(reply(status, body))).toBe(code);
  },
);

it('[AC-B1-04zzzze#2] 顶层 error_response 对象优先于 data 内的（即使两处都有）；只有 data 内时取 data 内的', () => {
  const topFirst =
    '{"error_response":{"error_code":9,"code":3},"data":{"error_response":{"error_code":4}}}';
  const topEmpty = '{"error_response":{},"data":{"error_response":{"code":11}}}';
  // Regression: the top level keeps priority.
  expect(responseErrorCode(reply(200, BOTH))).toBe('7');
  expect(responseErrorCode(reply(200, topFirst))).toBe('9');
  expect(responseErrorCode(reply(200, topEmpty))).toBe('undefined');
  // New: only the nested one.
  expect(responseErrorCode(reply(200, '{"data":{"error_response":{"code":11}}}'))).toBe('11');
});

it.each([
  ['大淘客正常回包', '{"code":0,"msg":"ok","data":{"list":[{"id":"synthetic-1"}],"totalNum":1}}'],
  ['大淘客正常回包（data 为空对象）', '{"code":0,"data":{}}'],
  ['data.error_response 为 null', '{"code":0,"data":{"error_response":null}}'],
  ['data.error_response 为数组', '{"code":0,"data":{"error_response":[{"code":11}]}}'],
  ['data.error_response 为字符串', '{"code":0,"data":{"error_response":"synthetic"}}'],
  ['data.error_response 为数字', '{"code":0,"data":{"error_response":11}}'],
  ['data 为字符串', '{"code":0,"data":"{\\"error_response\\":{\\"code\\":11}}"}'],
  ['data 为 null', '{"code":0,"data":null}'],
  ['data 为数组', '{"code":0,"data":[{"error_response":{"code":11}}]}'],
  ['只在更深一层', '{"code":0,"data":{"data":{"error_response":{"code":11}}}}'],
  ['在 data 以外的键下', '{"code":0,"result":{"error_response":{"code":11}}}'],
  ['顶层 error_response 为 null 且无 data', '{"error_response":null}'],
  ['body 是数组', '[{"data":{"error_response":{"code":11}}}]'],
  ['body 不是 JSON', 'data.error_response.code=11'],
  ['body 为空', ''],
] as const)(
  '[AC-B1-04zzzze#3] %s → NULL；同一用例里 data 内有 error_response 对象时记其码',
  (_label, body) => {
    expect(responseErrorCode(reply(200, body))).toBeNull();
    expect(responseErrorCode(reply(200, NESTED))).toBe('11');
  },
);

it.each([199, 300, 302, 404, 500, 503])(
  '[AC-B1-04zzzze#4] 非 2xx（%s）即使 data 内有 error_response 也记 http_<status>；2xx 时记 data 内的码',
  (status) => {
    expect(responseErrorCode(reply(status, NESTED))).toBe(`http_${status}`);
    expect(responseErrorCode(reply(status, BOTH))).toBe(`http_${status}`);
    expect(responseErrorCode(reply(200, NESTED))).toBe('11');
  },
);

const OTHER_KEYS = ['code', 'msg', 'time', 'requestId', 'sub_code', 'sub_msg', 'list'] as const;

it('[AC-B1-04zzzze#5] 性质：任一 2xx、顶层无 error_response 键、data.error_response 是对象 → String(error_code ?? code)；顶层加 error_response 对象后改记顶层的', () => {
  const codeValue = fc.oneof(fc.integer(), fc.string({ maxLength: 24 }));
  const extras = fc.dictionary(
    fc.constantFrom(...OTHER_KEYS),
    fc.oneof(fc.integer(), fc.string({ maxLength: 8 })),
    { maxKeys: 4 },
  );
  let checked = 0;
  fc.assert(
    fc.property(
      fc.integer({ min: 200, max: 299 }),
      codeValue,
      // undefined: no error_code key at all.
      fc.oneof(fc.constant(undefined), fc.constant(null), codeValue),
      extras,
      extras,
      extras,
      codeValue,
      (status, code, errorCode, outer, data, envelopeExtras, topCode) => {
        const envelope: Record<string, unknown> = { ...envelopeExtras, code };
        if (errorCode !== undefined) envelope['error_code'] = errorCode;
        const expected = String(errorCode ?? code);
        const body = { ...outer, data: { ...data, error_response: envelope } };
        expect(responseErrorCode(reply(status, JSON.stringify(body)))).toBe(expected);
        const withTop = { ...body, error_response: { code: topCode } };
        expect(responseErrorCode(reply(status, JSON.stringify(withTop)))).toBe(String(topCode));
        checked += 1;
        return true;
      },
    ),
    { numRuns: Math.max(50, Math.floor(propRuns() / 100)), seed: propSeed() },
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);
