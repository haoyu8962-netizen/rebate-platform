// B2-09l per-withdrawal rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreatePayoutBatch, 08 BR-WDR-12 ②, BR-WDR-05; payout-execute.ts — an id that does not pass stays as
// it is and is listed in `left` with its reason, the others of the same batch run: not_approved (not
// APPROVED, unknown, another app's, not a UUID: a non-UUID never reaches the database, so never a 5xx),
// member_blocked (blocked_reason; an effective hold; available < 0; risk frozen, banned or appealing),
// has_transfer_attempt (any result of a kind=transfer attempt), channel_disabled (enabled off or paused
// on). Requests go through the real admin entry (batch-harness.ts). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  AMOUNT,
  PLENTY,
  adjust,
  ago,
  approved,
  asPaying,
  changes,
  expectExecuted,
  fixture,
  item,
  itemsOf,
  orderedItems,
  otherApp,
  payee,
  payoutJobs,
  pending,
  rowOf,
  seedAppeal,
  seedHold,
  seedReview,
  seedRisk,
  seedRiskState,
  seedSent,
  seedW,
  setSwitch,
  suite,
  transferJob,
  withBatchAdmin,
} from './batch-harness.ts';

const s = suite();

it('[AC-B2-09l#10] not_approved：PENDING、PAYING、PAID_API、REJECTED 各一，都不动；同批可打的照常 PAYING；已存在的单在本批记 skipped', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const waitingReview = await pending(f, h, who);
    const paying = await seedReview(f, h, who, { status: 'PAYING', execute_seq: 1 });
    const paid = await seedReview(f, h, who, { status: 'PAID_API' });
    const rejected = await seedReview(f, h, who, { status: 'REJECTED' });
    const free = await approved(f, h, who);
    await seedW(f, { fen: PLENTY });
    const others = [waitingReview, paying, paid, rejected];

    const batchId = await expectExecuted(
      await h.execute([...others.map((row) => row.id), free.id]),
      {
        paying: [free.id],
        left: others.map((row) => [row.id, 'not_approved']),
      },
    );

    for (const row of others) expect(await rowOf(f, row)).toEqual(row);
    expect(await rowOf(f, free)).toEqual(asPaying(f, free, batchId, h.executor.id));
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        ...others.map((row) => item(batchId, row, 'skipped', 'not_approved')),
        item(batchId, free, 'paying'),
      ]),
    );
    expect(await payoutJobs(f)).toEqual([transferJob(f, free, 1)]);
    expect(await changes(f.db, f.appId)).toHaveLength(1);
  });
});

it('[AC-B2-09l#11] not_approved：未知 id、别的 app 的 id、各种非 UUID（不得 500）都列出且没有 item，同批可打的照常 PAYING；别的 app 的单不动', async () => {
  const f = fixture(s);
  const other = otherApp(f);
  await withBatchAdmin(f, async (h) => {
    const outsider = await approved(other, h, await payee(other, h));
    const free = await approved(f, h, await payee(f, h));
    await seedW(f, { fen: PLENTY });
    const strays = [
      randomUUID(),
      outsider.id,
      'not-a-uuid',
      '12345',
      'g'.repeat(36),
      '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4fc00',
      "' OR 1=1 --",
      'x'.repeat(64),
    ];

    const batchId = await expectExecuted(await h.execute([...strays, free.id]), {
      paying: [free.id],
      left: strays.map((id) => [id, 'not_approved']),
    });

    expect(await rowOf(f, free)).toMatchObject({ status: 'PAYING', batch_id: batchId });
    expect(await rowOf(other, outsider)).toEqual(outsider);
    expect(await itemsOf(f)).toEqual([item(batchId, free, 'paying')]);
  });
});

it('[AC-B2-09l#12] 整批都是非 UUID（withdrawal_ids 只带 not-a-uuid）：不进库、不是 500，executed、paying 空、left 恰一条、有 batch_id，没有任务', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    await expectExecuted(await h.execute(['not-a-uuid']), {
      left: [['not-a-uuid', 'not_approved']],
    });
    expect(await payoutJobs(f)).toEqual([]);
    expect(await itemsOf(f)).toEqual([]);
  });
});

it('[AC-B2-09l#13] member_blocked（BR-WDR-05）：blocked_reason 非空、有效 withdraw hold、available < 0、风控 frozen、banned、appealing（申诉前 frozen / banned）各一，单留在 APPROVED 记 blocked；同批可打的照常 PAYING', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const blocked = await approved(f, h, await payee(f, h), { blocked_reason: 'NEGATIVE_BALANCE' });

    const held = await payee(f, h);
    await seedHold(f, held, { reason: 'manual', hold_until: null });
    const onHold = await approved(f, h, held);

    const heldUntil = await payee(f, h);
    await seedHold(f, heldUntil, {
      reason: 'manual',
      hold_until: new Date(f.clock.now().getTime() + 1),
    });
    const onTimedHold = await approved(f, h, heldUntil);

    const poor = await payee(f, h, AMOUNT);
    const negative = await approved(f, h, poor);
    await adjust(f, poor, -1_001n);

    const frozenMember = await payee(f, h);
    await seedRiskState(f, frozenMember, 'frozen');
    const frozen = await approved(f, h, frozenMember);

    const bannedMember = await payee(f, h);
    await seedRiskState(f, bannedMember, 'banned');
    const banned = await approved(f, h, bannedMember);

    const appealFrozen = await payee(f, h);
    await seedRisk(f, appealFrozen, 'appealing');
    await seedAppeal(f, appealFrozen, 'frozen');
    const appealingFrozen = await approved(f, h, appealFrozen);

    const appealBanned = await payee(f, h);
    await seedRisk(f, appealBanned, 'appealing');
    await seedAppeal(f, appealBanned, 'banned');
    const appealingBanned = await approved(f, h, appealBanned);

    const free = await approved(f, h, await payee(f, h));
    await seedW(f, { fen: PLENTY });
    const stopped = [
      blocked,
      onHold,
      onTimedHold,
      negative,
      frozen,
      banned,
      appealingFrozen,
      appealingBanned,
    ];

    const batchId = await expectExecuted(
      await h.execute([free.id, ...stopped.map((row) => row.id)]),
      { paying: [free.id], left: stopped.map((row) => [row.id, 'member_blocked']) },
    );

    for (const row of stopped) expect(await rowOf(f, row)).toEqual(row);
    expect(await rowOf(f, free)).toEqual(asPaying(f, free, batchId, h.executor.id));
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        ...stopped.map((row) => item(batchId, row, 'blocked', 'member_blocked')),
        item(batchId, free, 'paying'),
      ]),
    );
    expect(await payoutJobs(f)).toEqual([transferJob(f, free, 1)]);
  });
});

it('[AC-B2-09l#14] 不算阻断的都照常 PAYING：已释放的 hold、到期的 hold（hold_until 等于现在）、到期的冻结（frozen_until 等于现在）、available 恰好为 0、已有 kind=query 的尝试', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const released = await payee(f, h);
    await seedHold(f, released, { reason: 'manual', released_at: ago(f, 5) });
    const expiredHold = await payee(f, h);
    await seedHold(f, expiredHold, { reason: 'manual', hold_until: f.clock.now() });
    const thawed = await payee(f, h);
    await seedRisk(f, thawed, 'frozen', f.clock.now());
    const zero = await payee(f, h, AMOUNT);

    const rows = [
      await approved(f, h, released),
      await approved(f, h, expiredHold),
      await approved(f, h, thawed),
      await approved(f, h, zero),
    ];
    const queried = await approved(f, h, await payee(f, h));
    await seedSent(f, queried, 'query', 'unknown');
    rows.push(queried);
    await seedW(f, { fen: PLENTY });

    const ids = rows.map((row) => row.id);
    await expectExecuted(await h.execute(ids), { paying: ids });

    for (const row of rows) expect(await rowOf(f, row)).toMatchObject({ status: 'PAYING' });
  });
});

it('[AC-B2-09l#15] has_transfer_attempt：kind=transfer 的尝试 result 取 pending、success、unknown、fail 各一，单留在 APPROVED 记 blocked，不再投递；同批可打的照常 PAYING', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const tried = [
      await approved(f, h, who),
      await approved(f, h, who),
      await approved(f, h, who),
      await approved(f, h, who),
    ];
    const results = ['pending', 'success', 'unknown', 'fail'] as const;
    for (const [index, result] of results.entries()) {
      await seedSent(f, tried[index]!, 'transfer', result);
    }
    const free = await approved(f, h, who);
    await seedW(f, { fen: PLENTY });

    const batchId = await expectExecuted(
      await h.execute([...tried.map((row) => row.id), free.id]),
      { paying: [free.id], left: tried.map((row) => [row.id, 'has_transfer_attempt']) },
    );

    for (const row of tried) expect(await rowOf(f, row)).toEqual(row);
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        ...tried.map((row) => item(batchId, row, 'blocked', 'has_transfer_attempt')),
        item(batchId, free, 'paying'),
      ]),
    );
    expect(await payoutJobs(f)).toEqual([transferJob(f, free, 1)]);
  });
});

it('[AC-B2-09l#16] channel_disabled：payout.channel_enabled.<channel> 关，或 payout.channel_paused.<channel> 开；银行卡默认未开通；同批别的通道照常 PAYING', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const bankByDefault = await approved(f, h, who, { method: 'bank_card' });
    const alipay = await approved(f, h, who);
    await setSwitch(f, 'payout.channel_enabled.alipay', false);
    await setSwitch(f, 'payout.channel_enabled.wechat', true);
    const wechat = await approved(f, h, who, { method: 'wechat' });
    await seedW(f, { fen: PLENTY, channel: 'wechat' });

    const first = await expectExecuted(await h.execute([bankByDefault.id, alipay.id, wechat.id]), {
      paying: [wechat.id],
      left: [
        [bankByDefault.id, 'channel_disabled'],
        [alipay.id, 'channel_disabled'],
      ],
    });
    expect(await rowOf(f, alipay)).toEqual(alipay);
    expect(await rowOf(f, bankByDefault)).toEqual(bankByDefault);
    expect(await rowOf(f, wechat)).toEqual(asPaying(f, wechat, first, h.executor.id));

    await setSwitch(f, 'payout.channel_paused.wechat', true);
    const paused = await approved(f, h, who, { method: 'wechat' });
    await setSwitch(f, 'payout.channel_enabled.alipay', true);
    await seedW(f, { fen: PLENTY });
    await expectExecuted(await h.execute([paused.id, alipay.id]), {
      paying: [alipay.id],
      left: [[paused.id, 'channel_disabled']],
    });
    expect(await rowOf(f, paused)).toEqual(paused);
    expect(await rowOf(f, alipay)).toMatchObject({ status: 'PAYING' });
  });
});

it('[AC-B2-09l#17] 一批混着每种原因（BR-WDR-12 例）：每单都有结果，判定按单不互相影响；只有能打的进 PAYING、只有它有任务和事件', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const free = await approved(f, h, who);
    const secondFree = await approved(f, h, who);
    const notApproved = await pending(f, h, who);
    const frozenMember = await payee(f, h);
    await seedRiskState(f, frozenMember, 'frozen');
    const blocked = await approved(f, h, frozenMember);
    const tried = await approved(f, h, who);
    await seedSent(f, tried, 'transfer', 'fail');
    const closed = await approved(f, h, who, { method: 'bank_card' });
    const unknown = randomUUID();
    await seedW(f, { fen: PLENTY });

    await expectExecuted(
      await h.execute([
        notApproved.id,
        free.id,
        blocked.id,
        tried.id,
        secondFree.id,
        closed.id,
        unknown,
        'not-a-uuid',
      ]),
      {
        paying: [free.id, secondFree.id],
        left: [
          [notApproved.id, 'not_approved'],
          [blocked.id, 'member_blocked'],
          [tried.id, 'has_transfer_attempt'],
          [closed.id, 'channel_disabled'],
          [unknown, 'not_approved'],
          ['not-a-uuid', 'not_approved'],
        ],
      },
    );

    expect((await payoutJobs(f)).map((job) => job.singleton_key).sort()).toEqual(
      [`${free.id}:1`, `${secondFree.id}:1`].sort(),
    );
    expect((await changes(f.db, f.appId)).map((data) => data['withdrawal_id']).sort()).toEqual(
      [free.id, secondFree.id].sort(),
    );
  });
});
