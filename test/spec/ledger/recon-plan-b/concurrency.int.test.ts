// B2-17 concurrency (claude-independent): BR-FUND-24 ⑨ (批准执行时在同一事务内锁定所关联的每张差错单，以
// CAS 置为 adjusted；同一差错单对同一受益用户至多关联一张已执行、未被红冲的调账单) and 细则「对外差错单的
// 调账」(加锁顺序由实现定，须与 BR-FUND-16 细则「加锁流程」一致; 做法与 W11 核销同一口径) with §9.3 ⑫ of
// the task. Rows are held from the suite's second pool (the member's rows with kit holdMember, a diff
// row with ../admin-recon-close/kit.ts holdRow) until both requests wait inside their transactions;
// only the outcome is pinned (one 200 and one 20902 recon_diff; both 200 for two members of one
// list; adjustment against close: exactly one of the two wins), never which one wins.
import { expect, it } from 'vitest';
import {
  CREATE_ACTION,
  adjustVouchers,
  allForms,
  answer,
  audits,
  fixture,
  holdMember,
  member,
  suite,
  trace,
  track,
  waiting,
  withAdjustAdmin,
  type AdjustFixture,
  type AdminCaller,
  type Tracked,
} from '../admin-adjustments/kit.ts';
import {
  closed,
  conflict as closeConflict,
  holdRow,
  withCloseAdmin,
} from '../admin-recon-close/kit.ts';
import {
  diffConflict,
  diffNow,
  diffRef,
  expectNowAdjusted,
  linkOf,
  linksOf,
  schemaReady,
  seedTicket,
  send,
  sortedLinks,
} from './kit.ts';

const s = suite();

/** Releases the held lock once both requests wait on a lock (asserted). */
async function bothWaiting(
  f: AdjustFixture,
  lock: { release(): Promise<void> },
  racing: readonly Tracked<unknown>[],
): Promise<void> {
  try {
    expect(await waiting(f, 2, racing), '两个请求都应在行锁上等待').toBe(true);
  } finally {
    await lock.release();
  }
}

function codesOf(results: readonly { json(): { code: number } }[]): number[] {
  return results.map((result) => result.json().code).sort((a, b) => a - b);
}

it('[AC-B2-17#20] 两个请求同时为同一会员关联同一张差错单 → 恰一个 200、一个 20902 recon_diff；只有一张单、一张凭证、一条 adjustment_create、一行关联，差错单由胜出那张的提交人置 adjusted', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const userId = await member(f, { available: 1000n });
    const diff = await seedTicket(f);
    const colleague = await h.caller(['fund.adjust']);
    const callers: AdminCaller[] = [h.maker, colleague];
    const refs = [diffRef(diff)];

    const lock = await holdMember(f, userId);
    const racing = callers.map((caller) => track(send(h, { userId, refs, caller })));
    await bothWaiting(f, lock, racing);
    const results = await Promise.all(racing.map((request) => request.promise));
    const bodies = results.map((result) => result.body).join('\n');
    expect(codesOf(results), bodies).toEqual([0, 20902]);
    const winner = results.findIndex((result) => result.json().code === 0);
    await answer(results[winner]!, 0);
    await diffConflict(results[1 - winner]!);

    const forms = await allForms(f);
    expect(forms).toHaveLength(1);
    expect(await adjustVouchers(f)).toHaveLength(1);
    expect(await audits(f, CREATE_ACTION)).toHaveLength(1);
    expect(await linksOf(f)).toEqual([linkOf(f, forms[0]!.adjust_id, diff.id, userId)]);
    await expectNowAdjusted(f, diff, callers[winner]!.id);
  });
});

it('[AC-B2-17#21] 名单为 U1、U2 的差错单，两人各一个请求同时提交（差错单行被另一连接锁住，两个请求都在等）→ 都 200，各一行关联，差错单最后是 adjusted', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const u1 = await member(f, { available: 1000n });
    const u2 = await member(f, { available: 1000n });
    const diff = await seedTicket(f, { users: [u1, u2] });
    const refs = [diffRef(diff)];

    const lock = await holdRow(f, 'recon_diffs', diff.id);
    const racing = [u1, u2].map((userId) => track(send(h, { userId, refs })));
    await bothWaiting(f, lock, racing);
    const results = await Promise.all(racing.map((request) => request.promise));
    const bodies = results.map((result) => result.body).join('\n');
    expect(codesOf(results), bodies).toEqual([0, 0]);
    for (const result of results) await answer(result, 0);

    const forms = await allForms(f);
    expect(forms.map((form) => form.user_id).sort()).toEqual([u1, u2].sort());
    const expected = forms.map((form) => linkOf(f, form.adjust_id, diff.id, form.user_id));
    expect(await linksOf(f)).toEqual(sortedLinks(expected));
    await expectNowAdjusted(f, diff, h.maker.id);
  });
});

it('[AC-B2-17#22] 调账与关单（closeAdminReconDiff）同时作用于同一张差错单 → 只成一个：调账成则差错单 adjusted、关单得 20902 recon_diff；关单成则调账得 20902 recon_diff 且不留痕（没有单、凭证、余额变动、关联行、adjustment_create）', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await withCloseAdmin(f, async (c) => {
      await schemaReady(f.db);
      const userId = await member(f, { available: 1000n });
      const diff = await seedTicket(f);
      const before = { trace: await trace(f), links: await linksOf(f) };

      const lock = await holdRow(f, 'recon_diffs', diff.id);
      const adjusting = track(send(h, { userId, refs: [diffRef(diff)] }));
      const closing = track(c.close(diff.id, { reason: '核对无误，关闭' }));
      await bothWaiting(f, lock, [adjusting, closing]);
      const adjusted = await adjusting.promise;
      const shut = await closing.promise;
      const label = `${adjusted.body}\n${shut.body}`;
      expect(codesOf([adjusted, shut]), label).toEqual([0, 20902]);

      if (adjusted.json().code === 0) {
        await answer(adjusted, 0);
        await closeConflict(shut);
        await expectNowAdjusted(f, diff, h.maker.id);
        expect(await linksOf(f)).toHaveLength(1);
        expect(await audits(f, CREATE_ACTION)).toHaveLength(1);
      } else {
        await closed(shut);
        await diffConflict(adjusted);
        expect((await diffNow(f, diff.id)).status).toBe('closed');
        expect({ trace: await trace(f), links: await linksOf(f) }).toEqual(before);
        expect(await audits(f, CREATE_ACTION)).toEqual([]);
      }
    });
  });
});
