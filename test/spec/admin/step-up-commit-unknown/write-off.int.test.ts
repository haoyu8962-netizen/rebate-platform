// B2-02ze (claude-independent, SPEC_REF d49d8aa5): the totp-tier step-up token of
// writeOffAdminReconDiff (POST /admin/v1/recon-diffs/{recon_diff_id}/write-off: payout.execute,
// Idempotency-Key, one transaction with the idempotency record) when the outcome of the COMMIT is
// unknown (task brief §9.2 #5–#7; 08 BR-ID-34 二次验证, BR-WDR-23 ③). The retry is what a client
// does after an error: the same token and the same Idempotency-Key. Controls in the same case: a
// failure inside the transaction (rolled back) and a business refusal give the token back; a
// success consumes it. Seeds and contract checks from ../../ledger/admin-recon-write-off/kit.ts; the
// entry from ./kit.ts on the faulty handle. Top-level it() only.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  BODY,
  EXECUTE,
  WRITE_OFF_ACTION,
  answer,
  audits,
  diffNow,
  fixture,
  newKey,
  seedCase,
  stepUpRequired,
  suite,
  withdrawalRow,
  writeOffPath,
  writtenOff,
  type AdminSent,
  type WriteOffFixture,
} from '../../ledger/admin-recon-write-off/kit.ts';
import { expectFailed, withEntry, type Sent } from './kit.ts';

const s = suite();

/** The write-off records naming the difference. */
async function writeOffAudits(f: WriteOffFixture, reconDiffId: string) {
  return (await audits(f, WRITE_OFF_ACTION)).filter((row) => row.target === reconDiffId);
}

function asWriteOff(sent: Sent): AdminSent {
  return { op: 'writeOff', statusCode: sent.statusCode, body: sent.body, json: () => sent.json() };
}

/** What light-my-request rejects with when the server destroys the response before it ends. */
const DROPPED = /response destroyed before completion/;

/**
 * The answer was an error. On an idempotent route a COMMIT whose outcome is unknown is answered
 * without the envelope, by closing the connection (BR-ID-10 细则「服务端的配合」; platform/http
 * global-errors.ts) — inject then rejects; that dropped connection is the error the client sees.
 */
async function expectFailedOrDropped(send: () => Promise<Sent>): Promise<void> {
  let sent: Sent;
  try {
    sent = await send();
  } catch (error: unknown) {
    expect(error instanceof Error ? error.message : String(error), '连接被关闭').toMatch(DROPPED);
    return;
  }
  expectFailed(sent);
}

it('[AC-B2-02ze#9] 动态码档（差错核销，带幂等键）：业务提交时连接中断、结果未知 → 应答为错误，用同一令牌、同一幂等键重试 → 10003，核销没有第二次执行（审计只有一条）；对照：事务回调内失败已回滚 → 同一令牌、同一幂等键重试照常成功、成功后该令牌再用 → 10003；业务正常返回拒绝（20001）→ 令牌照旧可用', async () => {
  const f = fixture(s);
  const one = await seedCase(f);
  const two = await seedCase(f);
  await withEntry(f, async (h) => {
    const executor = await h.caller([EXECUTE]);
    const writeOff = async (reconDiffId: string, token: string, key: string) =>
      asWriteOff(
        await h.post(writeOffPath(reconDiffId), BODY, { caller: executor, stepUp: token, key }),
      );

    // Control (#6): the audit INSERT fails inside the callback; everything rolls back.
    const rolledBack = await h.stepUp(executor, 'totp');
    const firstKey = newKey();
    h.fault.arm('statement', WRITE_OFF_ACTION);
    expectFailed(await writeOff(one.diff.id, rolledBack, firstKey));
    expect(h.fault.tripped, '回调内的失败已注入').toBe(1);
    expect((await diffNow(f, one.diff.id)).status, '已回滚：差错单不变').toBe(one.diff.status);
    expect(await writeOffAudits(f, one.diff.id), '已回滚：没有审计').toEqual([]);
    const done = await writeOff(one.diff.id, rolledBack, firstKey);
    expect((await writtenOff(done)).released_hold_count).toBe(1);
    // Control (#7): a success consumed it.
    await stepUpRequired(await writeOff(one.diff.id, rolledBack, newKey()));
    expect(await writeOffAudits(f, one.diff.id)).toHaveLength(1);

    // Control (#6): a refusal answered by the business gives the token back.
    const token = await h.stepUp(executor, 'totp');
    await answer(await writeOff(randomUUID(), token, newKey()), 20001, {
      fields: ['recon_diff_id'],
    });

    // #5: the COMMIT goes through, the caller sees a dropped connection.
    const key = newKey();
    h.fault.arm('commit_lost', WRITE_OFF_ACTION);
    await expectFailedOrDropped(() =>
      h.post(writeOffPath(two.diff.id), BODY, { caller: executor, stepUp: token, key }),
    );
    expect(h.fault.tripped, '提交时的连接中断已注入').toBe(2);
    expect((await diffNow(f, two.diff.id)).status, 'COMMIT 实际已生效').toBe('written_off');
    expect(await withdrawalRow(f.db, f.appId, two.w.id)).toMatchObject({ status: 'PAID_API' });
    const once = await writeOffAudits(f, two.diff.id);
    expect(once, '这次核销的审计已提交').toHaveLength(1);

    await stepUpRequired(await writeOff(two.diff.id, token, key));
    expect(await writeOffAudits(f, two.diff.id), '核销没有第二次执行：审计只有一条').toEqual(once);
  });
});
