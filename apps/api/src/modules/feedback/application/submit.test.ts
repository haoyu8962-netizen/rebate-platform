// Unit tests of the submission use case over a scripted driver (no PG connection): the order of
// the checks, the lock before the count, the 42901 boundary and the inserted values.
import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool, type Transaction } from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type { AccountDeletionStatus } from '../domain/rules.ts';
import { deleteFeedbackForUser } from './deletion.ts';
import { submitFeedback, type FeedbackSubmission } from './submit.ts';

const APP = 'couli';
const DEVICE = '0199a3b4-5c6d-7e8f-9a0b-000000000021';
const USER = '0199a3b4-5c6d-7e8f-9a0b-000000000022';
const LINK = '0199a3b4-5c6d-7e8f-9a0b-000000000023';
const NOW = '2026-11-06T02:00:00.000Z';
const TRACE = 'trace-b128p';

function scripted(count: number, userPresent = true) {
  const queries: { text: string; values: unknown[] }[] = [];
  const client = {
    release: () => undefined,
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      const rows = /count\(\*\)/.test(text)
        ? [{ n: String(count) }]
        : /from "app"\."users"/.test(text) && userPresent
          ? [{ id: USER }]
          : [];
      return { command: text.trim().split(/\s/)[0]!.toUpperCase(), rows, rowCount: rows.length };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  });
  return { trx: db as unknown as Transaction<DB>, queries };
}

function submission(overrides: Partial<FeedbackSubmission['body']> = {}): FeedbackSubmission {
  return {
    appId: APP,
    deviceId: DEVICE,
    userId: USER,
    productKey: 'jd:synthetic-1',
    traceId: TRACE,
    body: {
      platform: 'jd',
      link_id: LINK,
      shown_final_price_fen: 12900,
      shown_rebate_fen: 350,
      quoted_at: '2026-11-06T09:55:00+08:00',
      reason: 'price',
      note: null,
      ...overrides,
    },
  };
}

function deps(linkInApp = true, status: AccountDeletionStatus | undefined = 'none') {
  const linkCalls: unknown[] = [];
  const statusCalls: unknown[] = [];
  return {
    linkCalls,
    statusCalls,
    deps: {
      accounts: {
        async deletionStatus(_trx: unknown, appId: string, userId: string) {
          statusCalls.push([appId, userId]);
          return status;
        },
      },
      clock: new FixedClock(NOW),
      links: {
        async linkInApp(_handle: unknown, appId: string, linkId: string) {
          linkCalls.push([appId, linkId]);
          return linkInApp;
        },
      },
    },
  };
}

it('[AC-B1-28p] feedback.enabled off → 30145 before the link check, no statement', async () => {
  const { trx, queries } = scripted(0);
  const d = deps();
  const outcome = await submitFeedback(
    trx,
    submission(),
    { enabled: false, dailyLimit: 20 },
    d.deps,
  );
  expect(outcome.result).toEqual({
    status: 422,
    envelope: { code: 30145, msg: expect.any(String), trace_id: TRACE },
  });
  expect(d.linkCalls).toEqual([]);
  expect(queries).toEqual([]);
});

it('[AC-B1-28p] a link_id that is not a uuid or not in the app → 30144, no lock and no write', async () => {
  for (const [linkId, inApp, calls] of [
    ['not-a-uuid', true, 0],
    [LINK, false, 1],
  ] as const) {
    const { trx, queries } = scripted(0);
    const d = deps(inApp);
    const outcome = await submitFeedback(
      trx,
      submission({ link_id: linkId }),
      { enabled: true, dailyLimit: 20 },
      d.deps,
    );
    expect(outcome.result).toMatchObject({ status: 404, envelope: { code: 30144 } });
    expect(d.linkCalls).toHaveLength(calls);
    expect(queries).toEqual([]);
  }
});

it('[AC-B1-28p] the count reaching the limit → 42901 with Retry-After to the +08:00 midnight, no insert', async () => {
  const { trx, queries } = scripted(3);
  const outcome = await submitFeedback(
    trx,
    submission(),
    { enabled: true, dailyLimit: 3 },
    deps().deps,
  );
  expect(outcome.result).toMatchObject({ status: 429, envelope: { code: 42901 } });
  // 10:00 +08:00 → 14 hours to midnight.
  expect(outcome.retryAfterSec).toBe(14 * 3600);
  expect(queries.map((q) => q.text.trim().split(/\s/)[0]!.toUpperCase())).toEqual([
    'SELECT',
    'SELECT',
    'SELECT',
  ]);
  expect(queries[0]!.text).toMatch(/from "app"\."users" .* for share$/);
  expect(queries[1]!.text).toContain('pg_advisory_xact_lock');
  expect(queries[2]!.values).toEqual([
    APP,
    DEVICE,
    new FixedClock('2026-11-05T16:00:00.000Z').now(),
    new FixedClock('2026-11-06T16:00:00.000Z').now(),
  ]);
});

it('[AC-B1-28p] below the limit: lock, count, then one insert with the device, the user and the Clock time', async () => {
  const { trx, queries } = scripted(2);
  const outcome = await submitFeedback(
    trx,
    submission({ shown_rebate_fen: null, note: '说明', item_ref: 'ref-1' }),
    { enabled: true, dailyLimit: 3 },
    deps().deps,
  );
  expect(outcome.result.status).toBe(200);
  const data = outcome.result.envelope.data as { feedback_id: string };
  expect(outcome.result.envelope).toEqual({
    code: 0,
    msg: '',
    data: { feedback_id: expect.any(String) },
    trace_id: TRACE,
  });
  expect(queries).toHaveLength(4);
  const insert = queries[3]!;
  expect(insert.text).toMatch(/^INSERT INTO app\.product_feedbacks/);
  expect(insert.values).toEqual([
    data.feedback_id,
    APP,
    DEVICE,
    USER,
    'jd',
    'jd:synthetic-1',
    'ref-1',
    LINK,
    '12900',
    null,
    new FixedClock('2026-11-06T01:55:00.000Z').now(),
    'price',
    '说明',
    new FixedClock(NOW).now(),
  ]);
});

it('[AC-B1-28p] a guest is written without user_id', async () => {
  const { trx, queries } = scripted(0);
  await submitFeedback(
    trx,
    { ...submission(), userId: null },
    { enabled: true, dailyLimit: 20 },
    deps().deps,
  );
  expect(queries[2]!.values[3]).toBeNull();
});

it('[AC-B1-28p] the deletion step deletes by app and user only, whatever `at`', async () => {
  const { trx, queries } = scripted(0);
  await deleteFeedbackForUser(trx, { appId: APP, userId: USER, at: new FixedClock(NOW).now() });
  expect(queries).toHaveLength(1);
  expect(queries[0]!.text).toMatch(/^DELETE FROM app\.product_feedbacks/);
  expect(queries[0]!.text).toContain('user_id =');
  expect(queries[0]!.values).toEqual([APP, USER]);
});

it('[AC-B1-28p#32] a logged-in submission locks the users row FOR SHARE before the device lock, then reads the status on the same transaction', async () => {
  const { trx, queries } = scripted(0);
  const d = deps();
  await submitFeedback(trx, submission(), { enabled: true, dailyLimit: 20 }, d.deps);
  expect(queries[0]!.text).toMatch(
    /^select "id" from "app"\."users" where "app_id" = \$1 and "id" = \$2 for share$/,
  );
  expect(queries[0]!.values).toEqual([APP, USER]);
  expect(queries[1]!.text).toContain('pg_advisory_xact_lock');
  expect(d.statusCalls).toEqual([[APP, USER]]);
  expect(queries[3]!.values[3]).toBe(USER);
});

it('[AC-B1-28p#33] an account in the deletion flow (processing / done) is recorded as a guest: no user_id, the device as always', async () => {
  for (const status of ['processing', 'done'] as const) {
    const { trx, queries } = scripted(0);
    const outcome = await submitFeedback(
      trx,
      submission(),
      { enabled: true, dailyLimit: 20 },
      deps(true, status).deps,
    );
    expect(outcome.result.status).toBe(200);
    const insert = queries[3]!;
    expect(insert.text).toMatch(/^INSERT INTO app\.product_feedbacks/);
    expect(insert.values[2]).toBe(DEVICE);
    expect(insert.values[3]).toBeNull();
  }
});

it('[AC-B1-28p#34] a user missing in the app is recorded as a guest without reading the status', async () => {
  const { trx, queries } = scripted(0, false);
  const d = deps();
  await submitFeedback(trx, submission(), { enabled: true, dailyLimit: 20 }, d.deps);
  expect(d.statusCalls).toEqual([]);
  expect(queries[3]!.values[3]).toBeNull();
});

it('[AC-B1-28p] a guest takes no users lock and reads no status', async () => {
  const { trx, queries } = scripted(0);
  const d = deps();
  await submitFeedback(
    trx,
    { ...submission(), userId: null },
    { enabled: true, dailyLimit: 20 },
    d.deps,
  );
  expect(queries.some((q) => /"users"/.test(q.text))).toBe(false);
  expect(d.statusCalls).toEqual([]);
});
