// B3-16c (D10-1242 ② 收紧单) · BR-AI-04 / BR-AI-01 细则「收益查询」over real PG: the production
// reads port of get_my_earnings (apps/api/src/agent-earnings-reads.ts createEarningsReads) reads
// anew on every call — one instance, one user, the second read answers what getWalletSummary and
// listWithdrawalsForUser answer at that moment (数字只来自钱包页、提现记录的同一查询函数; 不得用
// 过期缓存补位), and a failing read rejects instead of answering an earlier read's value. Real
// users, real ledger balances (payout apply kit's fund) and real withdrawals rows (payout
// read-port kit's seedWithdrawal); the wallet summary's owner-module ports are the earnings-tool
// kit's synthetic sources. Everything under test is built inside the tests; run only in the
// orchestrator's isolated container.
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
import { registerDecrypt, walletSources } from '../earnings-tool/kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

const NOW = '2026-11-03T02:04:05.678Z';

/** Credits `amount` fen to the member's real ledger balance (ledger's own posting path). */
async function credit(who: { appId: string; userId: string }, amount: bigint) {
  await fund(h.db, createLedger({ clock: new FixedClock(NOW) }), who, amount);
}

/** The oracle: the very queries behind GET /v1/wallet/summary and GET /v1/withdrawals, now. */
async function oracle(
  who: { appId: string; userId: string },
  dependencies: Parameters<typeof getWalletSummary>[2],
  clock: FixedClock,
) {
  const wallet = await getWalletSummary(h.db, who, dependencies);
  const records = await listWithdrawalsForUser(
    h.db,
    { appId: who.appId, userId: who.userId, limit: 1 },
    { now: clock.now() },
  );
  return { wallet, latestWithdrawal: records.items[0] ?? null };
}

it(
  '[AC-B3-16c#1][BR-AI-04][BR-AI-01] 同一取数口实例、同一用户：读过一次后余额经账本入账变了、又新申请了一笔提现，再读返回此刻 getWalletSummary 与 listWithdrawalsForUser 的结果（逐字段相等），与第一次不同——不缓存、不用旧值',
  async () => {
    registerDecrypt();
    const s = walletSources();
    const who = await member(h.db);
    await credit(who, 31_415_926n);
    const first = await seedWithdrawal(h.db, who, {
      status: 'PAID_API',
      paid_at: new Date('2026-10-20T00:00:00.000Z'),
      amount_fen: 12_121_200n,
      created_at: new Date('2026-10-19T00:00:00.000Z'),
    });
    const clock = new FixedClock(NOW);
    const reads = createEarningsReads({ db: h.db, clock, wallet: s.dependencies });

    const before = await reads.read(who);
    expect(before, 'first read = the queries at that moment').toEqual(
      await oracle(who, s.dependencies, clock),
    );
    expect(before.latestWithdrawal?.withdrawal_id, 'fixture: first latest withdrawal').toBe(
      first.id,
    );

    // The data changes through the ordinary paths: a ledger credit and a newer withdrawal.
    await credit(who, 27_182_818n);
    const second = await seedWithdrawal(h.db, who, {
      status: 'PENDING_REVIEW',
      amount_fen: 34_343_400n,
      created_at: new Date('2026-11-01T00:00:00.000Z'),
    });

    const now = await oracle(who, s.dependencies, clock);
    expect(now.wallet.withdrawable_fen, 'fixture: the balance did change').not.toBe(
      before.wallet.withdrawable_fen,
    );
    expect(now.latestWithdrawal?.withdrawal_id, 'fixture: the newer withdrawal is latest').toBe(
      second.id,
    );

    const after = await reads.read(who);
    expect(after.wallet).toEqual(now.wallet);
    expect(after.latestWithdrawal).toEqual(now.latestWithdrawal);
    expect(after).not.toEqual(before);
    expect(after.wallet.withdrawable_fen).not.toBe(before.wallet.withdrawable_fen);
    expect(after.latestWithdrawal?.withdrawal_id).not.toBe(before.latestWithdrawal?.withdrawal_id);
  },
  TIMEOUT,
);

it(
  '[AC-B3-16c#2][BR-AI-04][BR-AI-01] 同一取数口实例、同一用户：第一次读成功后，提现记录的查询失败（listWithdrawalsForUser 依赖的解密端口抛错）时第二次读拒绝、钱包汇总的查询失败时再读也拒绝，都不返回先前读到的值',
  async () => {
    registerDecrypt();
    const s = walletSources();
    const who = await member(h.db);
    await credit(who, 16_180_339n);
    await seedWithdrawal(h.db, who, {
      status: 'PENDING_REVIEW',
      amount_fen: 14_142_135n,
      created_at: new Date('2026-11-01T00:00:00.000Z'),
    });
    const clock = new FixedClock(NOW);
    const reads = createEarningsReads({ db: h.db, clock, wallet: s.dependencies });

    const before = await reads.read(who);
    expect(before, 'fixture: the first read succeeds with the real figures').toEqual(
      await oracle(who, s.dependencies, clock),
    );
    expect(before.latestWithdrawal, 'fixture: a withdrawal was read').not.toBeNull();

    // The records query fails for this user now (and only it: the wallet query still answers).
    const message = '合成收款账号解密失败';
    registerWithdrawalAccountDecrypt(() => {
      throw new Error(message);
    });
    try {
      await expect(
        listWithdrawalsForUser(
          h.db,
          { appId: who.appId, userId: who.userId, limit: 1 },
          { now: clock.now() },
        ),
        'fixture: the records query itself fails',
      ).rejects.toThrow(message);
      await expect(reads.read(who)).rejects.toThrow();
    } finally {
      registerDecrypt();
    }

    // The records answer again; now the wallet summary's owner query fails once.
    s.readUser.mockRejectedValueOnce(new Error('合成预估收益查询失败'));
    await expect(reads.read(who)).rejects.toThrow();

    // Both answer again: the read is the queries' answer at that moment, not a stuck failure.
    expect(await reads.read(who)).toEqual(await oracle(who, s.dependencies, clock));
  },
  TIMEOUT,
);
