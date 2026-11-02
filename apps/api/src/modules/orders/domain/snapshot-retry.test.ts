// B1-08t 源码旁单元测试（实现者写）：补偿重试的纯判定。规则测试在 test/spec/orders/snapshot-retry/**。
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  isScanSkipCertain,
  isSnapshotRetryDue,
  isSnapshotRetryExhausted,
  isSnapshotRetryReason,
  planSnapshotRetry,
  resolveRetryPaidAt,
  type PlanSnapshotRetryInput,
  type ScanSkipOrder,
} from './snapshot-retry.ts';

const clock = new FixedClock('2026-10-18T12:00:00.000Z');
const at = (iso: string) => new FixedClock(iso).now();

function input(patch: Partial<PlanSnapshotRetryInput> = {}): PlanSnapshotRetryInput {
  return {
    order: {
      app_id: 'app-a',
      order_id: 'order-1',
      platform: 'jd',
      buy_type: 'share',
      activity_type: null,
      est_commission_fen: 789n,
      settle_commission_fen: null,
      subsidy_commission_fen: null,
    },
    ownerUserId: 'user-1',
    paid: { paidAt: at('2026-10-17T10:00:00.000Z'), paidAtSource: 'platform', writeSource: false },
    serviceFeeFen: 'unknown',
    pidScene: 'unknown',
    ...patch,
  };
}

it('[AC-B1-08t#U1] 重试对象只认三种快照类原因；到期与 24 小时边界含等号', () => {
  expect(
    ['RULE_VERSION_PLATFORM_MISSING', 'AMOUNT_PARSE_FAILED', 'SERVICE_FEE_RATE_MISSING'].every(
      isSnapshotRetryReason,
    ),
  ).toBe(true);
  expect(isSnapshotRetryReason('TLJ_FACE_VALUE_UNMATCHED')).toBe(false);
  expect(isSnapshotRetryReason('NO_RECEIVED_AT')).toBe(false);
  const now = clock.now();
  expect(isSnapshotRetryDue(at('2026-10-18T11:00:00.000Z'), now)).toBe(true);
  expect(isSnapshotRetryDue(at('2026-10-18T11:00:00.001Z'), now)).toBe(false);
  expect(isSnapshotRetryExhausted(at('2026-10-17T12:00:00.000Z'), now)).toBe(true);
  expect(isSnapshotRetryExhausted(at('2026-10-17T12:00:00.001Z'), now)).toBe(false);
});

it('[AC-B1-08t#U2] 佣金基数结算优先、两者都空 pending；拼多多 N 为空且没有服务费进 SERVICE_FEE_RATE_MISSING，N 已知不看服务费', () => {
  expect(planSnapshotRetry(input())).toMatchObject({ kind: 'call', input: { nBaseFen: 789n } });
  const settled = input({
    order: { ...input().order, settle_commission_fen: 0n },
  });
  expect(planSnapshotRetry(settled)).toMatchObject({ kind: 'call', input: { nBaseFen: 0n } });
  const empty = input({ order: { ...input().order, est_commission_fen: null } });
  expect(planSnapshotRetry(empty)).toEqual({ kind: 'pending', reason: 'AMOUNT_PARSE_FAILED' });
  const pdd = { ...input().order, platform: 'pdd' as const };
  const noEst = { ...pdd, est_commission_fen: null };
  expect(planSnapshotRetry(input({ order: pdd }))).toMatchObject({
    kind: 'call',
    input: { nBaseFen: 789n },
  });
  expect(planSnapshotRetry(input({ order: noEst }))).toEqual({
    kind: 'pending',
    reason: 'SERVICE_FEE_RATE_MISSING',
  });
  expect(planSnapshotRetry(input({ order: noEst, serviceFeeFen: null }))).toEqual({
    kind: 'pending',
    reason: 'SERVICE_FEE_RATE_MISSING',
  });
  expect(planSnapshotRetry(input({ order: pdd, serviceFeeFen: 31n }))).toMatchObject({
    kind: 'call',
    input: { nBaseFen: 789n },
  });
});

it('[AC-B1-08t#U3] paidAt 按库内来源恢复；platform_modified 与缺值 skip；淘宝场景未知 skip', () => {
  const now = clock.now();
  const paidAt = at('2026-10-17T10:00:00.000Z');
  const first = at('2026-10-17T09:00:00.000Z');
  const base = { paidAt, depositPaidAt: null, firstPaidAt: first, now };
  expect(resolveRetryPaidAt({ ...base, paidAtSource: 'platform' })).toEqual({
    paidAt,
    paidAtSource: 'platform',
    writeSource: false,
  });
  expect(resolveRetryPaidAt({ ...base, paidAtSource: 'observed' })).toEqual({
    paidAt: first,
    paidAtSource: 'observed',
    writeSource: false,
  });
  expect(resolveRetryPaidAt({ ...base, paidAtSource: 'platform_modified' })).toBeNull();
  expect(resolveRetryPaidAt({ ...base, paidAtSource: 'observed', firstPaidAt: null })).toBeNull();
  expect(
    resolveRetryPaidAt({ ...base, paidAtSource: null, depositPaidAt: paidAt, firstPaidAt: null }),
  ).toEqual({ paidAt: now, paidAtSource: 'observed', writeSource: true });
  expect(planSnapshotRetry(input({ paid: null }))).toEqual({
    kind: 'skip',
    reason: 'paid_at_unknown',
  });
  const taobao = { ...input().order, platform: 'taobao' as const };
  expect(planSnapshotRetry(input({ order: taobao }))).toEqual({
    kind: 'skip',
    reason: 'pid_scene_unknown',
  });
  expect(planSnapshotRetry(input({ order: taobao, pidScene: 'taolijin' }))).toMatchObject({
    kind: 'call',
    input: { rebateMode: 'none', tljRedpacketFen: null, tljDeductFen: 0n },
  });
  expect(planSnapshotRetry(input({ pidScene: null }))).toMatchObject({
    kind: 'call',
    input: {
      rebateMode: null,
      tljRedpacketFen: 0n,
      subsidyCommissionFen: 0n,
      ownerUserId: 'user-1',
    },
  });
});

// —— B1-08v：扫描读订单服务费列；必然 skip 的单排在候选末尾 ——

it('[AC-B1-08v#U1] 拼多多 N 不看传入的服务费（est 已是净额，结算优先，大整数不丢精度）；有值、0、未知都一样', () => {
  const pdd = { ...input().order, platform: 'pdd' as const };
  expect(planSnapshotRetry(input({ order: pdd, serviceFeeFen: 47n }))).toMatchObject({
    kind: 'call',
    input: { nBaseFen: 789n },
  });
  expect(
    planSnapshotRetry(
      input({ order: { ...pdd, settle_commission_fen: 901n }, serviceFeeFen: 31n }),
    ),
  ).toMatchObject({ kind: 'call', input: { nBaseFen: 901n } });
  expect(planSnapshotRetry(input({ order: pdd, serviceFeeFen: 0n }))).toMatchObject({
    kind: 'call',
    input: { nBaseFen: 789n },
  });
  expect(
    planSnapshotRetry(
      input({
        order: { ...pdd, settle_commission_fen: 9_007_199_254_741_782n },
        serviceFeeFen: 9_007_199_254_740_993n,
      }),
    ),
  ).toMatchObject({ kind: 'call', input: { nBaseFen: 9_007_199_254_741_782n } });
  expect(planSnapshotRetry(input({ order: pdd, serviceFeeFen: 'unknown' }))).toMatchObject({
    kind: 'call',
    input: { nBaseFen: 789n },
  });
});

it('[AC-B1-08v#U2] isScanSkipCertain 与扫描路径的 planSnapshotRetry 逐格一致（observed 按历史可恢复）', () => {
  const now = clock.now();
  const paidAt = at('2026-10-17T10:00:00.000Z');
  let cases = 0;
  for (const platform of ['jd', 'pdd', 'taobao'] as const)
    for (const fee of [null, 31n])
      for (const source of [null, 'platform', 'observed', 'platform_modified', 'unknown-source'])
        for (const paid of [paidAt, null])
          for (const est of [789n, null])
            for (const settle of [null, 0n]) {
              const order: ScanSkipOrder = {
                platform,
                est_commission_fen: est,
                settle_commission_fen: settle,
                service_fee_fen: fee,
                paid_at_source: source,
                paid_at: paid,
              };
              const plan = planSnapshotRetry(
                input({
                  order: {
                    ...input().order,
                    platform,
                    est_commission_fen: est,
                    settle_commission_fen: settle,
                  },
                  paid: resolveRetryPaidAt({
                    paidAtSource: source,
                    paidAt: paid,
                    depositPaidAt: null,
                    firstPaidAt: at('2026-10-17T09:00:00.000Z'),
                    now,
                  }),
                  serviceFeeFen: fee ?? 'unknown',
                  pidScene: 'unknown',
                }),
              );
              // 消息参数会先求值：bigint 须经 replacer 转字符串，否则 JSON.stringify 直接抛 TypeError。
              const label = JSON.stringify(order, (_key, value: unknown) =>
                typeof value === 'bigint' ? `${value}n` : value,
              );
              expect(isScanSkipCertain(order), label).toBe(plan.kind === 'skip');
              cases++;
            }
  expect(cases).toBe(240);
});

it('[AC-B1-08v#U3] 必然 skip 的两类：platform_modified、淘宝；拼多多服务费为空不再算；佣金都空时是 pending 不算', () => {
  const base: ScanSkipOrder = {
    platform: 'jd',
    est_commission_fen: 789n,
    settle_commission_fen: null,
    service_fee_fen: null,
    paid_at_source: 'platform',
    paid_at: at('2026-10-17T10:00:00.000Z'),
  };
  expect(isScanSkipCertain(base)).toBe(false);
  expect(isScanSkipCertain({ ...base, platform: 'pdd' })).toBe(false);
  expect(isScanSkipCertain({ ...base, platform: 'pdd', service_fee_fen: 31n })).toBe(false);
  expect(isScanSkipCertain({ ...base, platform: 'pdd', service_fee_fen: 0n })).toBe(false);
  expect(isScanSkipCertain({ ...base, paid_at_source: 'platform_modified' })).toBe(true);
  expect(isScanSkipCertain({ ...base, platform: 'taobao' })).toBe(true);
  expect(isScanSkipCertain({ ...base, platform: 'pdd', est_commission_fen: null })).toBe(false);
});
