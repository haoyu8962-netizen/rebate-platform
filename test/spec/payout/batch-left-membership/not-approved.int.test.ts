// B2-09n not_approved rule tests (claude-independent, SPEC_REF 6f50a051): 08 BR-WDR-11, BR-WDR-12 ②, 编排裁定
// D10-609 规则 3 — not_approved never goes onto the batch: a withdrawal out of APPROVED, one PAYING on another
// batch, another app's id, an unknown id, not a UUID. batch_id and row_version stay, the old batch has no
// moved_out. The stayer next to them in each test does go onto the batch: an implementation that writes
// every `left` fails on the first, one that writes none fails on the second. Requests go through the real
// admin entry and the real createPayoutExecute (../admin-payout-batch/batch-harness.ts). Top-level it() only
// (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  PLENTY,
  approved,
  asMoved,
  expectExecuted,
  fixture,
  heldOnBatch,
  item,
  itemsOf,
  orderedItems,
  otherApp,
  payee,
  pending,
  rowOf,
  seedReview,
  seedW,
  suite,
  withBatchAdmin,
  world,
} from '../admin-payout-batch/batch-harness.ts';

const s = suite();

it('[AC-B2-09n#13] 规则 3 状态不是 APPROVED、从没挂过批次（PENDING_REVIEW、PAYING、PAID_API、PAID_MANUAL、REJECTED、FAILED）：batch_id 仍是 null，row_version、updated_at 不变，本批记 skipped；同批 channel_disabled 的挂上本批', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const others = [
      await pending(f, h, who),
      await seedReview(f, h, who, { status: 'PAYING', execute_seq: 1 }),
      await seedReview(f, h, who, { status: 'PAID_API' }),
      await seedReview(f, h, who, { status: 'PAID_MANUAL' }),
      await seedReview(f, h, who, { status: 'REJECTED' }),
      await seedReview(f, h, who, { status: 'FAILED' }),
    ];
    const closed = await approved(f, h, who, { method: 'bank_card' });

    const batchId = await expectExecuted(
      await h.execute([...others.map((row) => row.id), closed.id]),
      {
        left: [
          ...others.map((row): [string, string] => [row.id, 'not_approved']),
          [closed.id, 'channel_disabled'],
        ],
      },
    );

    for (const row of others) {
      expect(row.batch_id).toBeNull();
      expect(await rowOf(f, row)).toEqual(row);
    }
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        ...others.map((row) => item(batchId, row, 'skipped', 'not_approved')),
        item(batchId, closed, 'blocked', 'channel_disabled'),
      ]),
    );
    expect(await rowOf(f, closed)).toEqual(asMoved(f, closed, batchId));
  });
});

it('[AC-B2-09n#14] 规则 3 已在别的批次上的 PAYING、REJECTED：batch_id 仍是原批次，row_version 不变，原批次没有 moved_out，本批记 skipped；同批 channel_disabled 的挂上本批', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const paying = await heldOnBatch(f, h, who, {
      seed: { status: 'PAYING', hold_reason: null, hold_at: null },
    });
    const old = paying.batch;
    const rejected = await seedReview(f, h, who, { status: 'REJECTED', batch_id: old.id });
    const closed = await approved(f, h, who, { method: 'bank_card' });

    const batchId = await expectExecuted(await h.execute([paying.row.id, rejected.id, closed.id]), {
      left: [
        [paying.row.id, 'not_approved'],
        [rejected.id, 'not_approved'],
        [closed.id, 'channel_disabled'],
      ],
    });

    expect(await rowOf(f, paying.row)).toEqual(paying.row);
    expect(await rowOf(f, rejected)).toEqual(rejected);
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(old.id, paying.row, 'paying'),
        item(batchId, paying.row, 'skipped', 'not_approved'),
        item(batchId, rejected, 'skipped', 'not_approved'),
        item(batchId, closed, 'blocked', 'channel_disabled'),
      ]),
    );
    expect(await rowOf(f, closed)).toEqual(asMoved(f, closed, batchId));
  });
});

it('[AC-B2-09n#15] 规则 3 别的 app 的 id、未知 id、非 UUID：别的 app 的单 batch_id、row_version 不变，那个 app 什么都没变，这些 id 都没有 item；同批 channel_disabled 的挂上本批', async () => {
  const f = fixture(s);
  const other = otherApp(f);
  await withBatchAdmin(f, async (h) => {
    const outsider = await approved(other, h, await payee(other, h));
    const closed = await approved(f, h, await payee(f, h), { method: 'bank_card' });
    const theirs = await world(other);
    const unknown = randomUUID();

    const batchId = await expectExecuted(
      await h.execute([outsider.id, unknown, 'not-a-uuid', closed.id]),
      {
        left: [
          [outsider.id, 'not_approved'],
          [unknown, 'not_approved'],
          ['not-a-uuid', 'not_approved'],
          [closed.id, 'channel_disabled'],
        ],
      },
    );

    expect(await rowOf(other, outsider)).toEqual(outsider);
    expect(await world(other)).toEqual(theirs);
    expect(await itemsOf(f)).toEqual([item(batchId, closed, 'blocked', 'channel_disabled')]);
    expect(await rowOf(f, closed)).toEqual(asMoved(f, closed, batchId));
  });
});

it('[AC-B2-09n#16] 规则 3 重复点击：已被第一批打成 PAYING 的单再组批次，batch_id 仍是第一批、row_version 不变，第一批没有 moved_out；同批 channel_disabled 的挂上第二批', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who);
    const closed = await approved(f, h, who, { method: 'bank_card' });
    await seedW(f, { fen: PLENTY });
    const first = await expectExecuted(await h.execute([w.id]), { paying: [w.id] });
    const moved = await rowOf(f, w);

    const second = await expectExecuted(await h.execute([w.id, closed.id]), {
      left: [
        [w.id, 'not_approved'],
        [closed.id, 'channel_disabled'],
      ],
    });

    expect(await rowOf(f, w)).toEqual(moved);
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(first, w, 'paying'),
        item(second, w, 'skipped', 'not_approved'),
        item(second, closed, 'blocked', 'channel_disabled'),
      ]),
    );
    expect(await rowOf(f, closed)).toEqual(asMoved(f, closed, second));
  });
});
