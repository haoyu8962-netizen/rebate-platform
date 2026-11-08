import { expect, it, vi } from 'vitest';
import { UnionError, type UnionErrorCode } from '../../domain/types.ts';
import type { UnionTransportResponse } from '../replay.ts';
import { JdRawNumber, unwrapJdResponse, type JdWarning } from './response.ts';

// 合成报文，不是录制；方法名与外层键都是合成值。内层原文用 String.raw 写，转义由解析器处理。
const method = 'jd.union.open.synthetic.get';
const envelope = 'jd_union_open_synthetic_get_responce';
const resultKey = 'queryResult';
const keys = { envelope, resultKey };

function wire(innerText: string): UnionTransportResponse {
  const body = JSON.stringify({ [envelope]: { code: '0', [resultKey]: innerText } });
  return { status: 200, headers: {}, body };
}

function failureCode(innerText: string): UnionErrorCode {
  try {
    unwrapJdResponse(method, keys, wire(innerText));
  } catch (error) {
    expect(error).toBeInstanceOf(UnionError);
    return (error as UnionError).code;
  }
  throw new Error('expected a failure');
}

it.each([
  '{"message":"success"}',
  '{"message":"success","success":true,"data":[]}',
  '{"code":null,"message":"success"}',
])('[AC-B1-04za-UNIT#1] 内层没有 code（%s）按缺失判 upstream_unavailable', (text) => {
  expect(failureCode(text)).toBe('upstream_unavailable');
});

it('[AC-B1-04za-UNIT#2] 成败只看 code：message 写失败、code 200 仍是成功', () => {
  const inner = unwrapJdResponse(method, keys, wire('{"code":200,"message":"failed"}'));
  expect(inner.message).toBe('failed');
});

it.each([
  ['{"code":403,"message":"success"}', 'upstream_misconfigured'],
  ['{"code":429,"message":"success"}', 'rate_limited'],
  ['{"code":0,"message":"success"}', 'upstream_rejected'],
] as const)('[AC-B1-04za-UNIT#3] 内层 %s 不因 message 改判，判 %s', (text, expected) => {
  expect(failureCode(text)).toBe(expected);
});

it.each([
  ['{"code":200.0}', 'upstream_rejected'],
  ['{"code":2e2}', 'upstream_rejected'],
  ['{"code":" 200"}', 'upstream_unavailable'],
  ['{"code":true}', 'upstream_unavailable'],
] as const)('[AC-B1-04za-UNIT#4] 内层 %s 不是成功 code，判 %s', (text, expected) => {
  expect(failureCode(text)).toBe(expected);
});

it('[AC-B1-04za-UNIT#5] 字符串转义完整：\\uXXXX、代理对、\\/ 与常见转义都还原', () => {
  const text =
    '{"code":200,"cjk":"\\u6c49\\u5b57","emoji":"\\ud83d\\ude00",' +
    String.raw`"url":"https:\/\/x.invalid\/a","mixed":"\"\\\b\f\n\r\t"}`;
  expect(text).toContain('\\u6c49');
  expect(text).toContain('\\ud83d\\ude00');
  expect(unwrapJdResponse(method, keys, wire(text))).toMatchObject({
    cjk: '汉字',
    emoji: '😀',
    url: 'https://x.invalid/a',
    mixed: '"\\\b\f\n\r\t',
  });
});

it('[AC-B1-04za-UNIT#6] 成员名里的转义同样还原：\\u0063ode 就是 code', () => {
  const text = '{"\\u0063ode":200,"k":1.50}';
  expect(text).toContain('\\u0063ode');
  const inner = unwrapJdResponse(method, keys, wire(text));
  expect((inner.k as JdRawNumber).text).toBe('1.50');
});

it('[AC-B1-04za-UNIT#7] JSON 空白合法，数字原文不含空白', () => {
  const inner = unwrapJdResponse(method, keys, wire(' {\n "code" : 200 ,\t"k" : [ 12.30 ] }\r\n'));
  expect((inner.k as readonly JdRawNumber[])[0]?.text).toBe('12.30');
});

it.each([
  String.raw`{"code":200,"a":"\u12"}`,
  String.raw`{"code":200,"a":"\x41"}`,
  String.raw`{"code":200,"a":"\"}`,
  '{"code":200,"a":"bare\nnewline"}',
  "{'code':200}",
  '{"code":200,"a":1.2.3}',
  '{"code":200,"a":012}',
  '{"code":200,"a":1.}',
  '{"code":200,"a":01.5}',
  '{"code":200,"a":1e+}',
  '{"code":200,"a":Infinity}',
  '{"code":200,"a":[1,]}',
  '{"code":200} x',
])('[AC-B1-04za-UNIT#8] 严格按 JSON 语法：%s 判解析失败', (text) => {
  expect(failureCode(text)).toBe('upstream_unavailable');
});

it.each(['200', '12.30', '-1'])(
  '[AC-B1-04za-UNIT#9] 内层整体是数字 %s 不是对象（JdRawNumber 不算对象）',
  (text) => {
    expect(failureCode(text)).toBe('upstream_unavailable');
  },
);

it('[AC-B1-04za-UNIT#10] __proto__ 成员是普通自有属性，不污染原型', () => {
  const inner = unwrapJdResponse(
    method,
    keys,
    wire('{"code":200,"__proto__":{"polluted":1},"rows":[{"__proto__":{"polluted":2}}]}'),
  );
  expect(Object.hasOwn(inner, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(inner)).toBe(Object.prototype);
  expect(Reflect.get(inner, 'polluted')).toBeUndefined();
  expect(Reflect.get({}, 'polluted')).toBeUndefined();
});

it('[AC-B1-04za-UNIT#11] 超出 double 范围的数字也保留原文，不变成 Infinity', () => {
  const inner = unwrapJdResponse(method, keys, wire('{"code":200,"big":1e400,"small":-0.0}'));
  expect((inner.big as JdRawNumber).text).toBe('1e400');
  expect((inner.small as JdRawNumber).text).toBe('-0.0');
});

it('[AC-B1-04za-UNIT#12] 内层 403 只告警一次，只带方法名与 code', () => {
  const warn = vi.fn<(event: JdWarning) => void>();
  expect(() => unwrapJdResponse(method, keys, wire('{"code":403}'), warn)).toThrow(UnionError);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith({ method, code: '403' });
});
