import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createPddAuthLinkOpen } from '../../../../apps/api/src/modules/linking/application/link-open-pdd-auth.ts';
import { fixture } from '../../linking/open-pdd-auth/kit.ts';
import { accountSlots, databaseFixture, outcome } from './kit.ts';

const database = databaseFixture(createTestDatabase);

for (const binding of ['active', 'pending_auth', 'invalid'] as const) {
  for (const scene of ['detail', 'share', 'agent'] as const) {
    it(`[AC-B1-19d#7] 拼多多 ${binding}/${scene}: 查询备案和转链均用绑定账号 A 的推广位`, async () => {
      const db = database();
      const f = await fixture(db, { binding, query: true, scene });
      const slots = await accountSlots(db, f.appId, 'pdd', f.accountId);
      // B1-06zj (BR-ID-22): an active binding has the scene pid filed (the slot selected below);
      // seed only, no assertion changed.
      if (binding === 'active') {
        await db
          .insertInto('union_pdd_pid_filings')
          .values({
            id: randomUUID(),
            app_id: f.appId,
            user_id: f.a.userId,
            pid: slots.a[scene === 'agent' ? 'agent' : 'self_buy'].pid,
            union_account_id: f.accountId,
            platform: 'pdd',
            filed_at: f.clock.now(),
          })
          .execute();
      }
      const service = createPddAuthLinkOpen({ ...f.options, pids: slots.pids });
      const result = await outcome(() => service.open(f.request()));
      // BR-ATTR-11: A opening his own share link is re-registered as self_buy (decideOpenOwner).
      const selected = scene === 'agent' ? 'agent' : 'self_buy';
      expect(result).toMatchObject({ status: 200, envelope: { code: 0 } });
      expect(f.convert).toHaveBeenCalledTimes(1);
      expect(f.convert.mock.calls[0]?.[1]).toMatchObject({
        claims: { promotionSlot: slots.a[selected].pid },
        custom_parameters: { app: 'n', uid: f.a.attr, sc: selected },
      });
      if (binding === 'active') expect(f.query).not.toHaveBeenCalled();
      else {
        expect(f.query).toHaveBeenCalledTimes(1);
        expect(f.query.mock.calls[0]?.[0]).toMatchObject({
          claims: { promotionSlot: slots.a[selected].pid },
          custom_parameters: { app: 'n', uid: f.a.attr, sc: selected },
        });
      }
      expect(await f.bindings()).toEqual([
        expect.objectContaining({
          id: f.bindingId,
          status: 'active',
          union_account_id: f.accountId,
        }),
      ]);
      expect(slots.pids.getActivePid).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: f.appId,
          platform: 'pdd',
          pidScene: selected,
          unionAccountId: f.accountId,
        }),
      );
    }, 30_000);
  }
}

for (const binding of ['active', 'invalid', 'blocked'] as const) {
  it(`[AC-B1-19d#8] 拼多多 no_rebate/${binding}: 按所用账号取 self_buy 位，无用户参数和备案查询`, async () => {
    const db = database();
    const f = await fixture(db, { binding, query: true, scene: 'share' });
    const slots = await accountSlots(db, f.appId, 'pdd', f.accountId);
    const service = createPddAuthLinkOpen({ ...f.options, pids: slots.pids });
    const result = await outcome(() => service.open(f.request({ noRebate: true })));
    expect(result).toMatchObject({ envelope: { code: 0 } });
    expect(f.convert).toHaveBeenCalledTimes(1);
    const identity = f.convert.mock.calls[0]?.[1];
    expect(identity).toMatchObject({
      claims: {
        promotionSlot: slots.a.self_buy.pid,
        relationId: null,
        userId: 'no_rebate',
      },
    });
    expect(identity).not.toHaveProperty('custom_parameters.uid');
    expect(identity).not.toHaveProperty('subUnionId');
    expect(f.query).not.toHaveBeenCalled();
    expect(slots.pids.getActivePid).toHaveBeenCalledWith(
      expect.objectContaining({
        pidScene: 'self_buy',
        unionAccountId: f.accountId,
      }),
    );
    if (binding === 'active') {
      await db
        .updateTable('union_bindings')
        .set({ status: 'released', released_at: f.clock.now(), cooldown_until: f.clock.now() })
        .where('app_id', '=', f.appId)
        .where('id', '=', f.bindingId!)
        .execute();
      f.convert.mockClear();
      const unbound = await outcome(() => service.open(f.request({ noRebate: true })));
      expect(unbound).toMatchObject({ envelope: { code: 0 } });
      expect(f.convert).toHaveBeenCalledTimes(1);
      expect(f.convert.mock.calls[0]?.[1]).toMatchObject({
        claims: { promotionSlot: slots.b.self_buy.pid, userId: 'no_rebate' },
      });
      expect(f.convert.mock.calls[0]?.[1]).not.toHaveProperty('custom_parameters.uid');
      expect(f.query).not.toHaveBeenCalled();
    }
  }, 30_000);
}

it('[AC-B1-19d#9] 拼多多指定账号没有该场景位时停止，不借用 B 或 self_buy', async () => {
  const db = database();
  const f = await fixture(db, { binding: 'active', query: true, scene: 'share' });
  const slots = await accountSlots(db, f.appId, 'pdd', f.accountId);
  await db
    .updateTable('union_pids')
    .set({ status: 'retired' })
    .where('app_id', '=', f.appId)
    .where('id', '=', slots.a.share.id)
    .execute();
  const service = createPddAuthLinkOpen({ ...f.options, pids: slots.pids });
  // Another user opens A's share link (BR-ATTR-11: A himself would be re-registered as self_buy).
  f.opener('b');
  const result = await outcome(() => service.open(f.request()));
  expect(result).toMatchObject({ envelope: { code: 50301 } });
  expect(result).not.toHaveProperty('envelope.data.jump');
  expect(f.convert).not.toHaveBeenCalled();
  expect(f.query).not.toHaveBeenCalled();
}, 30_000);
