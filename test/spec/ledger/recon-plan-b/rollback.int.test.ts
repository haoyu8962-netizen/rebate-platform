// B2-17 one transaction (claude-independent): BR-FUND-24 ⑨ (在批准的同一事务内锁定所关联的每张差错单，以
// CAS 置为 adjusted; 红冲该调账单时同一事务把差错单退回 processing) and §9.3 ⑪ of the task: when a later
// step of the submission fails (kit fault: the audit insert or the in-app message insert → 50001), the
// diff rows and the link rows roll back with everything else; the same Idempotency-Key then takes
// effect once. Covers a new decrease and the reversal of an increase (a decrease of the balance).
import { expect, it } from 'vitest';
import {
  answer,
  expectAdjusted,
  fixture,
  holdMember,
  member,
  moneyOf,
  newKey,
  suite,
  track,
  waiting,
  withAdjustAdmin,
  type AdjustFixture,
  type FaultPoint,
  type HeldLock,
} from '../admin-adjustments/kit.ts';
import { holdRow } from '../admin-recon-close/kit.ts';
import {
  diffNow,
  diffRef,
  expectNowAdjusted,
  expectSentBack,
  expectationOf,
  fileOk,
  fixBody,
  footprint,
  linkOf,
  linksOf,
  schemaReady,
  seedTicket,
  tick,
} from './kit.ts';
import { holdLinks } from './kit-more.ts';

const s = suite();

const POINTS: readonly FaultPoint[] = ['audit', 'inbox'];

/** What another connection holds while the request runs. */
type Holder = 'diff' | 'member' | 'links';

/** Takes the row lock `holder` names from the suite's second pool. */
function hold(
  f: AdjustFixture,
  holder: Holder,
  target: { readonly diffId: string; readonly userId: string; readonly adjustId?: string },
): Promise<HeldLock> {
  if (holder === 'diff') return holdRow(f, 'recon_diffs', target.diffId);
  if (holder === 'member') return holdMember(f, target.userId);
  if (target.adjustId === undefined) throw new Error('holding link rows needs the form');
  return holdLinks(f, target.adjustId);
}

it('[AC-B2-17#17] 关联差错单的调减提交时写审计或写站内信失败 → 50001，差错单行与关联表同其余东西一起回滚（不留痕）；同一 Idempotency-Key 重发一次生效：差错单 adjusted、一行关联', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const userId = await member(f, { available: 3000n });
    for (const point of POINTS) {
      const diff = await seedTicket(f);
      const filing = { userId, direction: 'decrease', refs: [diffRef(diff)] } as const;
      const expectation = await expectationOf(f, h, filing);
      const before = await footprint(f);
      const key = newKey();
      const tripped = h.fault.tripped;
      h.fault.point = point;
      const sent = await h.create(fixBody(filing), { key });
      expect(h.fault.tripped, `${point} 必须在提交事务里执行`).toBe(tripped + 1);
      await answer(sent, 50001);
      expect(await footprint(f), point).toEqual(before);

      const retried = await h.create(fixBody(filing), { key });
      const done = await expectAdjusted(f, retried, expectation);
      await expectNowAdjusted(f, diff, h.maker.id);
      const links = (await linksOf(f)).filter((row) => row.recon_diff_id === diff.id);
      expect(links, point).toEqual([linkOf(f, done.row.adjust_id, diff.id, userId)]);
      tick(f);
    }
  });
});

it('[AC-B2-17#18] 红冲关联了差错单的调增单（即调减）时写审计或写站内信失败 → 50001，关联行仍未红冲、差错单仍 adjusted（不留痕）；同一 key 重发一次生效：关联行写上红冲单号、差错单退回 processing', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const userId = await member(f, { available: 3000n });
    for (const point of POINTS) {
      const diff = await seedTicket(f);
      const original = await fileOk(f, h, { userId, refs: [diffRef(diff)], amount: 300n });
      const filedAt = f.clock.now();
      const adjusted = await diffNow(f, diff.id);
      expect(adjusted.status).toBe('adjusted');
      tick(f);

      const note = `整笔冲回（${point}）`;
      const body = { reverses_adjust_id: original.row.adjust_id, note };
      const money = await moneyOf(f, userId);
      const before = await footprint(f);
      const key = newKey();
      const tripped = h.fault.tripped;
      h.fault.point = point;
      const sent = await h.create(body, { key });
      expect(h.fault.tripped, `${point} 必须在红冲事务里执行`).toBe(tripped + 1);
      await answer(sent, 50001);
      expect(await footprint(f), point).toEqual(before);

      const reversal = await expectAdjusted(f, await h.create(body, { key }), {
        caller: h.maker,
        userId,
        direction: 'decrease',
        amount: 300n,
        reason: original.row.reason_code,
        contra: original.row.contra_subject,
        refs: [],
        note: body.note,
        reverses: original.row,
        before: money,
      });
      await expectSentBack(f, adjusted);
      const id = original.row.adjust_id;
      const mark = reversal.row.adjust_id;
      const links = (await linksOf(f)).filter((row) => row.recon_diff_id === diff.id);
      expect(links, point).toEqual([linkOf(f, id, diff.id, userId, mark, filedAt)]);
      tick(f);
    }
  });
});

it('[AC-B2-17#32] 新单的写钱与差错单、关联行同一事务提交：差错单行或会员行被另一连接锁住、请求在等的期间，别的连接读到的调账单、凭证、分录、余额、事件、站内信、通知日志、审计、关联表、差错单与提现冻结都与发请求前相同；放开后 200、各项一次生效（差错单 adjusted、一行关联），同一 Idempotency-Key 重放得到同一应答、不再留痕', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const userId = await member(f, { available: 3000n });
    for (const holder of ['diff', 'member'] as const) {
      const diff = await seedTicket(f);
      const filing = { userId, direction: 'decrease', refs: [diffRef(diff)] } as const;
      const expectation = await expectationOf(f, h, filing);
      const before = await footprint(f);
      const key = newKey();
      const lock = await hold(f, holder, { diffId: diff.id, userId });
      const pending = track(h.create(fixBody(filing), { key }));
      try {
        expect(await waiting(f, 1, [pending]), `${holder}：请求应在行锁上等待`).toBe(true);
        expect(await footprint(f), `${holder}：等待期间`).toEqual(before);
      } finally {
        await lock.release();
      }
      const sent = await pending.promise;
      const done = await expectAdjusted(f, sent, expectation);
      await expectNowAdjusted(f, diff, h.maker.id);
      const links = (await linksOf(f)).filter((row) => row.recon_diff_id === diff.id);
      expect(links, holder).toEqual([linkOf(f, done.row.adjust_id, diff.id, userId)]);

      const after = await footprint(f);
      const replay = await h.create(fixBody(filing), { key });
      expect(replay.body, `${holder}：重放`).toBe(sent.body);
      expect(await footprint(f), `${holder}：重放不留痕`).toEqual(after);
      tick(f);
    }
  });
});

it('[AC-B2-17#33] 红冲的写钱与关联行标记、差错单退回同一事务提交：原单的关联行、差错单行或会员行被另一连接锁住、红冲请求在等的期间，别的连接读到的红冲单、凭证、分录、余额、事件、站内信、通知日志、审计、关联表、差错单与提现冻结都与发请求前相同；放开后 200、各项一次生效（关联行写上红冲单号、差错单退回 processing），同一 key 重放得到同一应答、不再留痕', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const userId = await member(f, { available: 3000n });
    const holders: readonly Holder[] = ['links', 'diff', 'member'];
    for (const holder of holders) {
      const diff = await seedTicket(f);
      const original = await fileOk(f, h, { userId, refs: [diffRef(diff)], amount: 300n });
      const filedAt = f.clock.now();
      const adjusted = await diffNow(f, diff.id);
      expect(adjusted.status).toBe('adjusted');
      tick(f);

      const note = `整笔冲回（${holder}）`;
      const body = { reverses_adjust_id: original.row.adjust_id, note };
      const money = await moneyOf(f, userId);
      const before = await footprint(f);
      const key = newKey();
      const lock = await hold(f, holder, {
        diffId: diff.id,
        userId,
        adjustId: original.row.adjust_id,
      });
      const pending = track(h.create(body, { key }));
      try {
        expect(await waiting(f, 1, [pending]), `${holder}：红冲应在行锁上等待`).toBe(true);
        expect(await footprint(f), `${holder}：等待期间`).toEqual(before);
      } finally {
        await lock.release();
      }
      const sent = await pending.promise;
      const reversal = await expectAdjusted(f, sent, {
        caller: h.maker,
        userId,
        direction: 'decrease',
        amount: 300n,
        reason: original.row.reason_code,
        contra: original.row.contra_subject,
        refs: [],
        note: body.note,
        reverses: original.row,
        before: money,
      });
      await expectSentBack(f, adjusted);
      const id = original.row.adjust_id;
      const mark = reversal.row.adjust_id;
      const links = (await linksOf(f)).filter((row) => row.recon_diff_id === diff.id);
      expect(links, holder).toEqual([linkOf(f, id, diff.id, userId, mark, filedAt)]);

      const after = await footprint(f);
      const replay = await h.create(body, { key });
      expect(replay.body, `${holder}：重放`).toBe(sent.body);
      expect(await footprint(f), `${holder}：重放不留痕`).toEqual(after);
      tick(f);
    }
  });
});
