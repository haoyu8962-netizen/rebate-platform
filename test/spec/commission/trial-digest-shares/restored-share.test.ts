// BR-CALC-22 细则（2026-11-11，D10-1258）：摘要的金额部分每单只看最新版本的份额行，不含版本号。
// 份额改回某个旧值也是样本变化：不能把所有历史版本的份额行去重后再算摘要。
// 纯函数，不连库；只钉「变 / 不变」，不钉摘要值。
import { expect, it } from 'vitest';
import {
  sampleDigest,
  type DigestAmount,
  type DigestSplit,
} from '../../../../apps/api/src/modules/commission/domain/rule-trial.ts';

const FROM_MS = Date.parse('2030-06-05T12:00:00+08:00');
const TO_MS = Date.parse('2030-06-12T12:00:00+08:00');

const ORDER_A = '0b6f4f0e-0000-4000-8000-00000000006a';

/** 已生成快照的样本订单（快照本身不因份额版本改写）。 */
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

/** 某单某个 commission_version 的三行份额，本人份额为 own。 */
function amounts(orderId: string, commissionVersion: number, own: bigint): DigestAmount[] {
  return [
    {
      orderId,
      commissionVersion,
      userId: `${orderId}-owner`,
      role: 'self',
      baseFen: 1110n,
      amountFen: own,
    },
    {
      orderId,
      commissionVersion,
      userId: `${orderId}-direct`,
      role: 'direct',
      baseFen: 1110n,
      amountFen: 111n,
    },
    {
      orderId,
      commissionVersion,
      userId: `${orderId}-indirect`,
      role: 'indirect',
      baseFen: 1110n,
      amountFen: 55n,
    },
  ];
}

function digest(rows: readonly DigestAmount[]): string {
  return sampleDigest({
    fromMs: FROM_MS,
    toMs: TO_MS,
    splits: [split(ORDER_A)],
    amounts: rows,
  });
}

/** 输入顺序不同的几种排列（倒序、轮转），摘要都不应受影响。 */
function orderings<T>(rows: readonly T[]): T[][] {
  const half = Math.floor(rows.length / 2);
  return [[...rows], [...rows].reverse(), [...rows.slice(half), ...rows.slice(0, half)]];
}

it('[AC-B1-18h#6] BR-CALC-22 份额改回旧值（v1 555 → v2 444 → v3 555）也是样本变化：只比最新版本，不对历史版本份额去重', () => {
  // 试算时订单 A 已有 v1（本人 555）与 v2（本人 444），最新版本是 v2。
  const atTrial = [...amounts(ORDER_A, 1, 555n), ...amounts(ORDER_A, 2, 444n)];
  const trialTime = digest(atTrial);

  // 试算后写 v3，本人份额恢复为 555：与试算时的最新版本 v2 不同，摘要必须变。
  const restored = [...atTrial, ...amounts(ORDER_A, 3, 555n)];
  const onlyLatest555 = digest(amounts(ORDER_A, 1, 555n));
  for (const rows of orderings(restored)) {
    const after = digest(rows);
    expect(after).not.toBe(trialTime);
    // 摘要只随最新版本的份额：与只有一版、本人 555 的样本相同。
    expect(after).toBe(onlyLatest555);
  }

  // 试算时的摘要同样只看最新版本 v2：与只有一版、本人 444 的样本相同。
  for (const rows of orderings(atTrial)) {
    expect(digest(rows)).toBe(digest(amounts(ORDER_A, 1, 444n)));
  }
});
