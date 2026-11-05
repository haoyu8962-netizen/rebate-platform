import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  RECHECKS,
  TIMEOUT,
  databaseFixture,
  expectRecheckDecided,
  expectStoppedBeforeRecheck,
  fixture,
  injectRecheck,
  openWith,
  outcome,
  pddSlots,
  response,
  slotSceneOf,
  type Fixture,
  type SlotScene,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

/**
 * D10-654 ([AC-B1-22n#6]): the account in use has no active slot of the scene → 50301
 * data.reason=maintenance, no authorization session; no re-check, no conversion, bindings
 * unchanged, one 50301 log row.
 */
async function expectMaintenance(f: Fixture, result: unknown, before: unknown) {
  const value = await response(result, 50301, 503);
  expect(value.envelope.data).toEqual({ reason: 'maintenance' });
  expect(await f.sessions()).toEqual([]);
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.quote).not.toHaveBeenCalled();
  expect(f.convert).not.toHaveBeenCalled();
  expect(await f.attempts()).toEqual([]);
  expect(await f.bindings()).toEqual(before);
  expect(await f.logs()).toEqual([
    expect.objectContaining({ link_id: f.row.link_id, result_code: 50301 }),
  ]);
}

// A's active binding is on account A; account B keeps every slot (never borrowed, BR-ATTR-05 ⑦).
const CASES = [
  { scene: 'detail', opener: 'a' },
  { scene: 'agent', opener: 'a' },
  { scene: 'share', opener: 'b' },
] as const;

for (const { scene, opener } of CASES) {
  for (const { recheck, withSlot } of RECHECKS) {
    it(
      `[AC-B1-22n#3] 拼多多 active ${scene}/${opener} 所用账号无该场景 active 推广位：先回 50301、不做价格复核（复核注入 ${recheck}）；有推广位时照旧复核得 ${withSlot}`,
      async () => {
        const db = database();
        const f = await fixture(db, { binding: 'active', query: true, scene });
        f.opener(opener);
        await injectRecheck(f, recheck);
        const slots = await pddSlots(db, f, [{ account: 'a', scene: slotSceneOf(scene) }]);
        const stopped = openWith(f, slots.pids);
        await expectStoppedBeforeRecheck(f, await outcome(() => stopped.service.open(f.request())));
        expect(f.query).not.toHaveBeenCalled();
        expect(stopped.external).toEqual([]);

        const g = await fixture(db, { binding: 'active', query: true, scene });
        g.opener(opener);
        await injectRecheck(g, recheck);
        const kept = openWith(g, (await pddSlots(db, g)).pids);
        expectRecheckDecided(g, await outcome(() => kept.service.open(g.request())), withSlot);
      },
      TIMEOUT,
    );
  }
}

// blocked: an explicit no_rebate purchase goes through ⑥ (BR-ID-18, no_rebate_reason
// binding_blocked) and stops at ⑦ like the others; the 50301 row keeps the server's reason.
for (const binding of ['active', 'pending_auth', 'blocked'] as const) {
  it(
    `[AC-B1-22n#4] 拼多多 no_rebate/${binding} 改用所用账号的 self_buy 位：无 active 时先回 50301、不复核、不查备案，不沿用 agent 位；有 self_buy 位时照旧复核`,
    async () => {
      const db = database();
      const f = await fixture(db, { binding, query: true, scene: 'agent' });
      await injectRecheck(f, 'off_shelf');
      const slots = await pddSlots(db, f, [{ account: 'a', scene: slotSceneOf('agent', true) }]);
      const stopped = openWith(f, slots.pids);
      await expectStoppedBeforeRecheck(
        f,
        await outcome(() => stopped.service.open(f.request({ noRebate: true }))),
      );
      expect(f.query).not.toHaveBeenCalled();
      expect(stopped.external).toEqual([]);
      expect(await f.sessions()).toEqual([]);
      if (binding === 'blocked') {
        expect(await f.logs()).toEqual([
          expect.objectContaining({
            result_code: 50301,
            no_rebate: true,
            no_rebate_reason: 'binding_blocked',
          }),
        ]);
      }

      const g = await fixture(db, { binding, query: true, scene: 'agent' });
      await injectRecheck(g, 'off_shelf');
      const kept = openWith(g, (await pddSlots(db, g)).pids);
      expectRecheckDecided(
        g,
        await outcome(() => kept.service.open(g.request({ noRebate: true }))),
        30141,
      );
      expect(g.query).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );
}

// Filed on the platform side: the binding is not active (or there is none) and the filing double
// would answer authorized. Without an active slot of the scene on the account in use the filing is
// not queried (D10-262 / D10-263) and no authorization link can be generated for a slot that does
// not exist: the open answers 50301 maintenance with no authorization session (D10-654); nothing
// is activated, no other scene's slot is borrowed for the query, and the next open after the slot
// is configured queries and activates. With a binding that account is A (B keeps its slot, never
// borrowed). With none it is the account of the earliest active self_buy slot (B), and retiring
// only B's self_buy would move it to A, so both accounts lose the scene's slot there. With the
// slot nothing changes.
for (const binding of ['absent', 'pending_auth', 'invalid'] as const) {
  for (const scene of ['detail', 'agent'] as const) {
    for (const { recheck, withSlot } of RECHECKS) {
      it(
        `[AC-B1-22n#6] 拼多多 ${binding}/${scene} 平台侧已备案但绑定非 active、所用账号无该场景 active 推广位：不查备案、回 50301 maintenance（D10-654）、不写授权会话、不复核、绑定不变（复核注入 ${recheck}）；有推广位时照旧查一次备案、复核得 ${withSlot}`,
        async () => {
          const db = database();
          const f = await fixture(db, { binding, query: true, scene });
          await injectRecheck(f, recheck);
          const missing = slotSceneOf(scene);
          const retire: { account: 'a' | 'b'; scene: SlotScene }[] = [
            { account: 'a', scene: missing },
          ];
          if (binding === 'absent') retire.push({ account: 'b', scene: missing });
          const slots = await pddSlots(db, f, retire);
          const before = await f.bindings();
          const stopped = openWith(f, slots.pids);
          await expectMaintenance(
            f,
            await outcome(() => stopped.service.open(f.request())),
            before,
          );
          expect(f.query).not.toHaveBeenCalled();
          expect(stopped.external).toEqual([]);

          const g = await fixture(db, { binding, query: true, scene });
          await injectRecheck(g, recheck);
          const kept = openWith(g, (await pddSlots(db, g)).pids);
          expectRecheckDecided(g, await outcome(() => kept.service.open(g.request())), withSlot);
          expect(g.query).toHaveBeenCalledTimes(1);
        },
        TIMEOUT,
      );
    }
  }
}
