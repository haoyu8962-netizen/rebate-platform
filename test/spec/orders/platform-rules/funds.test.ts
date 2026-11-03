// B1-08za: the two funds-relevant keys, pinned in detail per platform (positive and negative cases):
// serviceFeeDeducted (BR-CALC-03, B1-08k / B1-08t / B1-08v) and taolijinPidScene (BR-CALC-19,
// B1-08t). Each test reads the table first, then pins the planners' behaviour before the refactor.
import { expect, it } from 'vitest';
import {
  planCommissionSnapshot,
  type PlanCommissionSnapshotInput,
} from '../../../../apps/api/src/modules/orders/domain/commission-snapshot.ts';
import {
  isScanSkipCertain,
  planSnapshotRetry,
  type PlanSnapshotRetryInput,
  type SnapshotRetryPaid,
} from '../../../../apps/api/src/modules/orders/domain/snapshot-retry.ts';
import { PINNED, REGISTERED_PLATFORMS, rulesOf } from './kit.ts';

type PlatformCode = PlanCommissionSnapshotInput['order']['platform'];

const PAID = new Date('2026-10-12T02:03:04Z');
const NOW = new Date('2026-10-19T05:06:07Z');
const PAID_PLATFORM: SnapshotRetryPaid = {
  paidAt: PAID,
  paidAtSource: 'platform',
  writeSource: false,
};
/** Contract PlatformCode values that are not registered platforms (no table entry). */
const UNREGISTERED: readonly PlatformCode[] = ['meituan', 'vip', 'douyin'];

interface Amounts {
  readonly est: bigint | null;
  readonly settle: bigint | null;
}

function snapshotInput(
  platform: PlatformCode,
  patch: Partial<Amounts & { fee: bigint | null; pidScene: string | null }> = {},
): PlanCommissionSnapshotInput {
  const o = { est: 1000n, settle: null, fee: 150n, pidScene: null, ...patch };
  return {
    before: null,
    after: { user_id: 'owner-1', platform_status: 'PAID', rebate_status_before: 'UNATTRIBUTED' },
    order: {
      app_id: 'app-1',
      order_id: 'order-1',
      platform,
      buy_type: 'self',
      activity_type: null,
      is_presale: false,
      paid_at: PAID,
      deposit_paid_at: null,
      est_commission_fen: o.est,
      settle_commission_fen: o.settle,
      subsidy_commission_fen: null,
    },
    incoming: { modified_at: null, service_fee_fen: o.fee },
    pidScene: o.pidScene,
    movedToPaidNow: true,
    firstPaidAt: null,
    now: NOW,
  };
}

function retryInput(
  platform: PlatformCode,
  patch: Partial<
    Amounts & {
      fee: bigint | null | 'unknown';
      pidScene: string | null | 'unknown';
      paid: SnapshotRetryPaid | null;
    }
  > = {},
): PlanSnapshotRetryInput {
  const o = { est: 1000n, settle: null, fee: 150n, pidScene: null, paid: PAID_PLATFORM, ...patch };
  return {
    order: {
      app_id: 'app-1',
      order_id: 'order-1',
      platform,
      buy_type: 'self',
      activity_type: null,
      est_commission_fen: o.est,
      settle_commission_fen: o.settle,
      subsidy_commission_fen: null,
    },
    ownerUserId: 'owner-1',
    paid: o.paid,
    serviceFeeFen: o.fee,
    pidScene: o.pidScene,
  };
}

/** The commission snapshot call both planners build for these inputs. */
function called(platform: PlatformCode, nBaseFen: bigint, taolijin = false) {
  return {
    kind: 'call',
    input: {
      appId: 'app-1',
      orderId: 'order-1',
      platform,
      paidAt: PAID,
      paidAtSource: 'platform',
      orderType: 'self',
      activityType: null,
      rebateMode: taolijin ? 'none' : null,
      nBaseFen,
      subsidyCommissionFen: 0n,
      tljDeductFen: 0n,
      tljRedpacketFen: taolijin ? null : 0n,
      ownerUserId: 'owner-1',
    },
  };
}

it('[AC-B1-08za#11] 服务费与基数（首次快照）：N 一律是 settle ?? est，不再减服务费；拼多多与淘宝在 est 为空且缺服务费时进 SERVICE_FEE_RATE_MISSING；京东缺失也照常生成', () => {
  for (const platform of REGISTERED_PLATFORMS) {
    const rules = rulesOf(platform);
    const deduct = platform !== 'jd';
    expect(rules.serviceFeeDeducted, platform).toBe(deduct);
    const plan = (patch: Parameters<typeof snapshotInput>[1]) =>
      planCommissionSnapshot(snapshotInput(platform, patch));
    expect(plan({ fee: 150n }), platform).toEqual(called(platform, 1000n));
    expect(plan({ fee: 0n }), platform).toEqual(called(platform, 1000n));
    expect(plan({ fee: 1200n }), platform).toEqual(called(platform, 1000n));
    expect(plan({ fee: 150n, settle: 2000n }), platform).toEqual(called(platform, 2000n));
    expect(plan({ fee: 150n, settle: -51n }), platform).toEqual(called(platform, -51n));
    expect(plan({ fee: null }), platform).toEqual(called(platform, 1000n));
    expect(plan({ fee: null, est: null }), platform).toEqual({
      kind: 'pending',
      reason: deduct ? 'SERVICE_FEE_RATE_MISSING' : 'AMOUNT_PARSE_FAILED',
    });
    // The fee is there, so a missing amount is AMOUNT_PARSE_FAILED everywhere.
    expect(plan({ fee: 150n, est: null }), platform).toEqual({
      kind: 'pending',
      reason: 'AMOUNT_PARSE_FAILED',
    });
  }
  expect(REGISTERED_PLATFORMS.filter((p) => rulesOf(p).serviceFeeDeducted).sort()).toEqual([
    'pdd',
    'taobao',
  ]);
});

it('[AC-B1-08za#12] 服务费与基数（补偿重试）：N 已知时服务费有值、没给、unknown 都调端口，N = settle ?? est；拼多多与淘宝 N 为空且 unknown 或没给时进 SERVICE_FEE_RATE_MISSING', () => {
  for (const platform of REGISTERED_PLATFORMS) {
    const rules = rulesOf(platform);
    const deduct = platform !== 'jd';
    expect(rules.serviceFeeDeducted, platform).toBe(deduct);
    const plan = (patch: Parameters<typeof retryInput>[1]) =>
      planSnapshotRetry(retryInput(platform, patch));
    expect(plan({ fee: 150n }), platform).toEqual(called(platform, 1000n));
    expect(plan({ fee: 0n }), platform).toEqual(called(platform, 1000n));
    expect(plan({ fee: 150n, settle: 2000n }), platform).toEqual(called(platform, 2000n));
    expect(plan({ fee: null }), platform).toEqual(called(platform, 1000n));
    expect(plan({ fee: 'unknown', pidScene: null }), platform).toEqual(called(platform, 1000n));
    const missing = {
      kind: 'pending',
      reason: deduct ? 'SERVICE_FEE_RATE_MISSING' : 'AMOUNT_PARSE_FAILED',
    };
    expect(plan({ fee: null, est: null }), platform).toEqual(missing);
    expect(plan({ fee: 'unknown', est: null }), platform).toEqual(missing);
    // The fee is there, so a missing amount is AMOUNT_PARSE_FAILED everywhere.
    expect(plan({ fee: 150n, est: null }), platform).toEqual({
      kind: 'pending',
      reason: 'AMOUNT_PARSE_FAILED',
    });
  }
});

it('[AC-B1-08za#13] 扫描必然 skip：拼多多、京东都不因服务费 skip（列为空、0、有值 → false），拼多多 paidAt 不可恢复仍 true，淘宝因推广位场景恒 true；佣金基数不可得一律 false', () => {
  const scan = (platform: string, service_fee_fen: bigint | null, commission: bigint | null) =>
    isScanSkipCertain({
      platform,
      est_commission_fen: commission,
      settle_commission_fen: null,
      service_fee_fen,
      paid_at_source: 'platform',
      paid_at: PAID,
    });
  const expected: Record<(typeof REGISTERED_PLATFORMS)[number], [bigint | null, boolean][]> = {
    jd: [
      [null, false],
      [0n, false],
      [150n, false],
    ],
    pdd: [
      [null, false],
      [0n, false],
      [150n, false],
    ],
    taobao: [
      [null, true],
      [0n, true],
      [150n, true],
    ],
  };
  for (const platform of REGISTERED_PLATFORMS) {
    const rules = rulesOf(platform);
    expect(rules.serviceFeeDeducted, platform).toBe(platform !== 'jd');
    expect(rules.taolijinPidScene, platform).toBe(PINNED[platform].taolijinPidScene);
    for (const [fee, skip] of expected[platform]) {
      expect(scan(platform, fee, 1000n), `${platform} fee ${fee}`).toBe(skip);
      expect(scan(platform, fee, null), `${platform} fee ${fee} no commission`).toBe(false);
    }
  }
  for (const platform of [...UNREGISTERED, 'PDD', 'TAOBAO', '']) {
    expect(scan(platform, null, 1000n), platform).toBe(false);
  }
  // paidAt that cannot be recovered still skips for certain on pdd, whatever the fee column says.
  for (const service_fee_fen of [null, 150n]) {
    const unrecoverable = (paid_at_source: string, paid_at: Date | null) =>
      isScanSkipCertain({
        platform: 'pdd',
        est_commission_fen: 1000n,
        settle_commission_fen: null,
        service_fee_fen,
        paid_at_source,
        paid_at,
      });
    expect(unrecoverable('platform', null)).toBe(true);
    expect(unrecoverable('platform_modified', PAID)).toBe(true);
  }
});

it('[AC-B1-08za#14] 未登记的平台代码（无规则表）：不扣服务费、服务费缺失或未知不进待处理也不 skip，场景未知不 skip', () => {
  for (const platform of REGISTERED_PLATFORMS) rulesOf(platform);
  for (const platform of UNREGISTERED) {
    expect(planCommissionSnapshot(snapshotInput(platform, { fee: 150n })), platform).toEqual(
      called(platform, 1000n),
    );
    expect(planCommissionSnapshot(snapshotInput(platform, { fee: null })), platform).toEqual(
      called(platform, 1000n),
    );
    expect(planSnapshotRetry(retryInput(platform, { fee: 'unknown' })), platform).toEqual(
      called(platform, 1000n),
    );
    expect(planSnapshotRetry(retryInput(platform, { fee: null })), platform).toEqual(
      called(platform, 1000n),
    );
    expect(
      planSnapshotRetry(retryInput(platform, { fee: 150n, pidScene: 'unknown' })),
      platform,
    ).toEqual(called(platform, 1000n));
  }
});

it('[AC-B1-08za#15] 淘礼金推广位场景（补偿重试）：只有淘宝在推广位场景未知时 skip pid_scene_unknown；京东 / 拼多多按非淘礼金照常生成', () => {
  for (const platform of REGISTERED_PLATFORMS) {
    const rules = rulesOf(platform);
    const byScene = PINNED[platform].taolijinPidScene;
    expect(rules.taolijinPidScene, platform).toBe(byScene);
    expect(planSnapshotRetry(retryInput(platform, { pidScene: 'unknown' })), platform).toEqual(
      byScene ? { kind: 'skip', reason: 'pid_scene_unknown' } : called(platform, 1000n),
    );
    // Judged in order amount → paidAt → scene: an earlier outcome wins over the scene.
    expect(
      planSnapshotRetry(retryInput(platform, { pidScene: 'unknown', paid: null })),
      platform,
    ).toEqual({ kind: 'skip', reason: 'paid_at_unknown' });
    expect(
      planSnapshotRetry(retryInput(platform, { pidScene: 'unknown', est: null })),
      platform,
    ).toEqual({ kind: 'pending', reason: 'AMOUNT_PARSE_FAILED' });
    expect(
      planSnapshotRetry(retryInput(platform, { pidScene: 'unknown', fee: null })),
      platform,
    ).toEqual(byScene ? { kind: 'skip', reason: 'pid_scene_unknown' } : called(platform, 1000n));
  }
  expect(REGISTERED_PLATFORMS.filter((p) => PINNED[p].taolijinPidScene)).toEqual(['taobao']);
});

it('[AC-B1-08za#16] 淘礼金推广位场景已知时不按平台分支：任何平台推广位为 taolijin → rebate_mode none、红包记空；其余场景 → 空模式、红包 0', () => {
  const platforms: readonly PlatformCode[] = [...REGISTERED_PLATFORMS, ...UNREGISTERED];
  for (const platform of REGISTERED_PLATFORMS) {
    const rules = rulesOf(platform);
    expect(rules.taolijinPidScene, platform).toBe(PINNED[platform].taolijinPidScene);
  }
  for (const platform of platforms) {
    const fee = 0n;
    for (const pidScene of ['taolijin', 'share', 'self_buy', 'agent', 'fallback', null]) {
      const taolijin = pidScene === 'taolijin';
      expect(
        planCommissionSnapshot(snapshotInput(platform, { fee, pidScene })),
        `${platform} ${pidScene}`,
      ).toEqual(called(platform, 1000n, taolijin));
      expect(
        planSnapshotRetry(retryInput(platform, { fee, pidScene })),
        `${platform} ${pidScene}`,
      ).toEqual(called(platform, 1000n, taolijin));
    }
  }
});
