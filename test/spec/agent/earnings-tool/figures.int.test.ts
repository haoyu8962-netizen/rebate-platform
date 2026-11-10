// B3-16a · BR-AI-04 / BR-FUND-18 / BR-AI-01 细则「收益查询」over real PG: the production reads port
// (the composition root's apps/api/src/agent-earnings-reads.ts createEarningsReads, D10-1244 /
// approvals 71; app.module builds it and hands it to the agent) answers, for the caller only,
// exactly what ledger/read.ts getWalletSummary (the query behind GET /v1/wallet/summary) and payout/read.ts
// listWithdrawalsForUser (the query behind GET /v1/withdrawals) answer for that user; the card
// built from it carries the wallet's figures field for field (验收：卡片数字与钱包接口一致 100%) and
// the latest withdrawal's applied amount. Real users, a real ledger balance (payout apply kit's
// fund) and real withdrawals rows (payout read-port kit's seedWithdrawal); the owner-module ports
// of the wallet summary are the ledger wallet-summary kit's synthetic sources. Everything under
// test is built inside the tests; run only in the orchestrator's isolated container.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createEarningsReads } from '../../../../apps/api/src/agent-earnings-reads.ts';
import { createLedger } from '../../../../apps/api/src/modules/ledger/index.ts';
import { getWalletSummary } from '../../../../apps/api/src/modules/ledger/read.ts';
import { registerWithdrawalAccountDecrypt } from '../../../../apps/api/src/modules/payout/application/withdrawal-reads.ts';
import { listWithdrawalsForUser } from '../../../../apps/api/src/modules/payout/read.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { fund } from '../../payout/apply/kit.ts';
import {
  close,
  member,
  open,
  seedWithdrawal,
  TIMEOUT,
  type Harness,
} from '../../payout/read-port/kit.ts';
import {
  ACTIONS,
  callEarnings,
  caller,
  contextOf,
  dataOf,
  earningsCard,
  earningsDeps,
  expectAsOf,
  expectContractCard,
  registerDecrypt,
  registryWith,
  walletFigures,
  walletSources,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

const NOW = '2026-11-03T02:04:05.678Z';

/** A member of a fresh app with a real ledger balance of `balance` fen. */
async function fundedMember(balance: bigint) {
  const who = await member(h.db);
  await fund(h.db, createLedger({ clock: new FixedClock(NOW) }), who, balance);
  return who;
}

it(
  '[AC-B3-16a#16][BR-AI-04][BR-FUND-18] 生产取数口：本人的钱包汇总与 getWalletSummary 逐字段相等、最近一笔提现与 listWithdrawalsForUser 的首条相等；卡上四个数字与 GET /v1/wallet/summary 的同名字段逐一相等，提现只放申请金额',
  async () => {
    registerDecrypt();
    const s = walletSources();
    const who = await fundedMember(98_765_432n);
    const other = await member(h.db, who.appId);
    await seedWithdrawal(h.db, who, {
      status: 'PAID_API',
      paid_at: new Date('2026-10-20T00:00:00.000Z'),
      amount_fen: 11_111_100n,
      created_at: new Date('2026-10-19T00:00:00.000Z'),
    });
    const latestRow = await seedWithdrawal(h.db, who, {
      status: 'PENDING_REVIEW',
      amount_fen: 55_443_322n,
      fee_fen: 1_234_567n,
      tax_fen: 2_345_678n,
      net_fen: 55_443_322n - 1_234_567n - 2_345_678n,
      created_at: new Date('2026-11-01T00:00:00.000Z'),
    });
    // Someone else's newer withdrawal in the same app is never "the latest".
    await seedWithdrawal(h.db, other, {
      status: 'PENDING_REVIEW',
      amount_fen: 77_777_700n,
      created_at: new Date('2026-11-02T00:00:00.000Z'),
    });

    const clock = new FixedClock(NOW);
    const reads = createEarningsReads({ db: h.db, clock, wallet: s.dependencies });

    // The oracle: the very queries behind GET /v1/wallet/summary and GET /v1/withdrawals.
    const wallet = await getWalletSummary(h.db, who, s.dependencies);
    expect(wallet.withdrawable_fen, 'fixture: a real positive balance').toBeGreaterThan(0);
    const records = await listWithdrawalsForUser(
      h.db,
      { appId: who.appId, userId: who.userId, limit: 1 },
      { now: clock.now() },
    );
    expect(records.items[0]?.withdrawal_id, 'fixture: the newest own withdrawal').toBe(
      latestRow.id,
    );

    const read = await reads.read(who);
    expect(read.wallet).toEqual(wallet);
    expect(read.latestWithdrawal).toEqual(records.items[0]);

    const { deps } = earningsDeps();
    const { registry } = registryWith({ ...deps, clock, reads });
    const subject = { ...caller(who.userId), appId: who.appId };
    const card = earningsCard(await callEarnings(registry, {}, contextOf(subject)));
    const data = dataOf(card);
    expect({
      withdrawable_fen: data['withdrawable_fen'],
      estimated_total_fen: data['estimated_total_fen'],
      next_credit_period: data['next_credit_period'],
      credit_overdue: data['credit_overdue'],
    }).toEqual(walletFigures(wallet));
    expect((data['latest_withdrawal'] as Record<string, unknown>)['amount_fen']).toBe(
      Number(latestRow.amount_fen),
    );
    expect(data['actions']).toEqual(ACTIONS);
    expectAsOf(data['as_of'], Date.parse(NOW));
    expectContractCard(card);
  },
  TIMEOUT,
);

it(
  '[AC-B3-16a#17][BR-AI-04][BR-FUND-13] 没有余额行、没有提现的本人：卡上可提现为钱包汇总给出的 0（确实为 0，不是缺省补位），latest_withdrawal 为 null',
  async () => {
    registerDecrypt();
    const s = walletSources();
    const who = await member(h.db);
    const clock = new FixedClock(NOW);
    const reads = createEarningsReads({ db: h.db, clock, wallet: s.dependencies });
    const wallet = await getWalletSummary(h.db, who, s.dependencies);

    const read = await reads.read(who);
    expect(read).toEqual({ wallet, latestWithdrawal: null });

    const { deps } = earningsDeps();
    const { registry } = registryWith({ ...deps, clock, reads });
    const subject = { ...caller(who.userId), appId: who.appId };
    const data = dataOf(earningsCard(await callEarnings(registry, {}, contextOf(subject))));
    expect(data['withdrawable_fen']).toBe(wallet.withdrawable_fen);
    expect(data['estimated_total_fen']).toBe(wallet.estimated_total_fen);
    expect(data['latest_withdrawal']).toBeNull();
  },
  TIMEOUT,
);

it(
  '[AC-B3-16a#18][BR-AI-04] 钱包汇总的查询失败：生产取数口拒绝，工具不出卡、返回模型 {status: "unavailable"}，不用 0 补位',
  async () => {
    registerDecrypt();
    const s = walletSources();
    s.readUser.mockRejectedValue(new Error('合成预估收益查询失败'));
    const who = await fundedMember(12_345_678n);
    const clock = new FixedClock(NOW);
    const reads = createEarningsReads({ db: h.db, clock, wallet: s.dependencies });
    await expect(reads.read(who)).rejects.toThrow();

    const { deps } = earningsDeps();
    const { registry } = registryWith({ ...deps, clock, reads });
    const subject = { ...caller(who.userId), appId: who.appId };
    const outcome = await callEarnings(registry, {}, contextOf(subject));
    expect(outcome.kind === 'ok' ? outcome.cards.map((card) => card.type) : []).not.toContain(
      'earnings_summary',
    );
    expect(outcome.modelView).toEqual({ status: 'unavailable' });
  },
  TIMEOUT,
);

it(
  '[AC-B3-16a#25][BR-AI-04][BR-AI-01] 提现记录的查询失败（listWithdrawalsForUser 依赖的解密端口抛错）：生产取数口拒绝，工具不出卡、返回模型 {status: "unavailable"}，不把最近一笔提现当成 null 出「无提现」卡',
  async () => {
    const s = walletSources();
    const who = await fundedMember(23_456_789n);
    await seedWithdrawal(h.db, who, {
      status: 'PENDING_REVIEW',
      amount_fen: 44_332_211n,
      created_at: new Date('2026-11-01T00:00:00.000Z'),
    });
    const clock = new FixedClock(NOW);
    const message = '合成收款账号解密失败';
    registerWithdrawalAccountDecrypt(() => {
      throw new Error(message);
    });
    try {
      // The oracle: the records query itself fails for this user; the wallet query does not.
      await expect(
        listWithdrawalsForUser(
          h.db,
          { appId: who.appId, userId: who.userId, limit: 1 },
          { now: clock.now() },
        ),
      ).rejects.toThrow(message);
      expect((await getWalletSummary(h.db, who, s.dependencies)).withdrawable_fen).toBeGreaterThan(
        0,
      );

      const reads = createEarningsReads({ db: h.db, clock, wallet: s.dependencies });
      await expect(reads.read(who)).rejects.toThrow();

      const { deps } = earningsDeps();
      const { registry } = registryWith({ ...deps, clock, reads });
      const subject = { ...caller(who.userId), appId: who.appId };
      const outcome = await callEarnings(registry, {}, contextOf(subject));
      expect(outcome.kind === 'ok' ? outcome.cards.map((card) => card.type) : []).not.toContain(
        'earnings_summary',
      );
      expect(outcome.modelView).toEqual({ status: 'unavailable' });
      expect(JSON.stringify(outcome)).not.toContain(message);
    } finally {
      registerDecrypt();
    }
  },
  TIMEOUT,
);
