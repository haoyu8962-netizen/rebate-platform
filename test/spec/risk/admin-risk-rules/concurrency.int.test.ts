// B1-03zg: the compare-and-set of enable / disable lives in the SQL (CT-24f; orchestrator ruling
// #2078: WHERE version = expected_version and app_id), so two concurrent calls with the same
// expected_version take effect exactly once: one change, version + 1, one audit record.
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { useHarness, type Response } from '../../admin/auth/kit.ts';
import {
  CONFLICT,
  accepted,
  rejected,
  ruleAudits,
  ruleRow,
  seedRule,
  setup,
  unlistedId,
  type Scenario,
} from './kit.ts';

const h = useHarness();

/** Holds the rule's row lock in another transaction until released. */
async function held(s: Scenario, ruleId: string) {
  const ready = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const done = h.db
    .transaction()
    .execute(async (trx) => {
      await sql`SET LOCAL lock_timeout = '4s'`.execute(trx);
      await trx
        .selectFrom('risk_rules')
        .select('id')
        .where('app_id', '=', s.appId)
        .where('rule_id', '=', ruleId)
        .forUpdate()
        .executeTakeFirstOrThrow();
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
 * Under a row lock only the first call waits on the holder directly; the second queues behind the
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
  expect(waiting, 'both calls reach the rule row and wait on a lock').toBeGreaterThanOrEqual(count);
}

it('[AC-B1-03zg#33] 两次 enable 同版本并发，恰一次生效：一个 200 一个 20902，version + 1，一条审计', async () => {
  const s = await setup(h);
  const row = await seedRule(s, { rule_id: unlistedId(), status: 'disabled', version: 4 });
  const first = await s.issue();
  const second = await s.issue();
  const lock = await held(s, row.rule_id);
  const calls: Promise<Response>[] = [];
  try {
    calls.push(s.change('enable', row.rule_id, { expected_version: 4 }, { token: first }));
    calls.push(s.change('enable', row.rule_id, { expected_version: 4 }, { token: second }));
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
      expect(await accepted(response)).toMatchObject({ status: 'enabled', version: 5 });
    } else {
      await rejected(response, 20902, CONFLICT);
    }
  }
  expect(await ruleRow(s, row.rule_id)).toMatchObject({ status: 'enabled', version: 5 });
  expect((await ruleAudits(s)).map((a) => a.action)).toEqual(['risk_rule_enable']);
});

it('[AC-B1-03zg#34] enable 与 disable 同版本并发，恰一次修改：最终 enabled、version + 1、一条审计', async () => {
  const s = await setup(h);
  const row = await seedRule(s, { rule_id: unlistedId(), status: 'disabled', version: 4 });
  const enableToken = await s.issue();
  const disableToken = await s.issue();
  const responses = await Promise.all([
    s.change('enable', row.rule_id, { expected_version: 4 }, { token: enableToken }),
    s.change('disable', row.rule_id, { expected_version: 4 }, { token: disableToken }),
  ]);
  // disable first is a no-op success and enable then changes; enable first leaves disable a 20902.
  const [enabled, disabled] = responses;
  expect(await accepted(enabled)).toMatchObject({ status: 'enabled', version: 5 });
  if (disabled.json().code === 0) {
    expect(await accepted(disabled)).toMatchObject({ status: 'disabled', version: 4 });
  } else {
    await rejected(disabled, 20902, CONFLICT);
  }
  expect(await ruleRow(s, row.rule_id)).toMatchObject({ status: 'enabled', version: 5 });
  expect((await ruleAudits(s)).map((a) => a.action)).toEqual(['risk_rule_enable']);
});
