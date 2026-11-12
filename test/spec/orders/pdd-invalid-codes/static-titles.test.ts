// B2-10c · 静态标题用例（FU-LOSS-LS17-STATIC-TEST，D10-1398）：刻画主干现有行为，供 specs/loss-scenarios.md
// LS-17 引用。alerts.test.ts [AC-B1-04zgc#7]、adapter.test.ts #11、commission-gross.test.ts #14 已覆盖
// 「拼多多 order_status 4 / 10 而联盟仍带正数佣金：照样给原码、按失效处理，并恰有一条
// pdd_invalid_with_commission 告警」，但都是 it.each 参数化标题；本文件用字面量标题、同口径断言补几条。
// 直接调 mapPddOrder，告警出口是这页元数据上的测试 logger；失效映射读真实 specs/order-status-map/pdd.csv。
// 报文全部合成。
import { expect, it } from 'vitest';
import {
  loadStatusMap,
  mapPlatformStatus,
} from '../../../../apps/api/src/modules/orders/domain/status-map.ts';
import { mapPddOrder } from '../../../../apps/api/src/modules/union/infra/pdd/orders.ts';
import { requiredStatusCsv } from '../status-map/fixtures.ts';
import {
  COMMISSION_ALERT,
  FAIL_REASON,
  PROMOTION_AMOUNT,
  SERVICE_FEE,
  UNMAPPED_ALERT,
  expectRedacted,
  pageWith,
  pddRow,
  testLogger,
} from './kit.ts';

it('[AC-B2-10c#1] 拼多多列表报文（increment）order_status 4 带正数佣金：原码 4 与佣金照给，恰一条 pdd_invalid_with_commission 告警（platform pdd）加一条 order_reason_sub_unmapped，共两条，都不带单号 / 金额 / 用户', () => {
  const log = testLogger();
  const dto = mapPddOrder(
    pddRow({
      order_status: 4,
      promotion_amount: PROMOTION_AMOUNT,
      duo_id_service_fee: SERVICE_FEE,
      fail_reason: FAIL_REASON,
    }),
    'increment',
    pageWith(log.logger),
  );
  expect(dto).toMatchObject({ raw_status: '4', commission_fen: BigInt(PROMOTION_AMOUNT) });
  const withCommission = log.withCommission();
  const unmapped = log.unmapped();
  expect(withCommission).toHaveLength(1);
  expect(withCommission[0]!.fields).toMatchObject({ alert: COMMISSION_ALERT, platform: 'pdd' });
  expect(unmapped).toHaveLength(1);
  expect(unmapped[0]!.fields).toMatchObject({
    alert: UNMAPPED_ALERT,
    platform: 'pdd',
    fail_reason: FAIL_REASON,
  });
  expect(log.lines()).toHaveLength(2);
  expectRedacted(withCommission[0]!);
  expectRedacted(unmapped[0]!, FAIL_REASON);
});

it('[AC-B2-10c#2] 拼多多详情报文（detail）order_status 10 带正数佣金：原码 10 与佣金照给，恰一条 pdd_invalid_with_commission 告警（platform pdd）加一条 order_reason_sub_unmapped（详情无 fail_reason，按缺失计），共两条，都不带单号 / 金额 / 用户', () => {
  const log = testLogger();
  const dto = mapPddOrder(
    pddRow({
      order_status: 10,
      promotion_amount: PROMOTION_AMOUNT,
      duo_id_service_fee: SERVICE_FEE,
      fail_reason: FAIL_REASON,
    }),
    'detail',
    pageWith(log.logger),
  );
  expect(dto).toMatchObject({ raw_status: '10', commission_fen: BigInt(PROMOTION_AMOUNT) });
  const withCommission = log.withCommission();
  const unmapped = log.unmapped();
  expect(withCommission).toHaveLength(1);
  expect(withCommission[0]!.fields).toMatchObject({ alert: COMMISSION_ALERT, platform: 'pdd' });
  expect(unmapped).toHaveLength(1);
  expect(unmapped[0]!.fields).toMatchObject({ alert: UNMAPPED_ALERT, platform: 'pdd' });
  expect(unmapped[0]!.fields['fail_reason'] ?? null).toBeNull();
  expect(log.lines()).toHaveLength(2);
  expectRedacted(withCommission[0]!);
  expectRedacted(unmapped[0]!);
});

it('[AC-B2-10c#3] 拼多多 order_status 4、10 带正数佣金按失效处理：映射给出的原码在 specs/order-status-map/pdd.csv 里都映 PLATFORM_INVALID（未实测），不因佣金为正改映别的事件', () => {
  const map = loadStatusMap('pdd', requiredStatusCsv('pdd'));
  const log = testLogger();
  const page = pageWith(log.logger);
  const commission = {
    promotion_amount: PROMOTION_AMOUNT,
    duo_id_service_fee: SERVICE_FEE,
    fail_reason: FAIL_REASON,
  };
  const four = mapPddOrder(pddRow({ order_status: 4, ...commission }), 'increment', page);
  const ten = mapPddOrder(pddRow({ order_status: 10, ...commission }), 'detail', page);
  expect(four).toMatchObject({ raw_status: '4', commission_fen: BigInt(PROMOTION_AMOUNT) });
  expect(ten).toMatchObject({ raw_status: '10', commission_fen: BigInt(PROMOTION_AMOUNT) });
  expect(mapPlatformStatus(map, four.raw_status)).toEqual({
    kind: 'event',
    event: 'PLATFORM_INVALID',
    verified: false,
  });
  expect(mapPlatformStatus(map, ten.raw_status)).toEqual({
    kind: 'event',
    event: 'PLATFORM_INVALID',
    verified: false,
  });
  expect(log.withCommission()).toHaveLength(2);
});

it('[AC-B2-10c#4] 反例：拼多多列表报文（increment）order_status 4、promotion_amount 0 时不打 pdd_invalid_with_commission，只有一条 order_reason_sub_unmapped', () => {
  const log = testLogger();
  const dto = mapPddOrder(
    pddRow({ order_status: 4, promotion_amount: 0, fail_reason: FAIL_REASON }),
    'increment',
    pageWith(log.logger),
  );
  expect(dto).toMatchObject({ raw_status: '4', commission_fen: 0n });
  expect(log.withCommission()).toEqual([]);
  const unmapped = log.unmapped();
  expect(unmapped).toHaveLength(1);
  expect(unmapped[0]!.fields).toMatchObject({ alert: UNMAPPED_ALERT, platform: 'pdd' });
  expect(log.lines()).toHaveLength(1);
  expectRedacted(unmapped[0]!, FAIL_REASON);
});
