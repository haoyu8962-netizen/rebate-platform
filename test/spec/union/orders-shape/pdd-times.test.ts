import { expect, it } from 'vitest';
import { one, sourceRow, sources } from './kit.ts';

it.each(sources)(
  '[AC-B1-08e-TIME#1] %s 秒转 Date；仅取该接口已有字段，定金未知为 null',
  async (source) => {
    const dto = await one(source);
    expect(dto).toMatchObject({
      deposit_paid_at: null,
      paid_at: new Date('2026-10-14T00:00:02.000Z'),
      received_at: source === 'increment' ? new Date('2026-10-14T00:00:04.000Z') : null,
      settled_at: source === 'detail' ? null : new Date('2026-10-14T00:00:06.000Z'),
      modified_at: new Date('2026-10-14T00:00:07.000Z'),
    });
    expect(dto.order_pay_time).toBe(1791936002);
    expect(dto.order_modify_at).toBe(1791936007);
  },
);

for (const source of sources) {
  it.each([0, undefined, null])(
    `[AC-B1-08e-TIME#2] ${source} 时间 %s 统一为 null，保留原秒字段含义`,
    async (absent) => {
      const input = sourceRow(source);
      for (const key of [
        'order_pay_time',
        'order_receive_time',
        'order_settle_time',
        'order_modify_at',
      ]) {
        if (absent === undefined) delete input[key];
        else input[key] = absent;
      }
      const dto = await one(source, input);
      expect(dto).toMatchObject({
        deposit_paid_at: null,
        paid_at: null,
        received_at: null,
        settled_at: null,
        modified_at: null,
        order_pay_time: absent === 0 ? 0 : null,
        order_modify_at: absent === 0 ? 0 : null,
        order_receive_time: source !== 'pay_time' && absent === 0 ? 0 : null,
        order_settle_time: absent === 0 ? 0 : null,
      });
    },
  );
}

it('[AC-B1-08e-TIME#3] 各时间独立判空，一秒是有效时刻，未结算不借用付款时间', async () => {
  const dto = await one(
    'increment',
    sourceRow('increment', {
      order_pay_time: 1,
      order_receive_time: 0,
      order_settle_time: undefined,
      order_modify_at: 1791936007,
    }),
  );
  expect(dto).toMatchObject({
    deposit_paid_at: null,
    paid_at: new Date('1970-01-01T00:00:01.000Z'),
    received_at: null,
    settled_at: null,
    modified_at: new Date('2026-10-14T00:00:07.000Z'),
  });
});
