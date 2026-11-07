// B1-28s deletion rule test (claude-independent, SPEC_REF 18f0015e): adminListProductFeedbacks
// (CT-26x: feedbacks of users whose account deletion completed have been deleted and never appear;
// a guest record is tied to no account) with 08 BR-ID-28 删除清单「商品反馈记录」 and BR-ID-30 细则
// 「商品反馈记录」 留存. The deletion goes through B1-28p's cleanup step deleteFeedbackForUser (the
// feedback module's index, as identity's cleanup runs it: users row locked, status deleting, then
// deleted). Requests go through the real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { deleteFeedbackForUser } from '../../../../apps/api/src/modules/feedback/index.ts';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import {
  ago,
  fixture,
  newestFirst,
  normalize,
  page,
  seedFeedbacks,
  seedMember,
  suite,
  view,
  withFeedbackAdmin,
  type Fixture,
} from './kit.ts';

const s = suite();

async function setStatus(f: Fixture, userId: string, status: string): Promise<void> {
  await sql`UPDATE app.users SET status = ${status}, row_version = row_version + 1
    WHERE app_id = ${f.appId} AND id = ${userId}::uuid`.execute(f.db);
}

it('[AC-B1-28s#10] 注销：用户注销完成（经 B1-28p 的注销清理步骤删掉其名下反馈）后，其反馈不再出现、不计入 total（按其原因筛选也不出现）；同设备与别的设备上的游客记录、别的用户的记录仍在且原样', async () => {
  const f = fixture(s);
  const leaving = await seedMember(f);
  const staying = await seedMember(f);
  const device = randomUUID();
  const elsewhere = randomUUID();
  const [own1, own2, guestSame, guestOther, others] = await seedFeedbacks(f, [
    { createdAt: ago(f, 50), deviceId: device, userId: leaving.id, reason: 'rebate' },
    { createdAt: ago(f, 40), deviceId: elsewhere, userId: leaving.id, reason: 'info' },
    { createdAt: ago(f, 30), deviceId: device, userId: null, reason: 'rebate' },
    { createdAt: ago(f, 20), deviceId: elsewhere, userId: null, reason: 'price' },
    { createdAt: ago(f, 10), deviceId: device, userId: staying.id, reason: 'other' },
  ]);
  const before = [own1!, own2!, guestSame!, guestOther!, others!];
  const after = [guestSame!, guestOther!, others!];
  await withFeedbackAdmin(f, async (h) => {
    const listed = await page(await h.list());
    expect(listed.total).toBe(before.length);
    expect(listed.items.map(normalize)).toEqual(newestFirst(before).map(view));

    await setStatus(f, leaving.id, 'deleting');
    await f.db.transaction().execute(async (trx) => {
      const locked = await lockUsersForUpdate(trx, { appId: f.appId, userIds: [leaving.id] });
      expect([...locked]).toEqual([leaving.id]);
      await deleteFeedbackForUser(trx, { appId: f.appId, userId: leaving.id, at: f.clock.now() });
    });
    await setStatus(f, leaving.id, 'deleted');

    const remaining = await page(await h.list());
    expect(remaining.total).toBe(after.length);
    expect(remaining.items.map(normalize)).toEqual(newestFirst(after).map(view));
    expect(remaining.items.filter((item) => item['user_id'] === leaving.id)).toEqual([]);
    expect(remaining.items.filter((item) => item['user_id'] === null)).toHaveLength(2);

    const info = await page(await h.list({ reason: 'info' }));
    expect({ total: info.total, items: info.items }).toEqual({ total: 0, items: [] });
    const rebate = await page(await h.list({ reason: 'rebate' }));
    expect(rebate.items.map(normalize)).toEqual([view(guestSame!)]);
    expect(rebate.total).toBe(1);
  });
});
