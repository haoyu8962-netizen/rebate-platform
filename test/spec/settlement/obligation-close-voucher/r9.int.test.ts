// B2-04zzb: R9 forfeits an unfinished obligation and references the platform voucher it wrote
// (BR-FUND-04 ⑫「迁移 R9、R10……把剩余未履约金额整笔归了平台的……义务记为没收……都关联实际履约的凭证（该
// 事务的平台凭证……；平台差额为 0、没写平台凭证的，记该事务的结算记录 seq 或 rights_event_id）」); R8 voids
// with no voucher (「订单转 CLAWED_BACK（迁移 R8）……同一事务作废该单未完成的义务」).
//
// Direct held at credit (frozen → first_credit obligation, pending 85), self 425 and indirect 42
// credited, platform 448. A rights success with the union's new commission 600 (R9, BR-FUND-08 ①):
// B 510 → 255 / 51 / 25; self −170, indirect −17; direct banned / deleted: share 51 → platform,
// obligation forfeited; platform new = 600 − 255 − 25 = 320, old 448 → DECREASE 128 (the
// `{order_key}:PLATFORM:CLAWBACK:R{id}` voucher).
// With 840: B 714 → 357 / 71 / 35; self −68, indirect −7; platform new = 840 − 357 − 35 = 448 → no
// platform voucher.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  FORFEITING,
  NOW,
  TIMEOUT,
  databaseFixture,
  failAfter,
  harness,
  obligationCasMisses,
  platformClawbackKey,
  platformDecreaseLines,
  receivable,
  updatesObligations,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

for (const [index, [state, reason]] of FORFEITING.entries()) {
  it(
    `[AC-B2-04zzb#${String(index + 1)}] 直推入账时冻结（first_credit 义务、待补记 85），之后${state}；维权成功带联盟新佣金 600 → R9：直推份额归平台、义务 forfeited / closed_by R9 / closed_ref R{id}，voucher_id = 本事务平台扣回凭证 {order_key}:PLATFORM:CLAWBACK:R{id}（平台冲回 128，同 app、同单、无受益人键）的 id；追加 forfeited 事件（${reason}）`,
    async () => {
      const h = await harness(p.db);
      const o = await h.heldThen({ direct: state });
      const before = await h.obligationOf(o, 'direct');
      expect(before).toMatchObject({ kind: 'first_credit', status: 'open', voucher_id: null });
      const events = await h.newBeneficiaryEvents(o);

      const { result, eventId } = await h.rightsR9(o, 600n);

      expect(result).toMatchObject({
        outcome: 'clawed_back',
        transition: 'R9',
        bookedBaseFen: 510n,
      });
      const key = platformClawbackKey(o, eventId);
      expect(await h.voucherLines(key)).toEqual(platformDecreaseLines(o, 128n));
      const row = await h.expectLinked(o, 'direct', {
        closedBy: 'R9',
        closedRef: eventId,
        uniqKey: key,
        kind: 'CLAWBACK',
      });
      expect(row).toMatchObject({
        beneficiary_credit_id: before.beneficiary_credit_id,
        kind: 'first_credit',
        closed_at: new Date(NOW),
      });
      expect(await h.newBeneficiaryEvents(o)).toEqual([
        ...events,
        expect.objectContaining({ user_id: o.user('direct'), status: 'forfeited', reason }),
      ]);
      expect(await h.orderSubjectNet(o, receivable(o))).toBe(600n);
    },
    TIMEOUT,
  );
}

it(
  '[AC-B2-04zzb#4] 平台差额为 0 不写平台凭证 → voucher_id 为 null，closed_ref 记该事务的 rights_event_id 兜底；同 app 另一单平台差额非 0 → voucher_id 为其平台扣回凭证：新佣金 840 时平台新净额 840 − 357 − 35 = 448 与原 448 相同（只扣本人 68、间推 7），600 时平台冲回 128',
  async () => {
    const h = await harness(p.db);
    const zero = await h.heldThen({ direct: 'banned' });
    const other = await h.heldThen({ direct: 'banned' });

    const flat = await h.rightsR9(zero, 840n);
    expect(flat.result).toMatchObject({
      outcome: 'clawed_back',
      transition: 'R9',
      bookedBaseFen: 714n,
      bookedNFen: 840n,
    });
    expect(await h.platformKeys(zero)).toEqual([`${zero.orderKey}:PLATFORM:CREDIT`]);
    expect(await h.orderSubjectNet(zero, receivable(zero))).toBe(840n);
    expect(await h.obligationOf(zero, 'direct')).toMatchObject({
      status: 'forfeited',
      closed_by: 'R9',
      closed_ref: flat.eventId,
      closed_at: new Date(NOW),
      voucher_id: null,
    });

    const moved = await h.rightsR9(other, 600n);
    expect(moved.result).toMatchObject({ outcome: 'clawed_back', transition: 'R9' });
    await h.expectLinked(other, 'direct', {
      closedBy: 'R9',
      closedRef: moved.eventId,
      uniqKey: platformClawbackKey(other, moved.eventId),
      kind: 'CLAWBACK',
    });
    // The zero-difference row stays unlinked after the other order's R9.
    expect((await h.obligationOf(zero, 'direct')).voucher_id).toBeNull();
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzb#5] 同一单直推冻结后封禁、间推冻结仍冻结：R9（600）直推义务 forfeited 并关联平台扣回凭证，间推义务保持 open、voucher_id null；之后整单失效（P7 → R8）：间推义务 voided / closed_by R8、voucher_id 仍为 null（作废不带凭证，也不关联 R8 的平台凭证），直推已关闭的义务一列不改（voucher_id 仍是 R9 的平台凭证）',
  async () => {
    const h = await harness(p.db);
    const o = await h.heldThen({ direct: 'banned', indirect: 'frozen' });
    const indirectBefore = await h.obligationOf(o, 'indirect');

    const { result, eventId } = await h.rightsR9(o, 600n);
    expect(result).toMatchObject({ outcome: 'clawed_back', transition: 'R9' });
    const forfeited = await h.expectLinked(o, 'direct', {
      closedBy: 'R9',
      closedRef: eventId,
      uniqKey: platformClawbackKey(o, eventId),
      kind: 'CLAWBACK',
    });
    expect(await h.obligationOf(o, 'indirect')).toEqual(indirectBefore);

    const { result: voided, rowVersion } = await h.sync(o, {
      event: 'PLATFORM_INVALID',
      rule: 'P7',
    });
    const r8Event = `P${String(rowVersion)}`;
    expect(voided).toMatchObject({ outcome: 'clawed_back', transition: 'R8' });
    expect(await h.platformKeys(o)).toContain(platformClawbackKey(o, r8Event));
    expect(await h.obligationOf(o, 'indirect')).toMatchObject({
      beneficiary_credit_id: indirectBefore.beneficiary_credit_id,
      status: 'voided',
      closed_by: 'R8',
      closed_ref: r8Event,
      voucher_id: null,
    });
    expect(await h.obligationOf(o, 'direct')).toEqual(forfeited);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzb#6] 重投：同一维权事件的 R9 再处理一次 → 无变化（义务已关、CAS 不再命中），已关闭行的 voucher_id / closed_* / row_version 不被改写，订单凭证不增加、平台凭证不重复',
  async () => {
    const h = await harness(p.db);
    const o = await h.heldThen({ direct: 'banned' });
    const { eventId, rightsId } = await h.rightsR9(o, 600n);
    const linked = await h.expectLinked(o, 'direct', {
      closedBy: 'R9',
      closedRef: eventId,
      uniqKey: platformClawbackKey(o, eventId),
      kind: 'CLAWBACK',
    });
    const keys = await h.orderVoucherKeys(o);
    const vouchers = await h.vouchers();

    const replayed = await h.apply(o, {
      cause: 'RIGHTS',
      ref: { kind: 'rights', orderRightsId: rightsId },
      newCommissionFen: 600n,
    });

    expect(replayed).toMatchObject({ outcome: 'no_change' });
    expect(await h.obligationOf(o, 'direct')).toEqual(linked);
    expect(await h.orderVoucherKeys(o)).toEqual(keys);
    expect(await h.vouchers()).toEqual(vouchers);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzb#7] 多租户：两个 App 各有一单同形订单（直推冻结后封禁；order_keys 与 users 不带 app_id，子订单号不同）：只对 App A 做 R9 → A 的义务关联 A 本事务的平台凭证（凭证行 app_id = A）；App B 的义务仍 open、voucher_id null，B 的全部行不变',
  async () => {
    const a = await harness(p.db);
    const b = await harness(p.db);
    expect(a.appId).not.toBe(b.appId);
    const left = await a.heldThen({ direct: 'banned' });
    const right = await b.heldThen({ direct: 'banned' });
    const untouched = await b.everything();

    const { eventId } = await a.rightsR9(left, 600n);

    const row = await a.expectLinked(left, 'direct', {
      closedBy: 'R9',
      closedRef: eventId,
      uniqKey: platformClawbackKey(left, eventId),
      kind: 'CLAWBACK',
    });
    expect(row.app_id).toBe(a.appId);
    expect(await b.everything()).toEqual(untouched);
    expect(await b.obligationOf(right, 'direct')).toMatchObject({
      status: 'open',
      closed_by: null,
      closed_ref: null,
      voucher_id: null,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzb#8] 原子：R9 事务里义务关闭语句执行后失败、或义务 CAS 未命中 → 整个事务回滚，平台扣回凭证与义务都不落（凭证键、余额、订单列、义务行、forfeited 事件都与之前相同）；之后正常重试一次 → 凭证与义务同事务落库，voucher_id = 该平台凭证',
  async () => {
    const h = await harness(p.db);
    const o = await h.heldThen({ direct: 'banned' });
    const rightsId = await h.rights(o);
    const eventId = `R${rightsId}`;
    const command = {
      cause: 'RIGHTS',
      ref: { kind: 'rights', orderRightsId: rightsId },
      newCommissionFen: 600n,
    } as const;
    const before = await h.state();

    const faulty = failAfter(p.db, updatesObligations);
    await expect(h.apply(o, command, { via: faulty.db })).rejects.toThrow();
    expect(faulty.injected()).toBeGreaterThanOrEqual(1);
    expect(await h.state()).toEqual(before);

    const missed = obligationCasMisses(p.db);
    await expect(h.apply(o, command, { via: missed.db })).rejects.toThrow();
    expect(missed.misses()).toBeGreaterThanOrEqual(1);
    expect(await h.state()).toEqual(before);
    expect(await h.obligationOf(o, 'direct')).toMatchObject({ status: 'open', voucher_id: null });

    expect(await h.apply(o, command)).toMatchObject({ outcome: 'clawed_back', transition: 'R9' });
    await h.expectLinked(o, 'direct', {
      closedBy: 'R9',
      closedRef: eventId,
      uniqKey: platformClawbackKey(o, eventId),
      kind: 'CLAWBACK',
    });
  },
  TIMEOUT,
);
