// B1-06zi (BR-ID-22): a non-active own binding queried filed is activated as now and also gets the
// filing row of this open's current slot — the pid the next open looks up. A filing row never
// overrides the binding state (migration 0135 header): blocked → 30153, banned → 10001, the site
// authorization expired → 50301, an invalid binding is still queried, no_rebate goes on unqueried.
// Those guards hold on main already (main neither reads nor writes the table), so each runs as the
// second half of a case whose first half (the row being written) is red on main.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture } from '../open-pdd-auth/database.ts';
import { fixture, outcome, service } from '../open-pdd-auth/kit.ts';
import { identity, noAuthEntry, response, success } from '../open-pdd-auth/assertions.ts';
import { TIMEOUT, activeUnfiled, ban, currentPid, filed, filings, setBinding } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it.each(['absent', 'unbound', 'pending_auth', 'invalid', 'released'] as const)(
  '[AC-B1-06zi#5] %s 查询答已备案：照现激活绑定，并插本 pid 备案行；再开同 pid 不再查',
  async (binding) => {
    const f = await fixture(database(), { binding, query: true, scene: 'search' });
    const open = service(f);
    await success(await outcome(() => open.open(f.request())));
    expect(f.query).toHaveBeenCalledTimes(1);
    identity(f, f.query.mock.calls[0]![0], f.a.attr, 'self_buy');
    const rows = await f.bindings();
    expect(rows.filter((row) => row.status === 'active')).toEqual([
      expect.objectContaining({
        app_id: f.appId,
        user_id: f.a.userId,
        union_account_id: f.accountId,
      }),
    ]);
    expect(await filings(f)).toEqual([filed(f, f.a.userId, currentPid('self_buy'), f.clock.now())]);

    // The row written at activation is the one the next open looks up.
    await success(await outcome(() => open.open(f.request())));
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(await filings(f)).toHaveLength(1);
    expect(await f.bindings()).toEqual(rows);
  },
  TIMEOUT,
);

it.each([
  { guard: 'blocked', code: 30153, status: 422 },
  { guard: 'banned', code: 10001, status: 401 },
  { guard: 'site_expired', code: 50301, status: 503 },
] as const)(
  '[AC-B1-06zi#6] 备案行不越过绑定状态：active 补写本 pid 备案后转 $guard → $code，不查上游、备案行不变',
  async ({ guard, code, status }) => {
    const f = await activeUnfiled(database(), { query: true });
    const open = service(f);
    await success(await outcome(() => open.open(f.request())));
    expect(f.query).toHaveBeenCalledTimes(1);
    const rows = await filings(f);
    expect(rows).toEqual([filed(f, f.a.userId, currentPid('self_buy'), f.clock.now())]);

    if (guard === 'site_expired') await f.expire();
    else await setBinding(f, f.a.userId, 'blocked');
    if (guard === 'banned') await ban(f, f.a.userId, f.clock.now());
    const before = await f.bindings();
    f.fetch.mockClear();
    f.convert.mockClear();
    const result = await response(await outcome(() => open.open(f.request())), code, status);
    noAuthEntry(result);
    if (guard === 'site_expired') expect(result.envelope.data).toEqual({ reason: 'maintenance' });
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.convert).not.toHaveBeenCalled();
    expect(await filings(f)).toEqual(rows);
    expect(await f.bindings()).toEqual(before);
    expect(await f.sessions()).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-06zi#7] no_rebate 照现不查、不写备案；备案行不让 invalid 绑定免查（答未备案 30111，行不删）；blocked 的 no_rebate 照现放行',
  async () => {
    const f = await activeUnfiled(database(), { query: true });
    const open = service(f);
    // no_rebate on the active binding with no filing row: unqueried, nothing filed (as now).
    await success(await outcome(() => open.open(f.request({ noRebate: true }))));
    expect(f.query).not.toHaveBeenCalled();
    expect(await filings(f)).toEqual([]);

    // The rebate open files this pid.
    await success(await outcome(() => open.open(f.request())));
    expect(f.query).toHaveBeenCalledTimes(1);
    const rows = await filings(f);
    expect(rows).toEqual([filed(f, f.a.userId, currentPid('self_buy'), f.clock.now())]);

    // Binding invalid with the pid's row present: still queried; not filed → 30111, row kept.
    await setBinding(f, f.a.userId, 'invalid');
    const invalid = await f.bindings();
    f.query.mockResolvedValue({ authorized: false });
    await response(await outcome(() => open.open(f.request())), 30111, 422);
    expect(f.query).toHaveBeenCalledTimes(2);
    identity(f, f.query.mock.calls[1]![0], f.a.attr, 'self_buy');
    expect(await f.bindings()).toEqual(invalid);
    expect(await filings(f)).toEqual(rows);
    expect(await f.sessions()).toHaveLength(1);

    // no_rebate on the invalid binding: unqueried, as now.
    await success(await outcome(() => open.open(f.request({ noRebate: true }))));
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(await filings(f)).toEqual(rows);

    // no_rebate on a blocked binding: allowed with the server's reason, unqueried, as now.
    await setBinding(f, f.a.userId, 'blocked');
    await success(await outcome(() => open.open(f.request({ noRebate: true }))));
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(await filings(f)).toEqual(rows);
    expect(await f.logs()).toContainEqual(
      expect.objectContaining({
        result_code: 0,
        no_rebate: true,
        no_rebate_reason: 'binding_blocked',
      }),
    );
  },
  TIMEOUT,
);
