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
  member,
  moneyOf,
  newKey,
  suite,
  withAdjustAdmin,
  type FaultPoint,
} from '../admin-adjustments/kit.ts';
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

const s = suite();

const POINTS: readonly FaultPoint[] = ['audit', 'inbox'];

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
