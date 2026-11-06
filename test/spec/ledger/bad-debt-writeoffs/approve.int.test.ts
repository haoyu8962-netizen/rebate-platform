// B2-12f approval (claude-independent): BR-FUND-12「批准时重读 available 与 frozen…available <0 → 写
// BAD_DEBT_WRITEOFF（借 BAD_DEBT / 贷 USER_BALANCE.available，金额 = −当前 available_fen，不用候选单生成时的
// 金额），使 available=0；≥0 → 候选单置 CANCELLED，不写凭证。凭证 uniq_key=BADDEBT:{account_id}:{candidate_id}」
// with its 例 (−800 生成，批准前入账 500 → 核销 300), state machine BD2 / BD3, BR-FUND-16 (分录借贷平衡、
// 会计日取注入时钟), the contract's effects (one transaction under the member's balance lock; the
// audit record bad_debt_writeoff_approve with the id, the account_id, the resulting status,
// written_off_fen and available before and after, no personal data; CANCELLED answers 200 with
// written_off_fen 0 and approver_id / approved_at null). Round 2 (review r1): the balance-row lock
// alone serialises an approval against a posting, in both orders (#29, #30); version + 1,
// balance_after_fen 0 and no platform balance row on every successful write-off (#15, #18, #29–#34);
// amounts to the fen beyond 2^31 (#32); the +08:00 accounting day across UTC midnight (#34). Expected
// days and dates are written out by hand. Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  APPROVE_ACTION,
  DAY,
  SINCE,
  answer,
  approvalOf,
  audits,
  badDebtVouchers,
  balanceCache,
  blockedBehind,
  cacheRowOf,
  candidateNow,
  creditOn,
  credit,
  entriesOf,
  everything,
  expectApproveAudit,
  expectCancelled,
  expectWrittenOff,
  fixture,
  holdBalance,
  holdMember,
  isBalanceLock,
  linesOf,
  lockWaitOf,
  moneyOf,
  negativeMember,
  newKey,
  rowView,
  seedCandidate,
  suite,
  templateEntries,
  track,
  waiting,
  withWriteoffAdmin,
  writeoffKey,
  type AdminSent,
  type BalanceHold,
  type Tracked,
} from './kit.ts';

const s = suite();

it('[AC-B2-12f#15] BR-FUND-12 例：候选单生成时 −800（candidate_fen 800），批准前入账 500 → 批准核销 300（不是 800）：应答 APPROVED、written_off_fen 300、available 0；凭证 BADDEBT:{account_id}:{id} 记在当天会计日，分录逐行对 BAD_DEBT_WRITEOFF 模板（借 BAD_DEBT 300 / 贷 USER_BALANCE.available 300）且借贷合计为 0；negative_since 清空；审计 bad_debt_writeoff_approve 一条，含单号、账户、APPROVED、300 与前后 available −300 / 0，不含个人信息', async () => {
  const f = fixture(s);
  await withWriteoffAdmin(f, async (h) => {
    const m = await negativeMember(f, { available: -800n, since: SINCE });
    const row = await seedCandidate(f, m);
    expect(row).toMatchObject({ candidate_fen: 800n, negative_since: SINCE, status: 'PENDING' });
    await credit(f, m, 500n);
    expect(await moneyOf(f, m)).toEqual({ available: -300n, frozen: 0n, negativeSince: SINCE });
    const cache = await balanceCache(f);

    const done = await expectWrittenOff(f, await h.approve(row.id), {
      row,
      m,
      adminId: h.writer.id,
      amount: 300n,
      frozen: 0n,
      cache,
    });
    expect(done.candidate_fen, '候选单金额只作参考、不改').toBe(800n);
    await expectApproveAudit(f, {
      adminId: h.writer.id,
      row,
      status: 'APPROVED',
      writtenOff: 300n,
      before: -300n,
      after: 0n,
    });
  });
});

it('[AC-B2-12f#16] 批准在会员的锁下重读余额：外部事务先持有 users 行与余额行，批准请求排队等锁；外部事务在锁内入账 500（−800 → −300）后提交，批准按锁后读到的 −300 核销 300', async () => {
  const f = fixture(s);
  await withWriteoffAdmin(f, async (h) => {
    const m = await negativeMember(f, { available: -800n, since: SINCE });
    const row = await seedCandidate(f, m);
    const hold = await holdMember(f, m.userId, async (trx, balance) => {
      await creditOn(f, trx, balance, 500n);
    });
    const pending = track(h.approve(row.id));
    try {
      expect(await waiting(f, 1, [pending]), '批准应等会员的锁').toBe(true);
    } finally {
      await hold.release();
    }
    await expectWrittenOff(f, await pending.promise, {
      row,
      m,
      adminId: h.writer.id,
      amount: 300n,
      frozen: 0n,
    });
  });
});

it('[AC-B2-12f#17] 批准时余额已回正 → CANCELLED、HTTP 200、written_off_fen 0：正好抵平到 0 的、回到 +200 的都不写凭证、不动余额，approver_id 与 approved_at 仍为 null；各写一条审计（CANCELLED、0、前后 available 相同）', async () => {
  const f = fixture(s);
  await withWriteoffAdmin(f, async (h) => {
    const even = await negativeMember(f, { available: -800n, since: SINCE });
    const evenRow = await seedCandidate(f, even);
    await credit(f, even, 800n);
    const above = await negativeMember(f, { available: -800n, since: SINCE });
    const aboveRow = await seedCandidate(f, above);
    await credit(f, above, 1000n);

    await expectCancelled(f, await h.approve(evenRow.id), {
      row: evenRow,
      m: even,
      money: { available: 0n, frozen: 0n, negativeSince: null },
    });
    await expectApproveAudit(f, {
      adminId: h.writer.id,
      row: evenRow,
      status: 'CANCELLED',
      writtenOff: 0n,
      before: 0n,
      after: 0n,
    });

    const before = await audits(f, APPROVE_ACTION);
    await expectCancelled(f, await h.approve(aboveRow.id), {
      row: aboveRow,
      m: above,
      money: { available: 200n, frozen: 0n, negativeSince: null },
    });
    const after = await audits(f, APPROVE_ACTION);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    const text = JSON.stringify([after.at(-1)!.target, after.at(-1)!.before, after.at(-1)!.after]);
    for (const part of [aboveRow.id, aboveRow.account_id, 'CANCELLED', '200']) {
      expect(text, part).toContain(part);
    }
  });
});

it('[AC-B2-12f#18] 一个事务：写审计失败或改候选单失败时整笔回滚（候选单仍 PENDING、无凭证、余额与 negative_since 不变、无审计），换新幂等键重试一次生效', async () => {
  const f = fixture(s);
  await withWriteoffAdmin(f, async (h) => {
    const m = await negativeMember(f, { available: -800n, since: SINCE });
    const row = await seedCandidate(f, m);
    const before = await everything(f);
    const cache = await balanceCache(f);
    for (const point of ['audit', 'candidate'] as const) {
      h.fault.point = point;
      const tripped = h.fault.tripped;
      const failed = await h.approve(row.id, {}, { key: newKey() });
      expect(h.fault.tripped, `${point} 故障应被触发`).toBe(tripped + 1);
      await answer(failed, 50001);
      expect(await everything(f), `${point} 失败整笔回滚`).toEqual(before);
    }
    await expectWrittenOff(f, await h.approve(row.id, {}, { key: newKey() }), {
      row,
      m,
      adminId: h.writer.id,
      amount: 800n,
      frozen: 0n,
      cache,
    });
    expect((await moneyOf(f, m)).negativeSince).toBeNull();
  });
});

it('[AC-B2-12f#29] 只持有余额行锁的另一连接先拿到锁（不持 users 行）：批准事务被这把余额行锁挡住（pg_blocking_pids 指向持锁连接，被挡的正是入口发出的 account_balances … FOR UPDATE），持锁事务入账 500（−800 → −300）提交后，批准按锁后读到的 −300 核销 300：available 0、version 恰好 +1、用户分录 balance_after_fen 0，平台科目没有余额缓存行', async () => {
  const f = fixture(s);
  await withWriteoffAdmin(f, async (h) => {
    const m = await negativeMember(f, { available: -800n, since: SINCE });
    const row = await seedCandidate(f, m);
    const cache = await balanceCache(f);
    const creditKey = `SEED:${randomUUID()}`;
    const hold = await holdBalance(f, m, async (trx, balance) => {
      await creditOn(f, trx, balance, 500n, creditKey);
    });
    let pending: Tracked<AdminSent> | undefined;
    try {
      expect(await hold.untilLocked(), '持锁连接应先拿到余额行').toBe(true);
      pending = track(h.approve(row.id));
      const blocked = await blockedBehind(f, hold.pid, [pending]);
      expect(blocked, '批准应排在这把余额行锁之后').toHaveLength(1);
      const statement = blocked[0]!;
      expect(isBalanceLock(statement), statement).toBe(true);
      expect(
        h.balanceLocks.some((text) => statement !== '' && text.startsWith(statement)),
        '被挡的语句是批准入口发出的余额行锁',
      ).toBe(true);
      expect(pending.settled, '持锁期间批准不应答').toBe(false);
    } finally {
      await hold.release();
    }
    const sent = await pending!.promise;
    expect(await linesOf(f, creditKey), '入账先于核销记账').toEqual([
      expect.objectContaining({ owner_type: 'platform', amount_fen: 500n }),
      {
        owner_type: 'user',
        subject: 'USER_BALANCE',
        sub_account: 'available',
        amount_fen: -500n,
        balance_after_fen: -300n,
        account_version: cacheRowOf(cache, m).version + 1n,
      },
    ]);
    await expectWrittenOff(f, sent, {
      row,
      m,
      adminId: h.writer.id,
      amount: 300n,
      frozen: 0n,
      cache,
      postedBefore: 1,
    });
    expect(await linesOf(f, writeoffKey(row))).toEqual([
      expect.objectContaining({
        owner_type: 'platform',
        subject: 'BAD_DEBT',
        sub_account: 'available',
        amount_fen: 300n,
      }),
      {
        owner_type: 'user',
        subject: 'USER_BALANCE',
        sub_account: 'available',
        amount_fen: -300n,
        balance_after_fen: 0n,
        account_version: cacheRowOf(cache, m).version + 2n,
      },
    ]);
  });
});

it('[AC-B2-12f#30] 批准先拿到余额行锁（入口的 account_balances … FOR UPDATE 返回后在此停住）：只要余额行锁的另一连接入账 500 时被批准挡住；放行后批准按 −800 核销 800 并提交，之后入账才记账：available 500、version 共 +2，核销分录 balance_after_fen 0 / version +1，入账分录 balance_after_fen 500 / version +2，只有一张 BADDEBT 凭证', async () => {
  const f = fixture(s);
  await withWriteoffAdmin(f, async (h) => {
    const m = await negativeMember(f, { available: -800n, since: SINCE });
    const row = await seedCandidate(f, m);
    const cache = await balanceCache(f);
    const version = cacheRowOf(cache, m).version;
    const creditKey = `SEED:${randomUUID()}`;
    const paused = h.pauseAfterBalanceLock();
    const pending = track(h.approve(row.id));
    let hold: BalanceHold | undefined;
    try {
      expect(
        await paused.untilReached(pending),
        '批准应以 account_balances … FOR UPDATE 取得会员的余额行锁',
      ).toBe(true);
      hold = await holdBalance(f, m, async (trx, balance) => {
        await creditOn(f, trx, balance, 500n, creditKey);
      });
      const wait = await lockWaitOf(f, hold.pid);
      expect(wait, '入账连接应等批准持有的余额行锁').not.toBeNull();
      expect(isBalanceLock(wait!.query), wait!.query).toBe(true);
      expect(wait!.blockers).toBeGreaterThan(0);
      expect(await hold.untilLocked(200), '批准未提交前入账拿不到锁').toBe(false);
    } finally {
      paused.resume();
    }
    const sent = await pending.promise;
    await hold?.release();

    const done = await approvalOf(sent);
    expect(done.written_off_fen, sent.body).toBe(800);
    const now = await candidateNow(f, row.id);
    expect(now).toEqual({
      ...row,
      status: 'APPROVED',
      approver_id: h.writer.id,
      approved_at: f.clock.now(),
      voucher_id: now.voucher_id,
    });
    // available_fen of the answer is the balance read with it: 0 inside the write-off's transaction,
    // 500 when read after the credit committed; every other field is fixed.
    const view = rowView(now, m, { available: 0n, frozen: 0n }, { day: DAY, blocked: false });
    expect(done.writeoff).toEqual({ ...view, available_fen: done.writeoff['available_fen'] });
    expect([0, 500], sent.body).toContain(done.writeoff['available_fen']);
    expect((await badDebtVouchers(f)).map((v) => v.uniq_key)).toEqual([writeoffKey(row)]);
    expect(await entriesOf(f, writeoffKey(row))).toEqual(
      templateEntries('BAD_DEBT_WRITEOFF', { userId: m.userId, platform: null, amount: 800n }),
    );
    expect(await linesOf(f, writeoffKey(row))).toEqual([
      expect.objectContaining({ owner_type: 'platform', subject: 'BAD_DEBT', amount_fen: 800n }),
      {
        owner_type: 'user',
        subject: 'USER_BALANCE',
        sub_account: 'available',
        amount_fen: -800n,
        balance_after_fen: 0n,
        account_version: version + 1n,
      },
    ]);
    expect(await linesOf(f, creditKey)).toEqual([
      expect.objectContaining({ owner_type: 'platform', amount_fen: 500n }),
      {
        owner_type: 'user',
        subject: 'USER_BALANCE',
        sub_account: 'available',
        amount_fen: -500n,
        balance_after_fen: 500n,
        account_version: version + 2n,
      },
    ]);
    expect(await balanceCache(f)).toEqual(
      cache.map((item) =>
        item.account_id === m.accountId
          ? { ...item, available_fen: 500n, negative_since: null, version: version + 2n }
          : item,
      ),
    );
    expect(await moneyOf(f, m)).toEqual({ available: 500n, frozen: 0n, negativeSince: null });
    await expectApproveAudit(f, {
      adminId: h.writer.id,
      row,
      status: 'APPROVED',
      writtenOff: 800n,
      before: -800n,
      after: 0n,
    });
  });
});

it('[AC-B2-12f#32] 金额逐分、不截断：经真实批准入口核销 −1 分、−1001 分（奇数）与 −2147483649 分（超过 2^31）：应答 written_off_fen 分别为 1、1001、2147483649，available 都变 0，凭证分录为借 BAD_DEBT 同额 / 贷 USER_BALANCE.available 同额、合计 0', async () => {
  const f = fixture(s);
  await withWriteoffAdmin(f, async (h) => {
    const cases = [
      { available: -1n, fen: 1n, answer: 1 },
      { available: -1001n, fen: 1001n, answer: 1001 },
      { available: -2147483649n, fen: 2147483649n, answer: 2147483649 },
    ] as const;
    for (const c of cases) {
      const m = await negativeMember(f, { available: c.available, since: SINCE });
      const row = await seedCandidate(f, m);
      expect(row.candidate_fen).toBe(c.fen);
      const cache = await balanceCache(f);
      const sent = await h.approve(row.id);
      const done = await approvalOf(sent);
      expect(done.written_off_fen, sent.body).toBe(c.answer);
      expect(done.writeoff, sent.body).toMatchObject({
        candidate_fen: c.answer,
        available_fen: 0,
        frozen_fen: 0,
        status: 'APPROVED',
      });
      await expectWrittenOff(f, sent, {
        row,
        m,
        adminId: h.writer.id,
        amount: c.fen,
        frozen: 0n,
        cache,
      });
      expect(await linesOf(f, writeoffKey(row)), `${c.fen} 分`).toEqual([
        expect.objectContaining({
          owner_type: 'platform',
          subject: 'BAD_DEBT',
          sub_account: 'available',
          amount_fen: c.fen,
        }),
        expect.objectContaining({
          owner_type: 'user',
          subject: 'USER_BALANCE',
          sub_account: 'available',
          amount_fen: -c.fen,
          balance_after_fen: 0n,
        }),
      ]);
      expect(await moneyOf(f, m)).toEqual({ available: 0n, frozen: 0n, negativeSince: null });
    }
  });
});

it('[AC-B2-12f#34] 会计日按北京时间 00:00 日切：2027-02-18T17:00Z（北京 02-19 01:00，UTC 仍是 02-18）批准 −800（北京 2026-11-20 00:30 变负，negative_since 2026-11-20）→ 凭证 accounting_date 2027-02-19，应答 negative_days 91、approved_at 为该时刻', async () => {
  const f = fixture(s, '2027-02-18T17:00:00.000Z');
  await withWriteoffAdmin(f, async (h) => {
    const m = await negativeMember(f, {
      available: -800n,
      since: '2026-11-20',
      at: '2026-11-19T16:30:00.000Z',
    });
    expect((await moneyOf(f, m)).negativeSince, '北京 11-20 00:30 变负').toBe('2026-11-20');
    const row = await seedCandidate(f, m, { createdAt: new Date('2027-02-17T16:01:00.000Z') });
    const cache = await balanceCache(f);
    const sent = await h.approve(row.id);
    await expectWrittenOff(f, sent, {
      row,
      m,
      adminId: h.writer.id,
      amount: 800n,
      frozen: 0n,
      cache,
    });
    const vouchers = await badDebtVouchers(f);
    expect(vouchers.map((v) => [v.uniq_key, v.accounting_date])).toEqual([
      [writeoffKey(row), '2027-02-19'],
    ]);
    const done = await approvalOf(sent);
    expect(done.writeoff).toMatchObject({
      negative_since: '2026-11-20',
      negative_days: 91,
      approved_at: Date.parse('2027-02-18T17:00:00.000Z'),
    });
  });
});
