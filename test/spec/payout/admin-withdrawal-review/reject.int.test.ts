// B2-09k rejection rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminRejectWithdrawal, 08 BR-WDR-10, BR-WDR-09 — W3 from PENDING_REVIEW and APPROVED with
// reject_reason_code, reject_note, reviewer_id the caller and reviewed_at the injected Clock; the voucher
// WITHDRAW:RETURN `wd:{id}:RETURN` moves the whole amount from frozen back to available; a note is
// required for USER_REQUEST and never blank; wallet.withdrawal_changed on the same transaction, from
// which the member gets the rejection message; the member sees the text of the reason code, never the
// note; audit withdrawal_reject without personal data. Requests go through the real admin entry
// (review-harness.ts); the message through notification's real consumer. Top-level it() only
// (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  listWithdrawalsForUser,
  readWithdrawalForUser,
  registerWithdrawalAccountDecrypt,
} from '../../../../apps/api/src/modules/payout/application/withdrawal-reads.ts';
import {
  ACCOUNT,
  AFTER_FREEZE,
  AMOUNT,
  BALANCE,
  MESSAGE_QUEUE,
  NOTE,
  REJECT_ACTION,
  auditText,
  audits,
  balanceOf,
  changes,
  chars,
  deliverMessage,
  entries,
  everything,
  expectNoSecrets,
  fieldsError,
  fixture,
  frozenMismatches,
  jobQueues,
  member,
  messageJobs,
  rejectBody,
  rejectedBy,
  rowOf,
  secretsOf,
  seedApproved,
  seedReview,
  suite,
  textOf,
  voucherOf,
  withReviewAdmin,
  type WithdrawalRow,
  type ReviewFixture,
} from './review-harness.ts';

const s = suite();

/** The two lines of WITHDRAW:RETURN for `amount` (user subaccounts: signs opposite to the deltas). */
async function expectReturnVoucher(
  f: ReviewFixture,
  w: WithdrawalRow,
  amount: bigint,
): Promise<void> {
  const key = `wd:${w.id}:RETURN`;
  expect(await entries(f.db, f.appId, key)).toEqual([
    {
      owner_type: 'user',
      subject: 'USER_BALANCE',
      sub_account: 'frozen',
      amount_fen: amount,
      ledger_type: 'WITHDRAW_RETURN',
    },
    {
      owner_type: 'user',
      subject: 'USER_BALANCE',
      sub_account: 'available',
      amount_fen: -amount,
      ledger_type: 'WITHDRAW_RETURN',
    },
  ]);
}

it('[AC-B2-09k#19] W3 从 PENDING_REVIEW：REJECTED，原因码、备注、reviewer_id、reviewed_at 写对，row_version + 1，其余列不变；WITHDRAW:RETURN 把 12,345（不是到手 12,145）从 frozen 退回 available：available 87,658 → 100,003，frozen 12,345 → 0；凭证操作人 admin:<调用者>', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const w = await seedReview(f, h, who);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: AFTER_FREEZE,
      frozen_fen: AMOUNT,
    });

    await rejectedBy(f, await h.reject(w.id, rejectBody()), w, h.reviewer.id, 'PAYEE_INFO_INVALID');

    expect(await rowOf(f, w)).toEqual({
      ...w,
      status: 'REJECTED',
      reject_reason_code: 'PAYEE_INFO_INVALID',
      reject_note: NOTE,
      reviewer_id: h.reviewer.id,
      reviewed_at: f.clock.now(),
      row_version: w.row_version + 1,
      updated_at: f.clock.now(),
    });
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: BALANCE,
      frozen_fen: 0n,
    });
    await expectReturnVoucher(f, w, 12_345n);
    expect(await voucherOf(f.db, f.appId, `wd:${w.id}:RETURN`)).toEqual([
      {
        uniq_key: `wd:${w.id}:RETURN`,
        biz_type: 'withdrawal',
        biz_id: w.id,
        operator: `admin:${h.reviewer.id}`,
      },
    ]);
    expect(await frozenMismatches(f.db, f.appId)).toEqual([]);
  });
});

it('[AC-B2-09k#20] W3 从 APPROVED（EXECUTE 之前，没有转账尝试）：REJECTED，reviewer_id 换成驳回人，金额 7,919 退回；另一单 PENDING_REVIEW 的冻结 12,345 不受影响', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const w = await seedApproved(f, h, who, { amount_fen: 7_919n, fee_fen: 19n, tax_fen: 0n });
    const staying = await seedReview(f, h, who);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: 79_739n,
      frozen_fen: 20_264n,
    });

    await rejectedBy(
      f,
      await h.reject(w.id, rejectBody({ reason_code: 'OTHER' })),
      w,
      h.reviewer.id,
      'OTHER',
    );

    expect(await rowOf(f, w)).toEqual({
      ...w,
      status: 'REJECTED',
      reject_reason_code: 'OTHER',
      reject_note: NOTE,
      reviewer_id: h.reviewer.id,
      reviewed_at: f.clock.now(),
      row_version: w.row_version + 1,
      updated_at: f.clock.now(),
    });
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: 87_658n,
      frozen_fen: 12_345n,
    });
    await expectReturnVoucher(f, w, 7_919n);
    expect(await rowOf(f, staying)).toEqual(staying);
    expect(await frozenMismatches(f.db, f.appId)).toEqual([]);
  });
});

it('[AC-B2-09k#21] 人工可选的五个原因码都能驳回并按原样保存；非 USER_REQUEST 可以不带 note（reject_note 为 null），note 恰好 500 字可以', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const cancel = '会员联系客服要求撤销';
    const cases: readonly (readonly [string, Record<string, unknown>, string | null])[] = [
      ['RISK_SUSPECT', { reason_code: 'RISK_SUSPECT' }, null],
      ['ORDER_ABNORMAL', { reason_code: 'ORDER_ABNORMAL' }, null],
      ['PAYEE_INFO_INVALID', { reason_code: 'PAYEE_INFO_INVALID', note: chars(500) }, chars(500)],
      ['USER_REQUEST', { reason_code: 'USER_REQUEST', note: cancel }, cancel],
      ['OTHER', { reason_code: 'OTHER' }, null],
    ];
    for (const [code, body, note] of cases) {
      const w = await seedReview(f, h, who, { amount_fen: 1_003n, fee_fen: 0n, tax_fen: 0n });
      await rejectedBy(f, await h.reject(w.id, body), w, h.reviewer.id, code);
      expect(await rowOf(f, w), code).toMatchObject({
        status: 'REJECTED',
        reject_reason_code: code,
        reject_note: note,
      });
    }
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: BALANCE,
      frozen_fen: 0n,
    });
  });
});

it('[AC-B2-09k#22] note 校验在守卫之后：USER_REQUEST 不带 note → 20001 data.fields=[note]；任何原因码的空白 note（空格、制表、换行）→ 20001 data.fields=[note]；什么都不写，余额不动', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const w = await seedReview(f, h, who);
    const before = await everything(f);
    await fieldsError(await h.reject(w.id, { reason_code: 'USER_REQUEST' }), ['note']);
    for (const note of ['   ', ' \t\n ', '　']) {
      await fieldsError(await h.reject(w.id, { reason_code: 'USER_REQUEST', note }), ['note']);
      await fieldsError(await h.reject(w.id, { reason_code: 'OTHER', note }), ['note']);
    }
    expect(await everything(f)).toEqual(before);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: AFTER_FREEZE,
      frozen_fen: AMOUNT,
    });
  });
});

it('[AC-B2-09k#23] 审计：withdrawal_reject 恰一条，操作人是调用者、时间是注入时钟，带 withdrawal_id、前后状态、原因码与备注；不含收款账号、姓名、手机号', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const w = await seedApproved(f, h, who);

    await rejectedBy(f, await h.reject(w.id, rejectBody()), w, h.reviewer.id, 'PAYEE_INFO_INVALID');

    const records = await audits(f, REJECT_ACTION);
    expect(records).toHaveLength(1);
    expect(records[0]?.admin_id).toBe(h.reviewer.id);
    expect(records[0]?.at).toEqual(f.clock.now());
    const text = auditText(records[0]!);
    for (const piece of [w.id, 'APPROVED', 'REJECTED', 'PAYEE_INFO_INVALID', NOTE]) {
      expect(text).toContain(piece);
    }
    expectNoSecrets(text, secretsOf(w, ACCOUNT.alipay, who));
  });
});

it('[AC-B2-09k#24] 用户侧：驳回发 wallet.withdrawal_changed（只有 id 与状态），通知队列恰一条；真实消费者写出驳回消息「提现未通过：收款信息有误，请核对后重新申请，¥123.45 已退回余额」；消息、通知日志、事件、任务与用户可见接口（详情与列表）都看不到内部备注，用户只看到原因码', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const w = await seedReview(f, h, who);

    await rejectedBy(f, await h.reject(w.id, rejectBody()), w, h.reviewer.id, 'PAYEE_INFO_INVALID');

    const data = { withdrawal_id: w.id, user_id: who.userId, status: 'REJECTED' };
    expect(await changes(f.db, f.appId)).toEqual([data]);
    expect(await messageJobs(f)).toEqual([data]);
    expect(await jobQueues(f)).toEqual([MESSAGE_QUEUE]);

    await deliverMessage(f, data);

    const inbox = await f.db
      .selectFrom('inbox_messages')
      .selectAll()
      .where('app_id', '=', f.appId)
      .execute();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      user_id: who.userId,
      code: 'WD_REJECTED',
      title: '提现未通过',
      body: '提现未通过：收款信息有误，请核对后重新申请，¥123.45 已退回余额',
    });
    const logs = await f.db
      .selectFrom('notify_logs')
      .selectAll()
      .where('app_id', '=', f.appId)
      .execute();
    expect(logs.length).toBeGreaterThan(0);
    const { events, jobs } = await everything(f);
    expect(textOf([inbox, logs, events, jobs])).not.toContain(NOTE);

    registerWithdrawalAccountDecrypt(() => ACCOUNT.alipay);
    const subject = { appId: f.appId, userId: who.userId };
    const detail = await readWithdrawalForUser(f.db, { ...subject, withdrawalId: w.id });
    expect(detail).toMatchObject({
      withdrawal_id: w.id,
      status: 'REJECTED',
      reason_code: 'PAYEE_INFO_INVALID',
    });
    const page = await listWithdrawalsForUser(f.db, subject);
    expect(page.items.map((item) => item.withdrawal_id)).toEqual([w.id]);
    expect(textOf([detail, page])).not.toContain(NOTE);
  });
});
