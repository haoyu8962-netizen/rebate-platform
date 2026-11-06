// B2-12f state changes, concurrency and idempotency (claude-independent): the contract (a candidate that
// is no longer PENDING is 20902 data.resource=bad_debt_writeoff; `Idempotency-Key` is required: same
// key and body → the first result; same key with another body → not the first result; same key
// while still running → 40901; 规划/04 §5「幂等」 admin subject: another account's key is its own
// scope), BR-FUND-12 / BR-FUND-16 (one voucher per uniq_key, the balance lock serialises approvals).
// The request body is the empty object of AdminEmptyActionRequest, so "another body" can only be one
// the route schema refuses: it must neither replay the first result nor write anything (20001 or
// 20901). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  SINCE,
  WRITEOFF,
  answer,
  approvalOf,
  badDebtVouchers,
  balanceCache,
  candidateNow,
  conflict,
  credit,
  everything,
  expectWrittenOff,
  fixture,
  holdMember,
  moneyOf,
  negativeMember,
  newKey,
  seedCandidate,
  suite,
  track,
  waiting,
  withWriteoffAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-12f#22] 已处理的单再批准 → 20902 bad_debt_writeoff：已 APPROVED 的（含刚由本入口核销的）与已 CANCELLED 的都不再写凭证、不动余额、不写审计', async () => {
  const f = fixture(s);
  await withWriteoffAdmin(f, async (h) => {
    const m = await negativeMember(f, { available: -800n, since: SINCE });
    const row = await seedCandidate(f, m);
    const cache = await balanceCache(f);
    await expectWrittenOff(f, await h.approve(row.id), {
      row,
      m,
      adminId: h.writer.id,
      amount: 800n,
      frozen: 0n,
      cache,
    });
    const old = await negativeMember(f, { available: -300n, since: SINCE });
    const approved = await seedCandidate(f, old, { status: 'APPROVED' });
    const gone = await negativeMember(f, { available: -500n, since: SINCE });
    const cancelled = await seedCandidate(f, gone, { status: 'CANCELLED' });
    // The member is still below 0 beside the cancelled candidate: a 20902 must not write it off.
    await credit(f, gone, -100n);
    const before = await everything(f);

    for (const id of [row.id, approved.id, cancelled.id]) {
      await conflict(await h.approve(id));
    }
    expect(await everything(f)).toEqual(before);
  });
});

it('[AC-B2-12f#23] 两个批准并发（不同账号、不同幂等键）在会员锁后排队：只成一个（APPROVED、核销 800），另一个 20902；只有一张 BADDEBT 凭证、一条审计，available 0', async () => {
  const f = fixture(s);
  await withWriteoffAdmin(f, async (h) => {
    const m = await negativeMember(f, { available: -800n, since: SINCE });
    const row = await seedCandidate(f, m);
    const colleague = await h.caller([WRITEOFF]);
    const cache = await balanceCache(f);
    const hold = await holdMember(f, m.userId);
    const first = track(h.approve(row.id, {}, { caller: h.writer }));
    const second = track(h.approve(row.id, {}, { caller: colleague }));
    try {
      expect(await waiting(f, 2, [first, second]), '两个批准都应等会员的锁').toBe(true);
    } finally {
      await hold.release();
    }
    const answers = [await first.promise, await second.promise];
    const won = answers.filter((sent) => sent.statusCode === 200);
    const lost = answers.filter((sent) => sent.statusCode !== 200);
    expect(won, answers.map((sent) => sent.body).join('\n')).toHaveLength(1);
    expect(lost).toHaveLength(1);
    await conflict(lost[0]!);
    const winner = answers[0]!.statusCode === 200 ? h.writer : colleague;
    await expectWrittenOff(f, won[0]!, {
      row,
      m,
      adminId: winner.id,
      amount: 800n,
      frozen: 0n,
      cache,
    });
    expect(await badDebtVouchers(f)).toHaveLength(1);
    expect((await everything(f)).audits).toHaveLength(1);
  });
});

it('[AC-B2-12f#24] 同一 Idempotency-Key 同一请求体重放：原样返回第一次的应答，不再记账、不再写审计（第一次之后的扣回让余额再负也不核销）；同 key 换请求体 → 不是第一次的应答、什么都不写；新 key → 20902；别的账号用同一 key 是它自己的作用域 → 20902', async () => {
  const f = fixture(s);
  await withWriteoffAdmin(f, async (h) => {
    const m = await negativeMember(f, { available: -800n, since: SINCE });
    const row = await seedCandidate(f, m);
    const key = newKey();
    const cache = await balanceCache(f);
    const sent = await h.approve(row.id, {}, { key });
    await expectWrittenOff(f, sent, {
      row,
      m,
      adminId: h.writer.id,
      amount: 800n,
      frozen: 0n,
      cache,
    });
    await credit(f, m, -50n);
    const after = await everything(f);

    for (let round = 0; round < 2; round += 1) {
      const again = await h.approve(row.id, {}, { key });
      expect(again.statusCode).toBe(sent.statusCode);
      expect(again.body).toBe(sent.body);
    }
    const other = await h.approve(row.id, { note: '换一个请求体' }, { key });
    expect(other.statusCode, other.body).not.toBe(200);
    expect([20001, 20901], other.body).toContain(other.json().code);
    await conflict(await h.approve(row.id));
    const colleague = await h.caller([WRITEOFF]);
    await conflict(await h.approve(row.id, {}, { key, caller: colleague }));

    expect(await everything(f), '重放与拒绝都不写').toEqual(after);
    expect(await moneyOf(f, m)).toMatchObject({ available: -50n });
  });
});

it('[AC-B2-12f#25] 同一 key 的请求还在执行（排在会员锁后）时再发 → 40901；锁放开后第一次照常核销，之后同 key 重放得到它的应答', async () => {
  const f = fixture(s);
  await withWriteoffAdmin(f, async (h) => {
    const m = await negativeMember(f, { available: -800n, since: SINCE });
    const row = await seedCandidate(f, m);
    const key = newKey();
    const cache = await balanceCache(f);
    const hold = await holdMember(f, m.userId);
    const first = track(h.approve(row.id, {}, { key }));
    try {
      expect(await waiting(f, 1, [first]), '第一次应等会员的锁').toBe(true);
      await answer(await h.approve(row.id, {}, { key }), 40901);
    } finally {
      await hold.release();
    }
    const sent = await first.promise;
    await expectWrittenOff(f, sent, {
      row,
      m,
      adminId: h.writer.id,
      amount: 800n,
      frozen: 0n,
      cache,
    });
    const replay = await h.approve(row.id, {}, { key });
    expect(replay.body).toBe(sent.body);
    expect((await approvalOf(replay)).written_off_fen).toBe(800);
    expect((await candidateNow(f, row.id)).status).toBe('APPROVED');
  });
});
