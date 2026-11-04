// B2-09n automatic batch rule tests (claude-independent, SPEC_REF 6f50a051): 08 BR-WDR-12 细则 E-28,
// BR-WDR-30, 编排裁定 D10-609 规则 1、4 与「自动批次」 — a withdrawal judged auto runs through the real
// withdrawal.created consumer (real W1, system W2 and the real createPayoutExecute, ../auto-payout/kit.ts) on
// this suite's database, then the finance side groups it through the real admin entry
// (../admin-payout-batch/batch-harness.ts). ② leaving it puts it on that kind=auto batch and the manual batch
// records moved_out there. A batch refused by ① or by a single channel's ③ has no batch row: no moved_out
// later (D10-609: E-28's case is not changed into a refused batch that builds one). The way to ② on the real
// path is payout.channel_paused.<channel>: the decision reads channel_enabled only (⑪), EXECUTE also reads
// the pause; a member block ends the decision as manual first (⑬), so the automatic member_blocked and
// has_transfer_attempt are in cas.int.test.ts on the real createPayoutExecute with the system executor.
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  PLENTY,
  approved,
  asMoved,
  batchOf,
  expectExecuted,
  fixture,
  item,
  itemsOf,
  movedOut,
  orderedItems,
  payee,
  payoutJobs,
  rowOf,
  seedW,
  setSwitch,
  suite,
  transferJob,
  withBatchAdmin,
  type ReviewFixture,
} from '../admin-payout-batch/batch-harness.ts';
import { NOW, decision, setup, type AutoFixture, type Harness } from '../auto-payout/kit.ts';

const s = suite();

/** The automatic kit on this suite's database: the admin entry reads the same rows. */
function onSuite(): Harness {
  return {
    database: { urlFor: () => '', drop: async () => undefined },
    db: s.db(),
    observer: s.db(),
  };
}

/** The review fixture of the same app, for the admin entry and its seeds. */
function adminSide(a: AutoFixture): ReviewFixture {
  return { ...fixture(s), appId: a.appId };
}

/** W1, then the real consumer with the real EXECUTE; the row as W1 left it, and no job was sent. */
async function runAutomatic(a: AutoFixture) {
  const real = a.realExecute();
  const id = await a.start(100n);
  const created = await a.row(id);
  await a.consumer({ execute: real.service }).consume(await a.event(id));
  expect(real.send).not.toHaveBeenCalled();
  return { id, created };
}

it('[AC-B2-09n#20] 自动批次 channel_disabled 留下（真实自动到账路径）：batch_id 是那个 kind=auto 批次，row_version 在系统 W2 之外再加 1，execute_blocked 照写；财务组人工批次执行：进 PAYING，auto 批次记 moved_out，blocked 保留，review_mode 仍是 auto，任务恰一个', async () => {
  const a = await setup(onSuite());
  await a.set('payout.channel_paused.alipay', true);
  const { id, created } = await runAutomatic(a);

  const batches = await a.batches();
  expect(batches).toEqual([{ id: expect.any(String), kind: 'auto', created_by: null }]);
  const autoId = batches[0]!.id;
  const left = await a.row(id);
  expect(left.auto_decision).toEqual(decision('auto', [], { execute_blocked: 'channel_disabled' }));
  expect(left).toMatchObject({
    status: 'APPROVED',
    review_mode: 'auto',
    execute_seq: 0,
    executor_id: null,
    batch_id: autoId,
    row_version: created.row_version + 2,
    updated_at: NOW,
  });

  const f = adminSide(a);
  await withBatchAdmin(f, async (h) => {
    await setSwitch(f, 'payout.channel_paused.alipay', false);
    await seedW(f, { fen: PLENTY });

    const manual = await expectExecuted(await h.execute([id]), { paying: [id] });

    expect(await a.row(id)).toMatchObject({
      status: 'PAYING',
      review_mode: 'auto',
      execute_seq: 1,
      executor_id: h.executor.id,
      batch_id: manual,
      row_version: left.row_version + 1,
    });
    expect(await batchOf(f, manual)).toMatchObject({ kind: 'manual', created_by: h.executor.id });
    expect(await batchOf(f, autoId)).toMatchObject({ kind: 'auto', created_by: null });
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(autoId, { id }, 'blocked', 'channel_disabled'),
        movedOut(autoId, { id }, manual),
        item(manual, { id }, 'paying'),
      ]),
    );
    expect(await payoutJobs(f)).toEqual([transferJob(f, { id }, 1)]);
  });
});

it('[AC-B2-09n#21] 自动批次留下后人工批次仍 channel_disabled：改挂人工批次，auto 批次记 moved_out，人工批次记 blocked，没有任务', async () => {
  const a = await setup(onSuite());
  await a.set('payout.channel_paused.alipay', true);
  const { id, created } = await runAutomatic(a);
  const autoId = (await a.batches())[0]!.id;
  expect(await a.row(id)).toMatchObject({
    batch_id: autoId,
    row_version: created.row_version + 2,
  });
  const left = await a.row(id);

  const f = adminSide(a);
  await withBatchAdmin(f, async (h) => {
    const manual = await expectExecuted(await h.execute([id]), {
      left: [[id, 'channel_disabled']],
    });

    expect(await a.row(id)).toMatchObject({
      status: 'APPROVED',
      execute_seq: 0,
      batch_id: manual,
      row_version: left.row_version + 1,
    });
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(autoId, { id }, 'blocked', 'channel_disabled'),
        movedOut(autoId, { id }, manual),
        item(manual, { id }, 'blocked', 'channel_disabled'),
      ]),
    );
    expect(await payoutJobs(f)).toEqual([]);
  });
});

it('[AC-B2-09n#22] 规则 4 单通道 ③（自动）：没有 W，整批拒绝，execute_blocked=watermark_stale，batch_id 是 null，row_version 只有系统 W2 那一次，没有批次、item；财务组人工批次执行时进 PAYING，没有 moved_out；同批 channel_disabled 的单挂上人工批次', async () => {
  const a = await setup(onSuite());
  const { id, created } = await runAutomatic(a);

  const refused = await a.row(id);
  expect(refused.auto_decision).toEqual(
    decision('auto', [], { execute_blocked: 'watermark_stale' }),
  );
  expect(refused).toMatchObject({
    status: 'APPROVED',
    batch_id: null,
    execute_seq: 0,
    row_version: created.row_version + 1,
  });
  expect(await a.batches()).toEqual([]);
  expect(await a.batchItems()).toEqual([]);

  const f = adminSide(a);
  await withBatchAdmin(f, async (h) => {
    const closed = await approved(f, h, await payee(f, h), { method: 'bank_card' });
    await seedW(f, { fen: PLENTY });

    const manual = await expectExecuted(await h.execute([id, closed.id]), {
      paying: [id],
      left: [[closed.id, 'channel_disabled']],
    });

    expect(await a.row(id)).toMatchObject({
      status: 'PAYING',
      batch_id: manual,
      row_version: refused.row_version + 1,
    });
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(manual, { id }, 'paying'),
        item(manual, closed, 'blocked', 'channel_disabled'),
      ]),
    );
    expect(await payoutJobs(f)).toEqual([transferJob(f, { id }, 1)]);
    expect(await rowOf(f, closed)).toEqual(asMoved(f, closed, manual));
  });
});

it('[AC-B2-09n#23] 规则 4 ①（自动）：payout.enabled 关，整批拒绝，execute_blocked=payout_disabled，batch_id 是 null，row_version 只有系统 W2 那一次，没有批次、item；之后人工批次 channel_disabled 留下才第一次挂上，row_version 只再加 1，没有 moved_out', async () => {
  const a = await setup(onSuite());
  await a.set('payout.enabled', false);
  const { id, created } = await runAutomatic(a);

  const refused = await a.row(id);
  expect(refused.auto_decision).toEqual(
    decision('auto', [], { execute_blocked: 'payout_disabled' }),
  );
  expect(refused).toMatchObject({
    status: 'APPROVED',
    batch_id: null,
    execute_seq: 0,
    row_version: created.row_version + 1,
  });
  expect(await a.batches()).toEqual([]);
  expect(await a.batchItems()).toEqual([]);

  const f = adminSide(a);
  await withBatchAdmin(f, async (h) => {
    await setSwitch(f, 'payout.enabled', true);
    await setSwitch(f, 'payout.channel_paused.alipay', true);

    const manual = await expectExecuted(await h.execute([id]), {
      left: [[id, 'channel_disabled']],
    });

    expect(await itemsOf(f)).toEqual([item(manual, { id }, 'blocked', 'channel_disabled')]);
    expect(await a.row(id)).toMatchObject({
      status: 'APPROVED',
      batch_id: manual,
      row_version: refused.row_version + 1,
    });
  });
});
