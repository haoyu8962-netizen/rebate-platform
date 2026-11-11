// BR-CALC-22 细则（2026-11-11，D10-1258）：试算后、发布前，样本订单只因补贴类佣金变化写了新版本
// （BR-CALC-27 细则「仅补贴变化的版本」：各方份额、base_fen 与上一版逐项相同）不算样本变化。
// 摘要的金额部分每单只看最新版本的份额行，不含版本号。纯函数，不连库；只钉「变 / 不变」，不钉摘要值。
import { expect, it } from 'vitest';
import {
  sampleDigest,
  type DigestAmount,
  type DigestSplit,
} from '../../../../apps/api/src/modules/commission/domain/rule-trial.ts';

const FROM_MS = Date.parse('2030-06-05T12:00:00+08:00');
const TO_MS = Date.parse('2030-06-12T12:00:00+08:00');

const ORDER_A = '0b6f4f0e-0000-4000-8000-00000000000a';
const ORDER_B = '0b6f4f0e-0000-4000-8000-00000000000b';
const ORDER_C = '0b6f4f0e-0000-4000-8000-00000000000c';

/** 已生成快照的样本订单（快照本身不因补贴变化改写）。 */
function split(orderId: string): DigestSplit {
  return {
    orderId,
    platform: 'taobao',
    ruleVersionId: '0b6f4f0e-0000-4000-8000-0000000000f1',
    orderType: 'self',
    activityType: null,
    rebateMode: null,
    paidAtMs: Date.parse('2030-06-08T09:30:00+08:00'),
    paidAtSource: 'platform',
    rawNFen: 1234n,
    subsidyCommissionFen: 0n,
    reserveBp: 1000,
    reserveFen: 124n,
    tljDeductFen: 0n,
    baseFen: 1110n,
    platformRetainFen: 389n,
    beneficiaries: [
      { user_id: `${orderId}-owner`, role: 'self', level: 'L1', initial_status: 'active' },
      { user_id: `${orderId}-direct`, role: 'direct', level: 'L2', initial_status: 'active' },
      { user_id: `${orderId}-indirect`, role: 'indirect', level: 'L3', initial_status: 'active' },
    ],
  };
}

interface Shares {
  readonly base: bigint;
  readonly own: bigint;
  readonly direct: bigint;
  readonly indirect: bigint;
}

const V1: Shares = { base: 1110n, own: 555n, direct: 111n, indirect: 55n };

/** 某单某个 commission_version 的三行份额。 */
function amounts(orderId: string, commissionVersion: number, s: Shares): DigestAmount[] {
  return [
    {
      orderId,
      commissionVersion,
      userId: `${orderId}-owner`,
      role: 'self',
      baseFen: s.base,
      amountFen: s.own,
    },
    {
      orderId,
      commissionVersion,
      userId: `${orderId}-direct`,
      role: 'direct',
      baseFen: s.base,
      amountFen: s.direct,
    },
    {
      orderId,
      commissionVersion,
      userId: `${orderId}-indirect`,
      role: 'indirect',
      baseFen: s.base,
      amountFen: s.indirect,
    },
  ];
}

function digest(orders: readonly string[], rows: readonly DigestAmount[]): string {
  return sampleDigest({
    fromMs: FROM_MS,
    toMs: TO_MS,
    splits: orders.map(split),
    amounts: rows,
  });
}

/** 订单 A：v1 为 V1，试算后写了份额为 s 的 v2。 */
function withV2(s: Shares): string {
  return digest([ORDER_A], [...amounts(ORDER_A, 1, V1), ...amounts(ORDER_A, 2, s)]);
}

/** 输入顺序不同的几种排列（倒序、轮转），摘要都不应受影响。 */
function orderings<T>(rows: readonly T[]): T[][] {
  const half = Math.floor(rows.length / 2);
  return [[...rows], [...rows].reverse(), [...rows.slice(half), ...rows.slice(0, half)]];
}

it('[AC-B1-18h#1] BR-CALC-22 样本单只多出各方份额逐项相同的新版本（仅补贴变化），摘要不变', () => {
  const trialTime = digest([ORDER_A], amounts(ORDER_A, 1, V1));

  // 试算后补贴变了两次：v2、v3 只是版本号 +1，份额行与 v1 逐项相同。
  const subsidyOnly = [
    ...amounts(ORDER_A, 1, V1),
    ...amounts(ORDER_A, 2, V1),
    ...amounts(ORDER_A, 3, V1),
  ];
  const oneSubsidyOnly = [...amounts(ORDER_A, 1, V1), ...amounts(ORDER_A, 2, V1)];
  expect(digest([ORDER_A], oneSubsidyOnly)).toBe(trialTime);
  for (const rows of orderings(subsidyOnly)) {
    expect(digest([ORDER_A], rows)).toBe(trialTime);
  }

  // 份额变化仍是样本变化：任一方金额或 base 不同的新版本都让摘要变。
  expect(withV2({ ...V1, own: 556n })).not.toBe(trialTime);
  expect(withV2({ ...V1, direct: 110n })).not.toBe(trialTime);
  expect(withV2({ ...V1, indirect: 54n })).not.toBe(trialTime);
  expect(withV2({ ...V1, base: 1111n })).not.toBe(trialTime);
  // 新增一张快照订单也是样本变化。
  expect(
    digest([ORDER_A, ORDER_C], [...amounts(ORDER_A, 1, V1), ...amounts(ORDER_C, 1, V1)]),
  ).not.toBe(trialTime);
});

it('[AC-B1-18h#2] BR-CALC-22 各单分别取自己的最新版本：仅补贴变化的单不改变、也不掩盖别的单的份额变化', () => {
  const orders = [ORDER_A, ORDER_B];
  const trialTime = digest(orders, [...amounts(ORDER_A, 1, V1), ...amounts(ORDER_B, 1, V1)]);
  const changedB: Shares = { base: 1000n, own: 500n, direct: 100n, indirect: 50n };

  // 只有 B 的份额变了（B 写 v2）。
  const onlyShareChange = digest(orders, [
    ...amounts(ORDER_A, 1, V1),
    ...amounts(ORDER_B, 1, V1),
    ...amounts(ORDER_B, 2, changedB),
  ]);
  expect(onlyShareChange).not.toBe(trialTime);

  // 同时 A 只因补贴变化写了 v2、v3：与「只有 B 份额变化」的摘要相同。
  const withSubsidyOnlyA = [
    ...amounts(ORDER_A, 1, V1),
    ...amounts(ORDER_A, 2, V1),
    ...amounts(ORDER_A, 3, V1),
    ...amounts(ORDER_B, 1, V1),
    ...amounts(ORDER_B, 2, changedB),
  ];
  for (const rows of orderings(withSubsidyOnlyA)) {
    expect(digest(orders, rows)).toBe(onlyShareChange);
  }
});

it('[AC-B1-18h#3] BR-CALC-22 仅补贴变化的版本插在份额变化前后，摘要都只随份额变化', () => {
  const changed: Shares = { base: 1110n, own: 444n, direct: 111n, indirect: 55n };
  const trialTime = digest([ORDER_A], amounts(ORDER_A, 1, V1));
  // 直接一次份额变化：v1 → v2。
  const direct = withV2(changed);
  expect(direct).not.toBe(trialTime);

  // 先仅补贴变化（v2 份额同 v1），再份额变化（v3）。
  const subsidyThenShare = [
    ...amounts(ORDER_A, 1, V1),
    ...amounts(ORDER_A, 2, V1),
    ...amounts(ORDER_A, 3, changed),
  ];
  // 先份额变化（v2），再仅补贴变化（v3 份额同 v2）。
  const shareThenSubsidy = [
    ...amounts(ORDER_A, 1, V1),
    ...amounts(ORDER_A, 2, changed),
    ...amounts(ORDER_A, 3, changed),
  ];
  for (const rows of [...orderings(subsidyThenShare), ...orderings(shareThenSubsidy)]) {
    expect(digest([ORDER_A], rows)).toBe(direct);
  }
});
