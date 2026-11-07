import { expect, it } from 'vitest';
import { taobaoPunishArchiveBody } from './punishments.ts';

// 单元测试（实现者，B1-04zzp）：违规归档正文的改写——只删推广位可读且非我方的行、数字原文保真、
// 无可删行原样返回、非 JSON 抛错。报文全部合成。

const OURS = new Set(['111111111111', '111111111122']);

function punishPage(rows: readonly string[], extra = ''): string {
  return `{"time":1793600000000,"code":0,"msg":"ok"${extra},"data":{"page_no":1,"page_size":10,"total_count":9,"results":[${rows.join(',')}]}}`;
}

it('[AC-B1-04zzp-UNIT#1] 只删 tk_adzone_id 可读且不是我方的行；我方行与读不出推广位的行原序保留，外层字段与 total_count 原样', () => {
  const rows = [
    '{"tb_trade_id":"2900000000000003001","tk_adzone_id":111111111111}',
    '{"tb_trade_id":"2900000000000003050","tk_adzone_id":999999999999}',
    '{"tb_trade_id":"2900000000000003002","tk_adzone_id":"111111111122"}',
    '{"tb_trade_id":"2900000000000003051","tk_adzone_id":"999999999988"}',
    '{"tb_trade_id":"2900000000000003003"}',
    '{"tb_trade_id":"2900000000000003004","tk_adzone_id":"synthetic"}',
    '"synthetic-row-text"',
    'null',
  ];
  const kept = rows.filter((_row, index) => index !== 1 && index !== 3);
  const stored = taobaoPunishArchiveBody(punishPage(rows, ',"request_id":"r-1"'), OURS);
  expect(JSON.parse(stored)).toEqual(JSON.parse(punishPage(kept, ',"request_id":"r-1"')));
  expect(stored).not.toContain('2900000000000003050');
  expect(stored).not.toContain('2900000000000003051');
  expect(stored).toContain('2900000000000003004');
});

it('[AC-B1-04zzp-UNIT#2] 删行后重写的正文里 JSON 数字原文不失真（长整型、小数、指数写法）', () => {
  const rows = [
    '{"tb_trade_id":2900000000000003123,"rate":0.29999999999999999,"price":7.10,"tiny":1E-7,"tk_adzone_id":111111111111}',
    '{"rate":0.10000000000000001,"tk_adzone_id":222222222222}',
  ];
  const stored = taobaoPunishArchiveBody(punishPage(rows, ',"big":9007199254740993'), OURS);
  for (const literal of [
    '2900000000000003123',
    '0.29999999999999999',
    '7.10',
    '1E-7',
    '9007199254740993',
    '1793600000000',
    '111111111111',
  ]) {
    expect(stored).toContain(literal);
  }
  expect(stored).not.toContain('0.10000000000000001');
  expect(stored).not.toContain('222222222222');
});

it('[AC-B1-04zzp-UNIT#3] 无可删行、results 不是数组、data 或整体不是对象时原样返回；整页别家时 results 为空数组；非 JSON 抛错', () => {
  const unchanged = [
    punishPage(['{"tk_adzone_id":111111111111}', '{"tk_adzone_id":"bad"}']),
    punishPage([]),
    '{"data":{"total_count":0,"results":null}}',
    '{"data":{"total_count":0,"results":{"x":{"tk_adzone_id":999}}}}',
    '{"data":7}',
    '{"code":1}',
    '[{"tk_adzone_id":999}]',
    '  {"data" : {"results" : [ {"tk_adzone_id" : 111111111111} ] } }  ',
  ];
  for (const body of unchanged) expect(taobaoPunishArchiveBody(body, OURS)).toBe(body);
  const allForeign = taobaoPunishArchiveBody(
    punishPage(['{"tk_adzone_id":999999999999}', '{"tk_adzone_id":"999999999988"}']),
    OURS,
  );
  expect(JSON.parse(allForeign)).toEqual(JSON.parse(punishPage([])));
  for (const body of ['synthetic not json', punishPage(['{"tk_adzone_id":2']).slice(0, -5), '']) {
    expect(() => taobaoPunishArchiveBody(body, OURS)).toThrow(SyntaxError);
  }
  // 正文是合法 JSON 才拼进外壳：第二个顶层值不会借外壳混进去。
  expect(() =>
    taobaoPunishArchiveBody('{"data":{"results":[]}},"data":{"results":[]}', OURS),
  ).toThrow(SyntaxError);
});
