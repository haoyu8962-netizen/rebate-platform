import { expect, it } from 'vitest';
import { planCommissionSnapshot } from '../../../../apps/api/src/modules/orders/index.ts';
import type { CreateCommissionSnapshotInput } from '../../../../apps/api/src/modules/commission/application/snapshot.ts';
import { input, PAID } from './plan-kit.ts';

it('[AC-B1-08k#8] 快照端口逐字段：N 就是 est，归属/类型/活动/时间不混淆', () => {
  // Structural compatibility with the real port is also checked by tsc.
  const actual: { kind: string; input?: CreateCommissionSnapshotInput } =
    planCommissionSnapshot(input());
  expect(actual).toEqual({
    kind: 'call',
    input: {
      appId: 'app-A',
      orderId: 'order-A',
      platform: 'pdd',
      paidAt: PAID,
      paidAtSource: 'platform',
      orderType: 'share',
      activityType: 'synthetic-activity',
      rebateMode: null,
      nBaseFen: 1001n,
      subsidyCommissionFen: 0n,
      tljDeductFen: 0n,
      tljRedpacketFen: 0n,
      ownerUserId: 'owner-A',
    },
  });
});

it.each([0n, 501n, -51n, 9007199254740993n])(
  '[AC-B1-08k#9] 结算非空优先，不再减服务费，保留整数精度和符号：%s',
  (settle_commission_fen) => {
    const i = input();
    const expected = new Map<bigint, bigint>([
      [0n, 0n],
      [501n, 501n],
      [-51n, -51n],
      [9007199254740993n, 9007199254740993n],
    ]);
    expect(
      planCommissionSnapshot({ ...i, order: { ...i.order, settle_commission_fen } }),
    ).toMatchObject({ kind: 'call', input: { nBaseFen: expected.get(settle_commission_fen) } });
  },
);

it.each(['jd', 'taobao'] as const)(
  '[AC-B1-08k#10] %s 不扣 PDD 服务费，补贴与 self 类型照订单传递',
  (platform) => {
    const i = input();
    expect(
      planCommissionSnapshot({
        ...i,
        order: {
          ...i.order,
          platform,
          buy_type: 'self',
          activity_type: null,
          subsidy_commission_fen: 77n,
        },
      }),
    ).toMatchObject({
      kind: 'call',
      input: {
        platform,
        nBaseFen: 1001n,
        subsidyCommissionFen: 77n,
        orderType: 'self',
        activityType: null,
      },
    });
  },
);

it('[AC-B1-08k#11] 两种收入全空进入金额待处理，不用零兜底', () => {
  const i = input();
  expect(planCommissionSnapshot({ ...i, order: { ...i.order, est_commission_fen: null } })).toEqual(
    { kind: 'pending', reason: 'AMOUNT_PARSE_FAILED' },
  );
});

it('[AC-B1-08k#12] PDD est 有值时本次报文缺服务费照常生成；est 为空且缺服务费待处理，明确的零费有效', () => {
  const i = input();
  expect(
    planCommissionSnapshot({ ...i, incoming: { ...i.incoming, service_fee_fen: null } }),
  ).toMatchObject({ kind: 'call', input: { nBaseFen: 1001n } });
  expect(
    planCommissionSnapshot({
      ...i,
      order: { ...i.order, est_commission_fen: null },
      incoming: { ...i.incoming, service_fee_fen: null },
    }),
  ).toEqual({ kind: 'pending', reason: 'SERVICE_FEE_RATE_MISSING' });
  expect(
    planCommissionSnapshot({ ...i, incoming: { ...i.incoming, service_fee_fen: 0n } }),
  ).toMatchObject({ kind: 'call', input: { nBaseFen: 1001n } });
});

it('[AC-B1-08k#13] 淘礼金面额未匹配仍生成快照，红包记空且默认不返利', () => {
  expect(planCommissionSnapshot(input({ pidScene: 'taolijin' }))).toMatchObject({
    kind: 'call',
    input: { tljRedpacketFen: null, rebateMode: 'none' },
  });
});
