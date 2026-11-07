// B1-08zi（FU-REFUNDED-QUANTITY-WRITER，D10-811 ① / D10-814 ①）：京东订单行 skuNum → quantity、
// skuReturnNum → refunded_quantity（同一行即同一 skuId）；缺键与 JSON null 为 null；有值必须是非负整数
// （orders 列是 integer：不超过 int4 上限），否则 invalid_dto。
// Task-local AC labels ([AC-B1-08zi#n]) identify this task's acceptance points, not business rules.
// 报文全部合成（../../union/jd-orders/kit.ts 的行形状），值都是自拟的。
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { jdQuantityFields } from '../../../../apps/api/src/modules/union/infra/jd/orders.ts';
import { decoded, mapped, num, one, row } from '../../union/jd-orders/kit.ts';

const INT4_MAX = 2_147_483_647;

/** The error a synchronous call throws; undefined when it returns. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The row as the mapper receives it (inner numbers are JdRawNumber), for jdQuantityFields. */
function wireRow(overrides: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return decoded(row(overrides)) as Readonly<Record<string, unknown>>;
}

/** quantity / refunded_quantity of the mapped DTO. */
function counts(overrides: Record<string, unknown>) {
  const dto = mapped(overrides);
  return { quantity: dto.quantity, refunded_quantity: dto.refunded_quantity };
}

it('[AC-B1-08zi#1] skuNum 3、skuReturnNum 1 → DTO quantity 3、refunded_quantity 1（整条适配器路径）', async () => {
  const dto = await one(row({ skuNum: num('3'), skuReturnNum: num('1') }));
  expect(dto.quantity).toBe(3);
  expect(dto.refunded_quantity).toBe(1);
});

it('[AC-B1-08zi#2] jdQuantityFields 只读 skuNum / skuReturnNum 两个字段', () => {
  expect(jdQuantityFields(wireRow({ skuNum: num('5'), skuReturnNum: num('2') }))).toEqual({
    quantity: 5,
    refunded_quantity: 2,
  });
  expect(jdQuantityFields(wireRow({ skuNum: num('1'), skuReturnNum: num('0') }))).toEqual({
    quantity: 1,
    refunded_quantity: 0,
  });
});

type MissingCase = readonly [string, Record<string, unknown>, number | null, number | null];

const MISSING: readonly MissingCase[] = [
  ['两个都缺键', {}, null, null],
  ['两个都是 JSON null', { skuNum: null, skuReturnNum: null }, null, null],
  ['只缺 skuReturnNum', { skuNum: num('4') }, 4, null],
  ['只缺 skuNum', { skuReturnNum: num('1') }, null, 1],
  ['skuReturnNum 为 null', { skuNum: num('2'), skuReturnNum: null }, 2, null],
];

it.each(MISSING)(
  '[AC-B1-08zi#3] %s：缺的那一项是 null（不是 0），mapJdOrder 与 jdQuantityFields 一致',
  (_name, overrides, quantity, refunded) => {
    const expected = { quantity, refunded_quantity: refunded };
    expect(counts(overrides)).toEqual(expected);
    expect(jdQuantityFields(wireRow(overrides))).toEqual(expected);
  },
);

const INVALID: readonly (readonly [string, Record<string, unknown>])[] = [
  ['skuNum 负数', { skuNum: num('-1'), skuReturnNum: num('0') }],
  ['skuReturnNum 负数', { skuNum: num('2'), skuReturnNum: num('-1') }],
  ['skuNum 小数', { skuNum: num('1.5'), skuReturnNum: num('0') }],
  ['skuReturnNum 小数', { skuNum: num('2'), skuReturnNum: num('0.5') }],
  ['skuNum 非数字串', { skuNum: 'abc', skuReturnNum: num('0') }],
  ['skuReturnNum 是布尔', { skuNum: num('2'), skuReturnNum: true }],
  ['skuReturnNum 是对象', { skuNum: num('2'), skuReturnNum: { n: 1 } }],
  ['skuNum 超过 int4 上限', { skuNum: num(String(INT4_MAX + 1)), skuReturnNum: num('0') }],
  ['skuReturnNum 超过 2^53', { skuNum: num('2'), skuReturnNum: num('9007199254740993') }],
];

it.each(INVALID)(
  '[AC-B1-08zi#4] %s → invalid_dto（platform jd），不按 0 或 null 处理',
  (_name, overrides) => {
    expect(thrown(() => mapped(overrides))).toMatchObject({ code: 'invalid_dto', platform: 'jd' });
    expect(thrown(() => jdQuantityFields(wireRow(overrides)))).toMatchObject({
      code: 'invalid_dto',
      platform: 'jd',
    });
  },
);

it('[AC-B1-08zi#5] 错误信息只带字段名，不带报文值', () => {
  const error = thrown(() => jdQuantityFields(wireRow({ skuReturnNum: num('-73519') })));
  expect(error).toMatchObject({ code: 'invalid_dto' });
  const message = error instanceof Error ? error.message : '';
  expect(message).toContain('skuReturnNum');
  expect(message).not.toContain('73519');
});

it('[AC-B1-08zi#6] 任意 0..int4 上限的整数原样映射；与 validCode、金额无关', () => {
  const count = fc.integer({ min: 0, max: INT4_MAX });
  const code = fc.constantFrom('15', '16', '17', '24', '-1', '3');
  expect(() =>
    fc.assert(
      fc.property(count, count, code, (quantity, refunded, validCode) => {
        const result = counts({
          validCode: num(validCode),
          skuNum: num(String(quantity)),
          skuReturnNum: num(String(refunded)),
          actualFee: num('7.89'),
          actualCosPrice: num('44.10'),
        });
        expect(result).toEqual({ quantity, refunded_quantity: refunded });
        return true;
      }),
      propParams(),
    ),
  ).not.toThrow();
}, 900_000);
