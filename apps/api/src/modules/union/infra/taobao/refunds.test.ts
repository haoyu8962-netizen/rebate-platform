import { expect, it } from 'vitest';
import { taobaoRefundArchiveBody, taobaoRefundTradeIds } from './refunds.ts';

const A = '2900000000000009001';
const B = '2900000000000009002';
const C = '2900000000000009003';

function body(result: string, extra = ''): string {
  return `{"time":1793433600000,"code":0,"msg":"成功","data":{"has_next":false,"position_index":"p-1"${extra},"result":${result}}}`;
}

it('[AC-B1-04zzu-UNIT#2] taobaoRefundTradeIds：读法同 requiredId（串原样、JSON 整数取十进制原文；空白串、"--"、null、非整数、非对象行读不出），按页序去重；非 JSON、result 非数组答空', () => {
  const text = body(
    `[{"tb_trade_id":"${A}"},{"tb_trade_id":${B}},{"tb_trade_id":"${A}"},{"tb_trade_id":"  "},` +
      `{"tb_trade_id":"--"},{"tb_trade_id":null},{"tb_trade_id":1.5},{"tb_trade_id":true},{},"${C}",${C},null,[{"tb_trade_id":"${C}"}]]`,
  );
  expect(taobaoRefundTradeIds(text)).toEqual([A, B]);
  expect(taobaoRefundTradeIds('not json')).toEqual([]);
  expect(taobaoRefundTradeIds(body('{"x":1}'))).toEqual([]);
  expect(taobaoRefundTradeIds(body('null'))).toEqual([]);
  expect(taobaoRefundTradeIds('{"data":[1]}')).toEqual([]);
  expect(taobaoRefundTradeIds('[1]')).toEqual([]);
});

it('[AC-B1-04zzu-UNIT#3] taobaoRefundArchiveBody：去掉读得出且不在 own 的行，读不出的行与外层字段、数字原文照旧；无可删时原样；result 非数组原样；非 JSON 抛错', () => {
  const mixed = body(
    `[{"tb_trade_id":${A},"fee":0.10000000000000001},{"tb_trade_id":"${B}","fee":1E-7},` +
      `{"tb_trade_id":"--"},"row-text",{"tb_trade_id":"${C}"}]`,
    ',"total":9007199254740993',
  );
  expect(taobaoRefundArchiveBody(mixed, new Set([A]))).toBe(
    '{"time":1793433600000,"code":0,"msg":"成功","data":{"has_next":false,"position_index":"p-1",' +
      `"total":9007199254740993,"result":[{"tb_trade_id":${A},"fee":0.10000000000000001},` +
      '{"tb_trade_id":"--"},"row-text"]}}',
  );
  const spaced = body(`[ {"tb_trade_id": "${A}"} ]`);
  expect(taobaoRefundArchiveBody(spaced, new Set([A]))).toBe(spaced);
  expect(taobaoRefundArchiveBody(body(`[{"tb_trade_id":"${B}"}]`), new Set())).toBe(body('[]'));
  const object = body(`{"list":[{"tb_trade_id":"${B}"}]}`);
  expect(taobaoRefundArchiveBody(object, new Set())).toBe(object);
  expect(taobaoRefundArchiveBody('"text"', new Set())).toBe('"text"');
  expect(() => taobaoRefundArchiveBody('{"data":', new Set())).toThrow();
  expect(() => taobaoRefundArchiveBody('plain text', new Set())).toThrow();
});
