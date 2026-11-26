// BR-FUND-24 ⑨ ties every linked diff to the same transaction as the adjustment or reversal.
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
  type AdjustAdmin,
  type AdjustFixture,
  type Adjusted,
  type Direction,
  type Expectation,
} from '../../admin-adjustments/kit.ts';
import {
  diffRef,
  expectNowAdjusted,
  expectNowProcessing,
  expectSentBack,
  expectationOf,
  fileOk,
  fixBody,
  footprint,
  linkOf,
  linksOf,
  schemaReady,
  seedTicket,
  sortedLinks,
  tick,
} from '../kit.ts';
import { withWriteFault } from './kit-fault.ts';

const s = suite();

interface Submission {
  readonly body: Record<string, unknown>;
  readonly expected: Expectation;
  verify(adjusted: Adjusted): Promise<void>;
}

async function sweepWriteFailures(
  f: AdjustFixture,
  h: AdjustAdmin,
  attempt: ReturnType<typeof withWriteFault>['attempt'],
  prepare: () => Promise<Submission>,
): Promise<void> {
  for (const point of ['link', 'diff'] as const) {
    for (let ordinal = 1; ; ordinal += 1) {
      const { body, expected, verify } = await prepare();
      const before = await footprint(f);
      const key = newKey();
      const submit = () => h.create(body, { key });
      const { sent, hits } = await attempt(point, ordinal, submit);
      const label = `${point} 第 ${ordinal} 次写入`;
      expect(hits[point], `${label}：提交中必须执行该类写入`).toBeGreaterThanOrEqual(1);

      const failed = sent.statusCode === 500;
      if (failed) {
        expect(hits[point], `${label}：命中故障序号`).toBeGreaterThanOrEqual(ordinal);
        await answer(sent, 50001);
        expect(await footprint(f), `${label} 失败后整笔回滚`).toEqual(before);
      } else {
        expect(hits[point], `${label}：正常提交不得经过故障点`).toBeLessThan(ordinal);
      }
      const success = failed ? await submit() : sent;
      const adjusted = await expectAdjusted(f, success, expected);
      await verify(adjusted);

      const after = await footprint(f);
      expect(after.trace.forms, `${label}：只新增一张调账单`).toHaveLength(
        before.trace.forms.length + 1,
      );
      expect(after.trace.vouchers, `${label}：只新增一张凭证`).toHaveLength(
        before.trace.vouchers.length + 1,
      );
      const replay = await submit();
      expect(replay.body, `${label}：同键重放的应答`).toBe(success.body);
      expect(await footprint(f), `${label}：重放不留痕`).toEqual(after);
      tick(f);

      // Every reached ordinal is injected and asserted, including the second for per-row writes.
      // A batched write finishes the sweep at a lower ordinal and must succeed on that request.
      if (!failed) break;
    }
  }
}

async function checkNewForm(direction: Direction, listed: boolean): Promise<void> {
  const f = fixture(s);
  const fault = withWriteFault(f);
  await schemaReady(f.db);
  await withAdjustAdmin(fault.fixture, async (h) => {
    const userId = await member(f, { available: 3000n });
    const users = listed ? [userId, await member(f, { available: 3000n })] : undefined;

    await sweepWriteFailures(f, h, fault.attempt, async () => {
      const first = await seedTicket(f);
      const second = await seedTicket(f, users === undefined ? {} : { users });
      const filing = { userId, direction, amount: 300n, refs: [diffRef(first), diffRef(second)] };
      return {
        body: fixBody(filing),
        expected: await expectationOf(f, h, filing),
        async verify({ row }) {
          await expectNowAdjusted(f, first, h.maker.id);
          if (listed) await expectNowProcessing(f, second);
          else await expectNowAdjusted(f, second, h.maker.id);
          const links = (await linksOf(f)).filter((link) => link.adjust_id === row.adjust_id);
          expect(links).toEqual(
            sortedLinks([first, second].map((diff) => linkOf(f, row.adjust_id, diff.id, userId))),
          );
        },
      };
    });
  });
}

it('[AC-B2-17b#1] 调增 300 分关联两张无名单差错单，任一关联或状态写入失败即整笔回滚，同键重发只生效一次且两张都结案', async () => {
  await checkNewForm('increase', false);
});

it('[AC-B2-17b#2] 调减 300 分关联两张差错单，其中一张尚有会员待调账，任一关联或状态写入失败即整笔回滚，同键重发后分别结案和处理中', async () => {
  await checkNewForm('decrease', true);
});

it('[AC-B2-17b#3] 整笔红冲关联两张已结案差错单的原单，任一标记或退回写入失败即整笔回滚，同键重发后两张均退回且两行均标记红冲', async () => {
  const f = fixture(s);
  const fault = withWriteFault(f);
  await schemaReady(f.db);
  await withAdjustAdmin(fault.fixture, async (h) => {
    const userId = await member(f, { available: 3000n });
    await sweepWriteFailures(f, h, fault.attempt, async () => {
      const first = await seedTicket(f);
      const second = await seedTicket(f);
      const original = await fileOk(f, h, {
        userId,
        amount: 300n,
        refs: [diffRef(first), diffRef(second)],
      });
      const adjusted = [
        await expectNowAdjusted(f, first, h.maker.id),
        await expectNowAdjusted(f, second, h.maker.id),
      ];
      const originalId = original.row.adjust_id;
      const originalLinks = sortedLinks(
        adjusted.map(({ id }) => linkOf(f, originalId, id, userId)),
      );
      const linksForOriginal = async () =>
        (await linksOf(f)).filter((link) => link.adjust_id === originalId);
      expect(await linksForOriginal()).toEqual(originalLinks);
      tick(f);

      const note = '核对有误，整笔冲回';
      return {
        body: { reverses_adjust_id: originalId, note },
        expected: {
          caller: h.maker,
          userId,
          direction: 'decrease',
          amount: 300n,
          reason: original.row.reason_code,
          contra: original.row.contra_subject,
          refs: [],
          note,
          reverses: original.row,
          before: await moneyOf(f, userId),
        },
        async verify({ row }) {
          for (const diff of adjusted) await expectSentBack(f, diff);
          expect(await linksForOriginal()).toEqual(
            originalLinks.map((link) => ({ ...link, reversed_by_adjust_id: row.adjust_id })),
          );
          expect((await linksOf(f)).filter((link) => link.adjust_id === row.adjust_id)).toEqual([]);
        },
      };
    });
  });
});
