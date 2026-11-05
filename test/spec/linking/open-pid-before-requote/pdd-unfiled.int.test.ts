import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  databaseFixture,
  expectFilingRefusal,
  fixture,
  injectRecheck,
  openWith,
  outcome,
  pddSlots,
  response,
  slotSceneOf,
  type Fixture,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

/**
 * D10-654: the account in use has no active slot of the scene → 50301 data.reason=maintenance,
 * no authorization session; no re-check, no conversion, bindings unchanged, one 50301 log row.
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

// Not filed: no unreleased binding, or one that is pending_auth / invalid; the filing double
// answers "not authorized" whenever it is asked. Both accounts lose the scene's slot, so the
// answer does not depend on which account the authorization uses. Without the slot the filing is
// not queried at all (D10-262 / D10-263: local configuration before external calls), and no
// authorization link can be generated for a slot that does not exist: the open answers 50301
// maintenance and writes no state (D10-654). With the slot it is queried once and answers 30111.
for (const binding of ['absent', 'pending_auth', 'invalid'] as const) {
  for (const scene of ['detail', 'agent'] as const) {
    it(
      `[AC-B1-22n#5] 拼多多 ${binding}/${scene} 未备案且所用账号无该场景 active 推广位：不调用备案查询、回 50301 maintenance（D10-654）、不写授权会话，不复核、不调用任何联盟接口；有推广位时查一次备案、回 30111`,
      async () => {
        const db = database();
        const f = await fixture(db, { binding, query: false, scene });
        await injectRecheck(f, 'off_shelf');
        const missing = slotSceneOf(scene);
        const slots = await pddSlots(db, f, [
          { account: 'a', scene: missing },
          { account: 'b', scene: missing },
        ]);
        const before = await f.bindings();
        const stopped = openWith(f, slots.pids);
        await expectMaintenance(f, await outcome(() => stopped.service.open(f.request())), before);
        expect(f.query).not.toHaveBeenCalled();
        expect(stopped.external).toEqual([]);

        const g = await fixture(db, { binding, query: false, scene });
        await injectRecheck(g, 'off_shelf');
        const kept = openWith(g, (await pddSlots(db, g)).pids);
        const unchanged = await g.bindings();
        await expectFilingRefusal(
          g,
          await outcome(() => kept.service.open(g.request())),
          unchanged,
        );
        expect(g.query).toHaveBeenCalledTimes(1);
        // B1-06zf (D10-659 ④): the 30111 authorization link comes from the union's pddAuthorityUrl.
        const filing = new Set(['queryPddAuthority', 'pddAuthorityUrl']);
        expect(kept.external.filter((name) => !filing.has(name))).toEqual([]);
      },
      TIMEOUT,
    );
  }
}
