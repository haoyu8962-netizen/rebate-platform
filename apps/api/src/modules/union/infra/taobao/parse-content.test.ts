import { expect, it } from 'vitest';
import { UnionError } from '../../domain/types.ts';
import {
  DATAOKE_PARSE_CONTENT_CODES,
  DATAOKE_PARSE_CONTENT_PATH,
  DATAOKE_PARSE_CONTENT_VERSION,
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
