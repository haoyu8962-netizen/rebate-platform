// B2-04zzl confirmation rule tests, the refusals (claude-independent, SPEC_REF d5713bf4):
// contracts/openapi.yaml blacklistClawbackAdminReconDiff — order of checks: order.blacklist_clawback
// (10403 data.reason=admin_permission_denied; a super admin holds every point) → step-up totp (10003
// data.tier=totp) → body (note 1–200 characters after trimming, else 20001 [note]) → recon_diff_id
// (unknown / another app / R4 → 20001 [recon_diff_id], no 404) → status (adjusted / written_off /
// closed → 20902 resource=recon_diff) → type or ref_id's order_key part (20001 reason
// blacklist_clawback_not_supported) → the switch (20001 reason blacklist_clawback_disabled; unset is
// off) → the order no longer CREDITED (20902 resource=order, nothing written). Each adjacent pair
// is told apart by a case that violates both. Every refusal changes nothing. Requests go through the
// real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  CHANNEL,
  PERMISSION,
  SUFFIX,
  answer,
  app,
  chars,
  confirmed,
  diffConflict,
  diffNow,
  disabled,
  denied,
  everything,
  expectAdjusted,
  newKey,
  notSupported,
  noteInvalid,
  orderConflict,
  refIdOf,
  seedBlacklistDiff,
  stepUpRequired,
  suite,
  unknownDiff,
  withAdmin,
  type App,
  type DiffRow,
  type SeededOrder,
} from './kit.ts';

const s = suite();

/** A credited order and its open difference. */
async function caseOf(a: App): Promise<{ order: SeededOrder; diff: DiffRow }> {
  const order = await a.h.credited();
  return { order, diff: await seedBlacklistDiff(a, order) };
}

/** Takes the order to CLAWED_BACK by an ordinary R8, as a later reverse event would. */
async function clawOther(a: App, order: SeededOrder): Promise<void> {
  expect(
    await a.h.apply(order, { cause: 'INVALID_AFTER_SETTLE', ref: { kind: 'platform' } }),
  ).toMatchObject({ outcome: 'clawed_back', transition: 'R8' });
}

it('[AC-B2-04zzl#20] 权限：没有 order.blacklist_clawback（只有 fund.recon / fund.view、别的权限点、没有权限点）→ 10403 data.reason=admin_permission_denied，先于二次验证与请求体；不带令牌 → 10001；什么都不变；超管可以处理', async () => {
  const a = await app(s);
  const { diff } = await caseOf(a);
  await withAdmin(a, async (admin) => {
    const before = await everything(a);
    const outsiders = [
      await admin.caller([]),
      await admin.caller(['fund.recon', 'fund.view']),
      await admin.caller(['order.restore', 'payout.execute']),
    ];
    for (const caller of outsiders) {
      await denied(await admin.confirm(diff.id, {}, { caller }));
      await denied(await admin.confirm(diff.id, { note: '   ' }, { caller, stepUp: null }));
    }
    await answer(await admin.confirm(diff.id, {}, { caller: null }), 10001);
    expect(await everything(a)).toEqual(before);

    const root = await admin.caller([], { superAdmin: true });
    const data = await confirmed(await admin.confirm(diff.id, {}, { caller: root }));
    expect(data.clawed_back_fen).toBe(552);
  });
});

it('[AC-B2-04zzl#21] 二次验证（totp 档）：不带、别的账号的、短信档的令牌 → 10003 data.tier=totp，先于请求体与差错单检查；什么都不变；令牌不进请求体哈希，拿到令牌后用同一 Idempotency-Key 重放即成功', async () => {
  const a = await app(s);
  const { diff } = await caseOf(a);
  await withAdmin(a, async (admin) => {
    const before = await everything(a);
    const key = newKey();
    const colleague = await admin.caller([PERMISSION]);
    await stepUpRequired(await admin.confirm(diff.id, {}, { key, stepUp: null }));
    await stepUpRequired(
      await admin.confirm(diff.id, {}, { key, stepUp: await admin.stepUp(colleague) }),
    );
    await stepUpRequired(
      await admin.confirm(diff.id, {}, { key, stepUp: await admin.stepUp(admin.operator, 'sms') }),
    );
    await stepUpRequired(await admin.confirm(diff.id, { note: '   ' }, { stepUp: null }));
    await stepUpRequired(await admin.confirm(randomUUID(), {}, { stepUp: null }));
    expect(await everything(a)).toEqual(before);

    expect((await confirmed(await admin.confirm(diff.id, {}, { key }))).clawed_back_fen).toBe(552);
  });
});

it('[AC-B2-04zzl#22] 请求体：note 去空白后为空、超过 200 字 → 20001 data.fields=[note]，先于差错单 id；多带的键（控制台不传金额）→ 20001；什么都不变；恰好 200 字可以处理并记入 resolution.note', async () => {
  const a = await app(s);
  const { diff } = await caseOf(a);
  await withAdmin(a, async (admin) => {
    const before = await everything(a);
    for (const note of ['   ', ' \t\n ', chars(201)]) {
      await noteInvalid(await admin.confirm(diff.id, { note }));
    }
    await noteInvalid(await admin.confirm(randomUUID(), { note: '   ' }));
    await answer(await admin.confirm(diff.id, { clawed_back_fen: 999_999 }), 20001);
    expect(await everything(a)).toEqual(before);

    const note = chars(200);
    await confirmed(await admin.confirm(diff.id, { note }));
    await expectAdjusted(a, diff, { adminId: admin.operator.id, clawedBackFen: 552, note });
  });
});

it('[AC-B2-04zzl#23] 差错单不存在、别的 app 的、R4 来源、不是 uuid → 20001 data.fields=[recon_diff_id]（无 404、无 reason）；什么都不变', async () => {
  const a = await app(s);
  const other = await app(s);
  const own = await a.h.credited();
  const r4 = await seedBlacklistDiff(a, own, { dimensions: [SUFFIX], patch: { source: 'R4' } });
  const foreign = await seedBlacklistDiff(other, await other.h.credited());
  await withAdmin(a, async (admin) => {
    const before = await everything(a);
    const foreignBefore = await everything(other);
    for (const id of [randomUUID(), foreign.id, r4.id, 'not-a-uuid']) {
      await unknownDiff(await admin.confirm(id));
    }
    expect(await everything(a)).toEqual(before);
    expect(await everything(other)).toEqual(foreignBefore);
  });
});

it('[AC-B2-04zzl#24] 已结案（adjusted / written_off / closed）→ 20902 data.resource=recon_diff，先于 type 判断；差错单、订单都不动', async () => {
  const a = await app(s);
  const statuses = ['adjusted', 'written_off', 'closed'] as const;
  const seeded: DiffRow[] = [];
  for (const status of statuses) {
    const o = await a.h.credited();
    seeded.push(
      await seedBlacklistDiff(a, o, {
        patch: { status, closed_at: a.h.clock.now() },
      }),
    );
  }
  const wrongType = await seedBlacklistDiff(a, await a.h.credited(), {
    patch: { status: 'closed', closed_at: a.h.clock.now(), type: 'appeal_restore' },
  });
  await withAdmin(a, async (admin) => {
    const before = await everything(a);
    for (const diff of [...seeded, wrongType]) {
      await diffConflict(await admin.confirm(diff.id));
    }
    expect(await everything(a)).toEqual(before);
  });
});

it('[AC-B2-04zzl#25] type 不是 blacklist_after_credit、或 ref_id 的 order_key 部分对不上本 app 的订单（不存在、别的 app 的）→ 20001 data.fields=[recon_diff_id] reason=blacklist_clawback_not_supported；什么都不变', async () => {
  const a = await app(s);
  const other = await app(s);
  const own = await a.h.credited();
  const wrongType = await seedBlacklistDiff(a, own, { patch: { type: 'appeal_restore' } });
  const wrongType2 = await seedBlacklistDiff(a, await a.h.credited(), {
    patch: { type: 'estimate_changed_after_credit' },
  });
  const unknownOrder = await seedBlacklistDiff(a, own, {
    dimensions: [SUFFIX],
    patch: { ref_id: 'taobao:not-an-order#BLACKLIST#channel' },
  });
  const foreignOrder = await other.h.credited();
  const foreignRef = await seedBlacklistDiff(a, own, {
    dimensions: [SUFFIX],
    patch: { ref_id: refIdOf(foreignOrder, [CHANNEL]) },
  });
  await withAdmin(a, async (admin) => {
    const before = await everything(a);
    for (const diff of [wrongType, wrongType2, unknownOrder, foreignRef]) {
      await notSupported(await admin.confirm(diff.id));
    }
    expect(await everything(a)).toEqual(before);
  });
});

it('[AC-B2-04zzl#26] 检查顺序：开关关（配置 false），但 type 不对或 ref_id 对不上 → not_supported，不是 disabled；已结案 + 开关关 → 20902 recon_diff', async () => {
  const a = await app(s, false);
  const own = await a.h.credited();
  const wrongType = await seedBlacklistDiff(a, own, { patch: { type: 'appeal_restore' } });
  const badRef = await seedBlacklistDiff(a, own, {
    dimensions: [SUFFIX],
    patch: { ref_id: 'taobao:not-an-order#BLACKLIST#channel' },
  });
  const closed = await seedBlacklistDiff(a, own, {
    patch: { status: 'closed', closed_at: a.h.clock.now() },
  });
  await withAdmin(a, async (admin) => {
    const before = await everything(a);
    await notSupported(await admin.confirm(wrongType.id));
    await notSupported(await admin.confirm(badRef.id));
    await diffConflict(await admin.confirm(closed.id));
    expect(await everything(a)).toEqual(before);
  });
});

it('[AC-B2-04zzl#27] 开关关（配置 false、或未设置即默认关）→ 20001 reason=blacklist_clawback_disabled：什么都不写，订单仍 CREDITED，差错单不动', async () => {
  for (const value of [false, null] as const) {
    const a = await app(s, value);
    const { diff, order } = await caseOf(a);
    await withAdmin(a, async (admin) => {
      const before = await everything(a);
      await disabled(await admin.confirm(diff.id));
      expect(await everything(a), String(value)).toEqual(before);
      expect((await a.h.read(order)).rebate_status, String(value)).toBe('CREDITED');
    });
  }
});

it('[AC-B2-04zzl#28] 检查顺序：开关关且订单已非 CREDITED → disabled，不是 order 冲突（开关先于订单状态）', async () => {
  const a = await app(s, false);
  const { diff, order } = await caseOf(a);
  await clawOther(a, order);
  await withAdmin(a, async (admin) => {
    const before = await everything(a);
    await disabled(await admin.confirm(diff.id));
    expect(await everything(a)).toEqual(before);
  });
});

it('[AC-B2-04zzl#29] 订单已非 CREDITED（后来的逆向事件已把它转成 CLAWED_BACK）→ 20902 data.resource=order：什么都不写，差错单不动，由处理人走 close', async () => {
  const a = await app(s);
  const { diff, order } = await caseOf(a);
  await clawOther(a, order);
  await withAdmin(a, async (admin) => {
    const before = await everything(a);
    await orderConflict(await admin.confirm(diff.id));
    expect(await everything(a)).toEqual(before);
    expect(await diffNow(a.f, diff.id)).toEqual(diff);
  });
});

it('[AC-B2-04zzl#30] 多租户：A 的调用者处理 B 的差错单 → 20001；A 处理自己的差错单只扣回 A 的订单，B 的订单、账务、差错单都不变', async () => {
  const a = await app(s);
  const b = await app(s);
  // order_keys' primary key is (platform, sub_order_id), global: two apps cannot share an order_key.
  const inA = await a.h.credited({ subOrderId: `tenant-a-${randomUUID()}` });
  const inB = await b.h.credited({ subOrderId: `tenant-b-${randomUUID()}` });
  expect(inA.orderKey).not.toBe(inB.orderKey);
  const ownDiff = await seedBlacklistDiff(a, inA);
  const foreignDiff = await seedBlacklistDiff(b, inB);
  await withAdmin(a, async (admin) => {
    const before = await everything(b);

    // A lookup of the difference without app_id answers 200 or a reason here, never the bare 20001.
    await unknownDiff(await admin.confirm(foreignDiff.id));
    expect(await everything(b)).toEqual(before);

    expect((await confirmed(await admin.confirm(ownDiff.id))).clawed_back_fen).toBe(552);

    expect((await a.h.read(inA)).rebate_status).toBe('CLAWED_BACK');
    expect(await everything(b)).toEqual(before);
    expect((await b.h.read(inB)).rebate_status).toBe('CREDITED');
  });
});
