// B1-03zg: every app registers the same rule codes (BLACKLIST_PHONE, DEVICE_REGISTER_LIMIT, …;
// app.risk_rules is unique on (app_id, rule_id) only), so the list, the compare-and-set and the
// audit all have to be scoped by the console's app (CT-24f; orchestrator ruling #2078: WHERE
// version = expected_version and app_id). Here two apps hold the same rule_id with the same
// version and status: a change through one app's console touches that app's row only, and the
// other app's row (status, version, updated_at, every column) and audit stay as they were.
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { useHarness, type Response } from '../../admin/auth/kit.ts';
import {
  CHANGES,
  CONFLICT,
  HOUR,
  accepted,
  at,
  columns,
  expectedRule,
  instant,
  listed,
  otherOf,
  rejected,
  ruleAudits,
  ruleRow,
  seedRule,
  setup,
  snapshot,
  targetOf,
} from './kit.ts';

const h = useHarness();
const REASON = '两应用同名规则，只改本应用';
const PHONE = 'BLACKLIST_PHONE';
const DEVICE = 'DEVICE_REGISTER_LIMIT';
const SHARED_IDS: string[] = [PHONE, DEVICE];

/** Holds the row lock of `ruleId` in each of `appIds` in another transaction until released. */
async function held(appIds: readonly string[], ruleId: string) {
  const ready = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const done = h.db
    .transaction()
    .execute(async (trx) => {
      await sql`SET LOCAL lock_timeout = '4s'`.execute(trx);
      const rows = await trx
        .selectFrom('risk_rules')
        .select('id')
        .where('app_id', 'in', [...appIds])
        .where('rule_id', '=', ruleId)
        .forUpdate()
        .execute();
      if (rows.length !== appIds.length) throw new Error(`locked ${rows.length} rows`);
      const pid = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
      ready.resolve(pid.rows[0]!.pid);
      await release.promise;
    })
    .then(
      () => ({ ok: true }),
      (cause: unknown) => {
        ready.reject(cause);
        return { ok: false, cause };
      },
    );
  return { pid: await ready.promise, release: () => release.resolve(), done };
}

/**
 * Waits until `count` sessions of this database wait on a PG lock in a statement on risk_rules.
 * Two calls on one row: only the first waits on the holder directly, the second queues behind the
 * first, so the waiters are counted whoever blocks them (as test/spec/notification/settings does).
 */
async function queued(count: number) {
  const deadline = performance.now() + 2500;
  let waiting = 0;
  do {
    const result = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND query ILIKE '%risk_rules%'`.execute(h.db);
    waiting = result.rows[0]!.n;
    if (waiting >= count) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  } while (performance.now() < deadline);
  expect(waiting, 'both calls reach a rule row and wait on a lock').toBeGreaterThanOrEqual(count);
}

it('[AC-B1-03zg#35] 两个 app 登记同名规则时，列表各只看到自己的那几行', async () => {
  const s = await setup(h);
  const other = await setup(h);
  const mine = [
    await seedRule(s, {
      rule_id: PHONE,
      scene: 'register',
      status: 'enabled',
      version: 2,
      risk_action: 'block',
      updated_at: at(-3 * HOUR),
    }),
    await seedRule(s, {
      rule_id: DEVICE,
      scene: 'register',
      status: 'disabled',
      version: 5,
      risk_action: 'manual_review',
      updated_at: at(-HOUR),
    }),
  ];
  const theirs = [
    await seedRule(other, {
      rule_id: PHONE,
      scene: 'register',
      status: 'disabled',
      version: 9,
      risk_action: 'manual_review',
      updated_at: at(-7 * HOUR),
    }),
    await seedRule(other, {
      rule_id: DEVICE,
      scene: 'register',
      status: 'enabled',
      version: 0,
      risk_action: 'pass',
      updated_at: at(-9 * HOUR),
    }),
  ];
  // Same scene; BLACKLIST_PHONE sorts before DEVICE_REGISTER_LIMIT under any collation.
  expect((await listed(await s.list())).map(instant)).toEqual(mine.map((row) => expectedRule(row)));
  expect((await listed(await other.list())).map(instant)).toEqual(
    theirs.map((row) => expectedRule(row)),
  );
});

for (const change of CHANGES) {
  it.each(SHARED_IDS)(
    `[AC-B1-03zg#36] ${change} 两个 app 同有 %s、同版本同状态：只改本 app 那一行，另一 app 的行与审计不变`,
    async (ruleId) => {
      const s = await setup(h);
      const other = await setup(h);
      const mine = await seedRule(s, { rule_id: ruleId, status: otherOf(change), version: 6 });
      const theirs = await seedRule(other, {
        rule_id: ruleId,
        status: otherOf(change),
        version: 6,
      });
      const before = await snapshot(other);
      const data = await accepted(
        await s.change(change, ruleId, { expected_version: 6, reason: REASON }),
      );
      expect(data).toMatchObject({ rule_id: ruleId, status: targetOf(change), version: 7 });
      const after = await ruleRow(s, ruleId);
      expect(columns(after)).toEqual({
        ...columns(mine),
        status: targetOf(change),
        version: 7,
        updated_at: s.f.clock.now(),
      });
      expect(instant(data)).toEqual(expectedRule(after));
      expect((await ruleAudits(s)).map((a) => a.action)).toEqual([`risk_rule_${change}`]);
      // The other app's row keeps its status, version and updated_at (every column), no audit.
      expect(await ruleRow(other, ruleId)).toEqual(theirs);
      expect(await snapshot(other)).toEqual(before);
      expect((await listed(await other.list())).map(instant)).toEqual([expectedRule(theirs)]);
    },
  );

  it(`[AC-B1-03zg#37] ${change} 本 app 版本不符而另一 app 同名规则版本恰等于 expected_version → 20902，两行都不变`, async () => {
    const s = await setup(h);
    const other = await setup(h);
    await seedRule(s, { rule_id: PHONE, status: otherOf(change), version: 5 });
    await seedRule(other, { rule_id: PHONE, status: otherOf(change), version: 6 });
    const mine = await snapshot(s);
    const before = await snapshot(other);
    await rejected(
      await s.change(change, PHONE, { expected_version: 6, reason: REASON }),
      20902,
      CONFLICT,
    );
    expect(await snapshot(s)).toEqual(mine);
    expect(await snapshot(other)).toEqual(before);
  });

  it(`[AC-B1-03zg#38] ${change} 本 app 已是目标状态（原样成功）时，另一 app 同名同版本、处于起始状态的规则不被改`, async () => {
    const s = await setup(h);
    const other = await setup(h);
    const mine = await seedRule(s, { rule_id: DEVICE, status: targetOf(change), version: 6 });
    const theirs = await seedRule(other, {
      rule_id: DEVICE,
      status: otherOf(change),
      version: 6,
    });
    const myBefore = await snapshot(s);
    const before = await snapshot(other);
    s.f.clock.advanceMs(60_000);
    const data = await accepted(
      await s.change(change, DEVICE, { expected_version: 6, reason: REASON }),
    );
    expect(instant(data)).toEqual(expectedRule(mine));
    expect(await snapshot(s)).toEqual(myBefore);
    expect(await ruleRow(other, DEVICE)).toEqual(theirs);
    expect(await snapshot(other)).toEqual(before);
  });
}

it('[AC-B1-03zg#39] 本 app 两次 enable 同版本并发，恰一次生效；另一 app 同名同版本的 disabled 规则不受影响', async () => {
  const s = await setup(h);
  const other = await setup(h);
  await seedRule(s, { rule_id: PHONE, status: 'disabled', version: 4 });
  const theirs = await seedRule(other, { rule_id: PHONE, status: 'disabled', version: 4 });
  const before = await snapshot(other);
  const first = await s.issue();
  const second = await s.issue();
  const lock = await held([s.appId], PHONE);
  const calls: Promise<Response>[] = [];
  try {
    calls.push(s.change('enable', PHONE, { expected_version: 4 }, { token: first }));
    calls.push(s.change('enable', PHONE, { expected_version: 4 }, { token: second }));
    await queued(2);
  } finally {
    lock.release();
    await Promise.allSettled([lock.done, ...calls]);
  }
  expect(await lock.done).toEqual({ ok: true });
  const responses = await Promise.all(calls);
  const codes = responses.map((r) => r.json().code).sort((a, b) => a - b);
  expect(codes).toEqual([0, 20902]);
  for (const response of responses) {
    if (response.json().code === 0) {
      expect(await accepted(response)).toMatchObject({
        rule_id: PHONE,
        status: 'enabled',
        version: 5,
      });
    } else {
      await rejected(response, 20902, CONFLICT);
    }
  }
  expect(await ruleRow(s, PHONE)).toMatchObject({ status: 'enabled', version: 5 });
  expect((await ruleAudits(s)).map((a) => a.action)).toEqual(['risk_rule_enable']);
  expect(await ruleRow(other, PHONE)).toEqual(theirs);
  expect(await snapshot(other)).toEqual(before);
});

it('[AC-B1-03zg#40] 两个 app 各自的管理员同时 enable 同名同版本规则：两边各恰一次生效、各一条审计', async () => {
  const s = await setup(h);
  const other = await setup(h);
  await seedRule(s, { rule_id: DEVICE, status: 'disabled', version: 4 });
  await seedRule(other, { rule_id: DEVICE, status: 'disabled', version: 4 });
  const mine = await s.issue();
  const theirs = await other.issue();
  const lock = await held([s.appId, other.appId], DEVICE);
  const calls: Promise<Response>[] = [];
  try {
    calls.push(s.change('enable', DEVICE, { expected_version: 4 }, { token: mine }));
    calls.push(other.change('enable', DEVICE, { expected_version: 4 }, { token: theirs }));
    await queued(2);
  } finally {
    lock.release();
    await Promise.allSettled([lock.done, ...calls]);
  }
  expect(await lock.done).toEqual({ ok: true });
  const [mineResponse, theirResponse] = await Promise.all(calls);
  for (const response of [mineResponse!, theirResponse!]) {
    expect(await accepted(response)).toMatchObject({
      rule_id: DEVICE,
      status: 'enabled',
      version: 5,
    });
  }
  for (const scenario of [s, other]) {
    expect(await ruleRow(scenario, DEVICE), scenario.appId).toMatchObject({
      status: 'enabled',
      version: 5,
    });
    expect(
      (await ruleAudits(scenario)).map((a) => [a.action, a.admin_id]),
      scenario.appId,
    ).toEqual([['risk_rule_enable', scenario.a.id]]);
  }
});
