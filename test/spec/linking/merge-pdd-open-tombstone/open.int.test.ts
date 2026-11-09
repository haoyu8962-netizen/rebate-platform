// B1-06zk #1 (FU-MERGE-PDD-OPEN-TOMBSTONE, D10-1123): the user's own Pinduoduo open whose binding
// is not active and whose query answers filed, the user being a tombstone (users.status = 'deleted')
// when the open reaches the activation → 10001 (the banned user's answer), no active binding, no
// union_pdd_pid_filings row, no conversion, never a 500. Main activates the tombstone (red there).
// The second half is the control: a normal user of a fresh tenant, same setup, is activated and
// filed as now.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture } from '../open-pdd-auth/database.ts';
import { fixture, outcome, service } from '../open-pdd-auth/kit.ts';
import { noAuthEntry, response, success } from '../open-pdd-auth/assertions.ts';
import { currentPid, filed, filings } from '../pdd-pid-filings/kit.ts';
import { CASES, TIMEOUT, expectTombstone, tombstone } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it.each(CASES)(
  '[AC-B1-06zk#1] 自己的拼多多 open：$binding 绑定、查询答已备案，用户在激活前已是墓碑（$when，deleted_reason=$reason）→ 10001，不写 active 绑定、不写备案、不转链；对照：正常用户同样场景照常激活并写备案',
  async ({ binding, when, reason }) => {
    const f = await fixture(database(), { binding, query: true, scene: 'search' });
    const open = service(f);
    const before = await f.bindings();
    const mark = () => tombstone(f.db, f.appId, f.a.userId, reason);
    if (when === 'before_request') await mark();
    else {
      f.query.mockImplementationOnce(async () => {
        await mark();
        return { authorized: true };
      });
    }

    const result = await response(await outcome(() => open.open(f.request())), 10001, 401);
    noAuthEntry(result);
    if (when === 'during_query') expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.convert).not.toHaveBeenCalled();
    const after = await f.bindings();
    expect(after.filter((row) => row.status === 'active')).toEqual([]);
    expect(after).toEqual(before);
    expect(await filings(f)).toEqual([]);
    expect(await f.sessions()).toEqual([]);
    await expectTombstone(f.db, f.appId, f.a.userId, reason);

    // Control (not a tombstone): the same open activates and files the current slot, as now.
    const g = await fixture(database(), { binding, query: true, scene: 'search' });
    await success(await outcome(() => service(g).open(g.request())));
    expect(g.query).toHaveBeenCalledTimes(1);
    expect((await g.bindings()).filter((row) => row.status === 'active')).toEqual([
      expect.objectContaining({
        app_id: g.appId,
        user_id: g.a.userId,
        union_account_id: g.accountId,
      }),
    ]);
    expect(await filings(g)).toEqual([filed(g, g.a.userId, currentPid('self_buy'), g.clock.now())]);
  },
  TIMEOUT,
);
