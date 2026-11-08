// B1-08zy（FU-TB-FEE-MISSING-METRIC，编排 D10-741 ⑤、D10-992 ①选 (a)）：已有 est 的单，后续报文服务费与 est
// 都缺（serviceFeeDeducted 的平台，est 不覆盖、版本不前进）时计哪些数。条件与 B1-08zh 的旧计数相同：
// 新计数 couli_service_fee_missing_total 对拼多多与淘宝都计（标签是平台本身）；旧计数
// couli_pdd_service_fee_missing_total 与 pdd_service_fee_missing 日志只有拼多多（双写，[AC-B1-04zz#21] 不变）。
// 有服务费、带了 est、库里原本没有 est、或平台不扣服务费（京东）都不计。
import { expect, it } from 'vitest';
import {
  serviceFeeMissingCounts,
  type ServiceFeeMissingCheck,
} from '../../../../apps/api/src/modules/orders/domain/platform-rules/service-fee-alert.ts';

/** 报文里「缺」的两种写法：字段为 null，或字段不在。 */
const ABSENT = [null, undefined] as const;

it('[AC-B1-08zy#4][BR-CALC-03] 拼多多已有 est、后续服务费与 est 都缺：新计数记在 pdd 名下，旧的 pdd 计数照记', () => {
  for (const fee of ABSENT) {
    for (const est of ABSENT) {
      const check: ServiceFeeMissingCheck = {
        platform: 'pdd',
        incomingServiceFeeFen: fee,
        incomingEstCommissionFen: est,
        currentEstCommissionFen: 900n,
      };
      expect(serviceFeeMissingCounts(check), `fee ${fee} est ${est}`).toEqual({
        metricPlatform: 'pdd',
        legacyPdd: true,
      });
    }
  }
});

it('[AC-B1-08zy#5][BR-CALC-03] 淘宝已有 est、后续服务费与 est 都缺：新计数记在 taobao 名下，旧的 pdd 计数不记（[AC-B1-04zz#21] 不变）', () => {
  for (const fee of ABSENT) {
    for (const est of ABSENT) {
      const check: ServiceFeeMissingCheck = {
        platform: 'taobao',
        incomingServiceFeeFen: fee,
        incomingEstCommissionFen: est,
        currentEstCommissionFen: 900n,
      };
      expect(serviceFeeMissingCounts(check), `fee ${fee} est ${est}`).toEqual({
        metricPlatform: 'taobao',
        legacyPdd: false,
      });
    }
  }
});

it('[AC-B1-08zy#6][BR-CALC-03] 不计数：有服务费、带了 est、库里原本没有 est（新单缺费走待处理，不在本单）、京东（不扣服务费）', () => {
  const missing = {
    incomingServiceFeeFen: null,
    incomingEstCommissionFen: null,
    currentEstCommissionFen: 900n,
  } as const;
  const cases: readonly { readonly label: string; readonly check: ServiceFeeMissingCheck }[] = [
    ...(['pdd', 'taobao'] as const).flatMap((platform) => [
      {
        label: `${platform} 有服务费、无 est`,
        check: { ...missing, platform, incomingServiceFeeFen: 120n },
      },
      {
        label: `${platform} 服务费为 0、无 est`,
        check: { ...missing, platform, incomingServiceFeeFen: 0n },
      },
      {
        label: `${platform} 有服务费也有 est`,
        check: {
          ...missing,
          platform,
          incomingServiceFeeFen: 120n,
          incomingEstCommissionFen: 1080n,
        },
      },
      {
        label: `${platform} 缺服务费但带了 est`,
        check: { ...missing, platform, incomingEstCommissionFen: 1080n },
      },
      {
        label: `${platform} 库里原本没有 est`,
        check: { ...missing, platform, currentEstCommissionFen: null },
      },
      {
        label: `${platform} 库里原本没有 est，字段不在`,
        check: {
          platform,
          incomingServiceFeeFen: undefined,
          incomingEstCommissionFen: undefined,
          currentEstCommissionFen: null,
        },
      },
    ]),
    { label: 'jd 服务费与 est 都缺', check: { ...missing, platform: 'jd' } },
    {
      label: 'jd 字段都不在',
      check: {
        platform: 'jd',
        incomingServiceFeeFen: undefined,
        incomingEstCommissionFen: undefined,
        currentEstCommissionFen: 900n,
      },
    },
  ];
  for (const { label, check } of cases) {
    expect(serviceFeeMissingCounts(check), label).toEqual({
      metricPlatform: null,
      legacyPdd: false,
    });
  }
});
