// B2-17 the backfilled link rows at the admin entry (claude-independent): BR-FUND-24 ⑨ with §12.1 ⑥
// of the task (编排 D10-3237 (一), D10-3239; resource evaluation round 1 S0: without the backfill a
// member could be adjusted twice on one diff after the upgrade). After the migration's backfill
// statement (taken from the file, run once in this file's database as couli_app) a form executed
// before the migration counts as the member's executed, not reversed form on its diffs: the same
// member on such a diff (still open) → 20902 recon_diff, no trace; another member is accepted;
// reversing the old form marks its backfilled rows and leaves its diffs as they are (not adjusted),
// after which the member may file again.
import { expect, it } from 'vitest';
import {
  ago,
  fixture,
  member,
  seedForm,
  suite,
  withAdjustAdmin,
} from '../admin-adjustments/kit.ts';
import { OK, runBackfill, theBackfill } from './kit-backfill.ts';
import {
  diffConflict,
  diffRef,
  expectNowAdjusted,
  expectUnchanged,
  fileOk,
  footprint,
  linkOf,
  linksOf,
  reverseOk,
  schemaReady,
  seedTicket,
  send,
  sortedLinks,
  tick,
} from './kit.ts';

const s = suite();

it('[AC-B2-17#40] 回填之后经后台入口：同一会员对回填过的差错单（仍 open）再提交 → 20902 recon_diff、不留痕；别的会员对它提交照常受理（没有名单 → adjusted）；红冲那张存量调账单 → 200，回填的行写上 reversed_by_adjust_id，差错单不是 adjusted 所以不动；之后该会员可以再提交，执行后 adjusted', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const statement = theBackfill();
    const u1 = await member(f, { available: 5000n });
    const u2 = await member(f, { available: 5000n });
    const held = await seedTicket(f);
    const spared = [await seedTicket(f), await seedTicket(f)];
    const first = await seedForm(f, {
      userId: u1,
      refs: [diffRef(held)],
      createdAt: ago(f, 120),
    });
    const second = await seedForm(f, {
      userId: u1,
      refs: spared.map(diffRef),
      createdAt: ago(f, 90),
    });

    expect(await runBackfill(f.db, statement), '回填语句不报错').toEqual(OK);
    const firstLink = linkOf(f, first.adjust_id, held.id, u1, null, first.reviewed_at!);
    const secondAt = second.reviewed_at!;
    const secondLinks = spared.map((diff) =>
      linkOf(f, second.adjust_id, diff.id, u1, null, secondAt),
    );
    expect(await linksOf(f)).toEqual(sortedLinks([firstLink, ...secondLinks]));
    for (const diff of [held, ...spared]) await expectUnchanged(f, diff);

    const before = await footprint(f);
    for (const direction of ['increase', 'decrease'] as const) {
      await diffConflict(await send(h, { userId: u1, direction, refs: [diffRef(held)] }));
    }
    expect(await footprint(f), '同一会员再提交不留痕').toEqual(before);
    await expectUnchanged(f, held);

    const other = await fileOk(f, h, { userId: u2, refs: [diffRef(held)] });
    await expectNowAdjusted(f, held, h.maker.id);
    const otherLink = linkOf(f, other.row.adjust_id, held.id, u2);
    tick(f);

    const reversal = await reverseOk(f, h, second);
    for (const diff of spared) await expectUnchanged(f, diff);
    const mark = reversal.row.adjust_id;
    const marked = spared.map((diff) => linkOf(f, second.adjust_id, diff.id, u1, mark, secondAt));
    expect(await linksOf(f)).toEqual(sortedLinks([firstLink, otherLink, ...marked]));
    tick(f);

    const again = await fileOk(f, h, { userId: u1, refs: [diffRef(spared[0]!)] });
    await expectNowAdjusted(f, spared[0]!, h.maker.id);
    await expectUnchanged(f, spared[1]!);
    const fresh = linkOf(f, again.row.adjust_id, spared[0]!.id, u1);
    expect(await linksOf(f)).toEqual(sortedLinks([firstLink, otherLink, ...marked, fresh]));
  });
});
