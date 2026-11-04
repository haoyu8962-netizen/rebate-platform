// B2-09m member message rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminBatchManualPaid, 08 BR-WDR-26, BR-WDR-16 — a paid item publishes exactly one
// wallet.withdrawal_changed with status PAID_MANUAL; notification's real consumer sends WD_SUCCESS with
// the net amount; no internal note reaches the member. No transfer job. Requests go through the real
// admin entry (manual-paid-harness.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  NOTE,
  approved,
  changes,
  deliverMessage,
  entryOf,
  expectItems,
  fixture,
  messageJobs,
  paid,
  payee,
  payoutJobs,
  state,
  suite,
  textOf,
  withManualAdmin,
} from './manual-paid-harness.ts';

const s = suite();

it('[AC-B2-09m#12] 通知（BR-WDR-26）：PAID_MANUAL 的 wallet.withdrawal_changed 恰一个、只带 id 与状态，通知队列恰一条，没有转账任务；真实消费者发出 WD_SUCCESS「提现已到账：¥123.47 已转入支付宝」（净额），收件箱恰一条；消息、通知日志、事件、任务都看不到内部备注', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who, { reject_note: NOTE });

    await expectItems(await h.manualPaid([entryOf(f, w)]), [paid(w.id)]);

    const data = { withdrawal_id: w.id, user_id: who.userId, status: 'PAID_MANUAL' };
    expect(await changes(f.db, f.appId)).toEqual([data]);
    expect(await messageJobs(f)).toEqual([data]);
    expect(await payoutJobs(f)).toEqual([]);

    await deliverMessage(f, data);

    const inbox = await f.db
      .selectFrom('inbox_messages')
      .selectAll()
      .where('app_id', '=', f.appId)
      .execute();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      user_id: who.userId,
      code: 'WD_SUCCESS',
      title: '提现到账',
      body: '提现已到账：¥123.47 已转入支付宝',
    });
    const logs = await f.db
      .selectFrom('notify_logs')
      .selectAll()
      .where('app_id', '=', f.appId)
      .execute();
    expect(logs.map((log) => log.dedupe_key)).toContain(`${w.id}:PAID_MANUAL`);
    const { events, jobs } = await state(f);
    expect(textOf([inbox, logs, events, jobs])).not.toContain(NOTE);
  });
});
