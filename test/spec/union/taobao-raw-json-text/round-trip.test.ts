// B1-04zzzzj：对无空白、无重复键的 JSON 对象文本 X，parseTaobaoRawData(`{"data":X}`) 读出的 data 树经
// taobaoRawJsonText 写回逐字等于 X（大整数、小数尾 0、-0、指数写法都按原文）。键名避开数组下标形状（纯十进制整数），
// 那类键在 JS 对象里不按插入顺序排列。operation 取 orders.ts:501 的现有值 'listOrders'。
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { parseTaobaoRawData } from '../../../../apps/api/src/modules/union/infra/taobao/orders.ts';
import { taobaoRawJsonText } from '../../../../apps/api/src/modules/union/infra/taobao/raw-json.ts';

function roundTrip(text: string): string {
  return taobaoRawJsonText(parseTaobaoRawData(`{"data":${text}}`, 'listOrders'));
}

it.each([
  ['{}'],
  ['{"num_iid":12345678901234567890,"fee":1.10,"rate":0.000001,"neg":-0,"exp":1e3,"E":2.50E+10}'],
  ['{"price":"1.10","alipay_total_price":19.90,"tk_status":12,"has_next":false,"position":null}'],
  ['{"results":{"publisher_order_dto":[{"trade_id":"1","pub_share_fee":0.00},{"trade_id":2}]}}'],
  ['{"list":[[],[1.0,[-0.0]],{"k":true},{}],"empty":{},"zero":0,"big":-98765432109876543210.10}'],
  [String.raw`{"text":"引号\"与反斜杠\\和换行\n","esc":"\u0001\t","emoji":"😀","键":"值"}`],
])('[AC-B1-04zzzzj#10] 往返：%s 解析后写回逐字相同', (text) => {
  expect(roundTrip(text)).toBe(text);
});

/** JSON number literals: sign, integer part, optional fraction (trailing 0s kept), exponent. */
const numberText = fc
  .record({
    minus: fc.boolean(),
    whole: fc.oneof(
      fc.constant('0'),
      fc.bigInt({ min: 1n, max: 10n ** 30n }).map((value) => value.toString()),
    ),
    fraction: fc.option(fc.array(fc.constantFrom(...'0123456789'), { minLength: 1, maxLength: 8 })),
    exponent: fc.option(
      fc.record({
        mark: fc.constantFrom('e', 'E'),
        sign: fc.constantFrom('', '+', '-'),
        digits: fc.nat({ max: 400 }),
      }),
    ),
  })
  .map(({ minus, whole, fraction, exponent }) => {
    const sign = minus ? '-' : '';
    const decimals = fraction === null ? '' : `.${fraction.join('')}`;
    const power = exponent === null ? '' : `${exponent.mark}${exponent.sign}${exponent.digits}`;
    return `${sign}${whole}${decimals}${power}`;
  });

const anyString = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.string({ unit: 'binary', maxLength: 8 }),
);

/** Member names that are not array-index shaped (those are listed before the others in JS). */
const memberName = anyString.filter((name) => !/^(?:0|[1-9][0-9]*)$/.test(name));

// A type alias (not an interface) so it satisfies `Record<string, unknown>` and fc.letrec picks
// its typed overload, where tie('leaf') etc. are Arbitrary<string>.
type JsonTexts = {
  value: string;
  leaf: string;
  array: string;
  object: string;
};

const json = fc.letrec<JsonTexts>((tie) => ({
  value: fc.oneof({ maxDepth: 4, depthSize: 'small' }, tie('leaf'), tie('array'), tie('object')),
  leaf: fc.oneof(
    numberText,
    anyString.map((text) => JSON.stringify(text)),
    fc.constantFrom('null', 'true', 'false'),
  ),
  array: fc.array(tie('value'), { maxLength: 4 }).map((items) => `[${items.join(',')}]`),
  object: fc
    .uniqueArray(fc.tuple(memberName, tie('value')), {
      maxLength: 4,
      selector: ([name]) => name,
    })
    .map((members) => {
      const written = members.map(([name, member]) => `${JSON.stringify(name)}:${member}`);
      return `{${written.join(',')}}`;
    }),
}));

it('[AC-B1-04zzzzj#11] 任意无空白、无重复键的 JSON 对象文本：解析后经 taobaoRawJsonText 写回逐字相同', () => {
  fc.assert(
    fc.property(json.object, (text) => {
      expect(roundTrip(text)).toBe(text);
    }),
    propParams(),
  );
}, 900_000);
