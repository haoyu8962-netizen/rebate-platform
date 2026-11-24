import { expect, it } from 'vitest';
import { UnionError } from '../../domain/types.ts';
import {
  DATAOKE_PARSE_CONTENT_ARCHIVE_OMIT,
  DATAOKE_PARSE_CONTENT_CODES,
  DATAOKE_PARSE_CONTENT_MISSING_DATA,
  DATAOKE_PARSE_CONTENT_PATH,
  DATAOKE_PARSE_CONTENT_VERSION,
  parseContentArchiveBody,
  parseContentGoodsId,
  parseContentParameters,
} from './parse-content.ts';

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof UnionError ? error.code : 'not-union-error';
  }
  return undefined;
}

it('parse-content 路径、版本与 25003 细分', () => {
  expect(DATAOKE_PARSE_CONTENT_PATH).toBe('/api/tb-service/parse-content');
  expect(DATAOKE_PARSE_CONTENT_VERSION).toBe('v1.0.0');
  expect(DATAOKE_PARSE_CONTENT_CODES).toEqual({ '25003': 'link_unrecognized' });
});

it.each([
  'https://s.click.taobao.com/t?e=x',
  '  【合成】￥Syn01￥ 文案\n',
  'https://m.tb.cn/h.Syn?tk=1',
])('parseContentParameters 原样带 content：%j', (raw) => {
  expect(parseContentParameters(raw)).toStrictEqual({ content: raw });
});

it.each(['', '   ', '\n\t'])('parseContentParameters 空白输入 %j → link_unrecognized', (raw) => {
  expect(codeOf(() => parseContentParameters(raw))).toBe('link_unrecognized');
});

it('parseContentGoodsId 只取非空字符串 goodsId，不带回其他字段', () => {
  expect(
    parseContentGoodsId({
      goodsId: '9007199254740993123',
      pid: 'syn-pid',
      url: 'https://promotion.invalid/x',
      originInfo: { activityId: 'syn-act' },
    }),
  ).toBe('9007199254740993123');
});

it.each<[string, Record<string, unknown>]>([
  ['缺 goodsId', { pid: 'syn-pid' }],
  ['空串', { goodsId: '' }],
  ['数字', { goodsId: 123 }],
  ['null', { goodsId: null }],
  ['对象', { goodsId: { id: '1' } }],
])('parseContentGoodsId %s → link_unrecognized，错误信息不带上游字段', (_name, data) => {
  let caught: unknown;
  try {
    parseContentGoodsId(data);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(UnionError);
  expect((caught as UnionError).code).toBe('link_unrecognized');
  expect((caught as UnionError).message).not.toContain('syn-pid');
});

it('[AC-B1-04zzzzo-UNIT#4] 归档选项：摘要剔除 content，成功码无 data → link_unrecognized', () => {
  expect(DATAOKE_PARSE_CONTENT_ARCHIVE_OMIT).toEqual(['content']);
  expect(DATAOKE_PARSE_CONTENT_MISSING_DATA).toBe('link_unrecognized');
});

it('[AC-B1-04zzzzo-UNIT#5] 归档应答白名单：只留 code、data.goodsId 与 error_response 的 code / sub_code', () => {
  const full = JSON.stringify({
    time: 1,
    code: 0,
    msg: '￥UnitEcho01￥',
    data: {
      goodsId: 'g1',
      pid: 'p1',
      commissionRate: 'r1',
      url: 'https://promotion.invalid/u1',
      originInfo: { activityId: 'a1' },
      error_response: { code: 15, sub_code: 'isv.x', sub_msg: 'm1' },
    },
  });
  expect(JSON.parse(parseContentArchiveBody(full))).toEqual({
    code: 0,
    data: { goodsId: 'g1', error_response: { code: 15, sub_code: 'isv.x' } },
  });
  expect(parseContentArchiveBody('{"code":25003,"msg":"echo","data":null}')).toBe(
    '{"code":25003,"data":null}',
  );
  expect(parseContentArchiveBody('{"code":0,"data":{"goodsId":7,"title":"t"}}')).toBe(
    '{"code":0,"data":{}}',
  );
  expect(parseContentArchiveBody('{"code":{"x":1},"data":"s"}')).toBe('{}');
  expect(parseContentArchiveBody('not json ￥UnitEcho02￥')).toBe('');
  expect(parseContentArchiveBody('[1]')).toBe('');
});
