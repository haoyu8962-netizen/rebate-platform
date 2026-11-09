// B2-04zzs 源码旁单元测试：维权全额 / 整单退款的订单原因码（纯函数）与 REFUND 子原因的显式取值。
import { expect, it } from 'vitest';
import { loadReasonSubMap } from '../../../orders/index.ts';
import { reasonSubWithReason, type ReasonSubMaps, type ReasonSubRow } from './reason-sub.ts';
import {
  WHOLE_REFUND_REASON,
  answeredRightsReasonOf,
  remainingQuantityZero,
  rightsReasonOf,
} from './rights-reason.ts';

const RECEIVED = new Date('2032-06-20T10:00:00+08:00');
const RIGHTS_AT = new Date('2032-07-20T09:00:00+08:00');
const EARNING = new Date('2032-07-01T10:00:00+08:00');

it('[AC-B2-04zzs-UNIT#1] 淘宝带联盟时点：earning_time 有值 → REFUND / AFTER_SETTLE；earning_time 与收货时间都空 → REFUND 不带子原因；维权早于收货 → REFUND / IN_SALE；收货后结算前 → RIGHTS', () => {
  const base = { platform: 'taobao', receivedAt: RECEIVED, occurredAt: RIGHTS_AT };
  expect(rightsReasonOf({ ...base, timing: { earningAt: EARNING } })).toEqual({
    reason: 'REFUND',
    refundSub: 'AFTER_SETTLE',
  });
  expect(rightsReasonOf({ ...base, receivedAt: null, timing: { earningAt: null } })).toEqual({
    reason: 'REFUND',
    refundSub: null,
  });
  expect(rightsReasonOf({ ...base, receivedAt: null, timing: { earningAt: EARNING } })).toEqual({
    reason: 'REFUND',
    refundSub: 'AFTER_SETTLE',
  });
  expect(
    rightsReasonOf({
      ...base,
      receivedAt: new Date('2032-07-21T00:00:00+08:00'),
      timing: { earningAt: null },
    }),
  ).toEqual({ reason: 'REFUND', refundSub: 'IN_SALE' });
  expect(rightsReasonOf({ ...base, timing: { earningAt: null } })).toEqual({ reason: 'RIGHTS' });
});

it('[AC-B2-04zzs-UNIT#2] 没有联盟时点或非淘宝 → RIGHTS；等待中的维权被 0 回应：淘宝 REFUND / AFTER_SETTLE、其他平台 RIGHTS', () => {
  expect(rightsReasonOf({ platform: 'taobao', receivedAt: null, occurredAt: RIGHTS_AT })).toEqual({
    reason: 'RIGHTS',
  });
  expect(
    rightsReasonOf({
      platform: 'jd',
      receivedAt: null,
      occurredAt: RIGHTS_AT,
      timing: { earningAt: EARNING },
    }),
  ).toEqual({ reason: 'RIGHTS' });
  expect(answeredRightsReasonOf('taobao')).toEqual({ reason: 'REFUND', refundSub: 'AFTER_SETTLE' });
  expect(answeredRightsReasonOf('jd')).toEqual({ reason: 'RIGHTS' });
  expect(answeredRightsReasonOf('pdd')).toEqual({ reason: 'RIGHTS' });
});

it('[AC-B2-04zzs-UNIT#3] 剩余数量为 0：两列已知、件数为正且已退 ≥ 件数；整单退款 REFUND 不带子原因', () => {
  expect(remainingQuantityZero({ quantity: 2, refunded_quantity: 2 })).toBe(true);
  expect(remainingQuantityZero({ quantity: 2, refunded_quantity: 3 })).toBe(true);
  expect(remainingQuantityZero({ quantity: 2, refunded_quantity: 1 })).toBe(false);
  expect(remainingQuantityZero({ quantity: null, refunded_quantity: 2 })).toBe(false);
  expect(remainingQuantityZero({ quantity: 2, refunded_quantity: null })).toBe(false);
  expect(remainingQuantityZero({ quantity: 0, refunded_quantity: 0 })).toBe(false);
  expect(WHOLE_REFUND_REASON).toEqual({ reason: 'REFUND', refundSub: null });
});

const TABLE = loadReasonSubMap(
  'taobao',
  'violation_type,reason_sub,source,verified,note\n合成违规-甲,FAKE_TRADE,doc,false,合成\n',
);
const maps: ReasonSubMaps = (platform) => (platform === 'taobao' ? TABLE : null);
function row(patch: Partial<ReasonSubRow> = {}): ReasonSubRow {
  return { platform: 'taobao', reason: null, reason_sub: null, reason_sub_manual: false, ...patch };
}

it('[AC-B2-04zzs-UNIT#4] REFUND 的显式子原因优先于平台状态（null 也算）；人工选过的不被覆盖；非淘宝仍为 null', () => {
  expect(
    reasonSubWithReason(
      row(),
      'REFUND',
      { refundSub: 'IN_SALE', fromPlatformStatus: 'SETTLED' },
      maps,
    ),
  ).toEqual({ write: true, value: 'IN_SALE', unmapped: null });
  expect(
    reasonSubWithReason(
      row({ reason_sub: 'AFTER_SALE' }),
      'REFUND',
      { refundSub: null, fromPlatformStatus: 'SETTLED' },
      maps,
    ),
  ).toEqual({ write: true, value: null, unmapped: null });
  expect(
    reasonSubWithReason(
      row({ reason_sub: 'AFTER_SALE', reason_sub_manual: true }),
      'REFUND',
      { refundSub: 'AFTER_SETTLE' },
      maps,
    ),
  ).toEqual({ write: false });
  expect(
    reasonSubWithReason(row({ platform: 'jd' }), 'REFUND', { refundSub: 'AFTER_SETTLE' }, maps),
  ).toEqual({ write: false });
});
