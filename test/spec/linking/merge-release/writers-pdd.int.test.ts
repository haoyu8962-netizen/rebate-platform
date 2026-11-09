// B1-20c: D10-1099 T-7 on the Pinduoduo activation (D10-1103: the writer of union-bindings-pdd.ts,
// GET /v1/unions/bindings refreshing the self_buy filing, through pdd-authority.ts
// activatePddBinding under the bindings' user lock, binding-lock.ts). A merge that commits while the
// authority query is in flight leaves the account a tombstone (users.status = deleted,
// deleted_reason = merged); the activation that follows never writes an active binding for it, and
// the page still answers (a refresh failure is never an error of this read). Built on the B1-06x
// fixture (test/spec/linking/bindings-pdd-query/kit.ts): its database, its faked adapter.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { fixture, TIMEOUT } from '../bindings-pdd-query/kit.ts';
import { databaseFixture } from '../open-pdd-auth/database.ts';

const database = databaseFixture(createTestDatabase);

it.each(['absent', 'unbound', 'pending_auth', 'invalid', 'released'] as const)(
  '[AC-B1-20c#47] T-7 拼多多备案查询途中账号被并号置墓碑（存量 %s）→ 查询答已授权也不为墓碑写出 active 绑定，行原样；页面照常应答',
  async (status) => {
    const f = await fixture(database(), status);
    const before = await f.bindings();
    f.query.mockImplementationOnce(async () => {
      await sql`UPDATE app.users SET status = 'deleted', deleted_reason = 'merged'
        WHERE app_id = ${f.appId} AND id = ${f.a.userId}`.execute(f.db);
      return { authorized: true };
    });

    const value = await f.list();

    expect(f.query).toHaveBeenCalledTimes(1);
    expect(value).toMatchObject({ status: 200, envelope: { code: 0 } });
    expect(await f.bindings()).toEqual(before);
    expect((await f.bindings()).filter((row) => row.status === 'active')).toEqual([]);
  },
  TIMEOUT,
);
