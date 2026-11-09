// Unit tests of the appeal console writes (B1-03ze): the pure rules, the refusals that come before
// any read, and the compare-and-set statements over a scripted pg client (no database).
import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock, type AuditInput, type EventBus } from '../../platform/index.ts';
import type { AdminAppealsRead } from './admin-appeals-read.ts';
import {
  AdminAppealAttemptsUsedUpError,
  AdminAppealConflictError,
  AdminAppealsWrite,
  AdminAppealsWriteFieldsError,
  appealConsoleText,
  appealResolveRequirement,
} from './admin-appeals-write.ts';
import type { RiskStateService } from './risk-state.ts';

const APP = 'couli';
const ADMIN = '019a0000-0000-7000-8000-0000000000a1';
const APPEAL = '019a0000-0000-7000-8000-000000000d01';
const USER = '019a0000-0000-7000-8000-000000000030';
const NOW = '2031-05-06T07:08:09.000Z';
const actor = { appId: APP, adminId: ADMIN, loginName: 'cs-lin', ip: null };

type Rows = (text: string) => readonly Record<string, unknown>[];

type Overrides = Partial<
  Pick<
    ConstructorParameters<typeof AdminAppealsWrite>[0],
    'riskState' | 'restoreAfterUnban' | 'taobaoReauth' | 'ports'
  >
>;

function harness(rows: Rows = () => [], overrides: Overrides = {}) {
  const sqls: { text: string; params: readonly unknown[] }[] = [];
  const client = {
    release() {},
    async query(text: string, params: readonly unknown[] = []) {
      sqls.push({ text, params });
      const result = rows(text);
      return { command: 'SELECT', rowCount: result.length, rows: result };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  });
  const audits: AuditInput[] = [];
  const published: unknown[] = [];
  const reads = {
    get: async (_actor: unknown, id: string) => ({ appeal_id: id }),
  } as unknown as AdminAppealsRead;
  const writes = new AdminAppealsWrite({
    db,
    clock: new FixedClock(NOW),
    events: {
      publish: async (_trx: unknown, event: unknown) => void published.push(event),
    } as unknown as EventBus,
    riskState: {
      setRiskState: async () => {
        throw new Error('not expected');
      },
    } as unknown as RiskStateService,
    config: { configValue: async () => null },
    logger: { warn: () => undefined },
    auditOn: () => ({ append: async (input) => void audits.push(input) }),
    restoreAfterUnban: async () => undefined,
    taobaoReauth: async () => {
      throw new Error('not expected');
    },
    ports: { voidedOrderOwner: async () => null },
    reads,
    ...overrides,
  });
  return { writes, sqls, audits, published };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  );
}

const processingRow = {
  id: APPEAL,
  user_id: USER,
  target_type: 'order',
  target_id: '019a0000-0000-7000-8000-000000000e01',
  prev_risk_state: null,
  status: 'processing',
  handler_id: null,
  row_version: 2,
};

it('[AC-B1-03ze#3] requirement: upholding needs nothing extra whatever the target', () => {
  expect(
    appealResolveRequirement({
      decision: 'upheld',
      target_type: 'account',
      prev_risk_state: 'banned',
      cause: null,
    }),
  ).toEqual({ permission: null, step_up: null });
});

it('[AC-B1-03ze#4] requirement: revoking a freeze needs risk.freeze with totp, a rule block nothing', () => {
  expect(
    appealResolveRequirement({
      decision: 'revoked',
      target_type: 'account',
      prev_risk_state: 'frozen',
      cause: null,
    }),
  ).toEqual({ permission: 'risk.freeze', step_up: 'totp' });
  expect(
    appealResolveRequirement({
      decision: 'revoked',
      target_type: 'blocked_request',
      prev_risk_state: null,
      cause: 'rule',
    }),
  ).toEqual({ permission: null, step_up: null });
});

it('[AC-B1-03ze#5] console text: counted in characters (not UTF-16 units) after trimming', () => {
  expect(appealConsoleText(` ${'😀'.repeat(200)} `)).toBe('😀'.repeat(200));
  expect(appealConsoleText('😀'.repeat(201))).toBeNull();
});

it('[AC-B1-03ze#49] resolve: body refusals come before any read, decision first', async () => {
  const { writes, sqls } = harness();
  const cases: [unknown, string][] = [
    [{ note: '核实', expected_row_version: 0 }, 'decision'],
    [{ decision: 'upheld', note: '  ', expected_row_version: 0 }, 'note'],
    [{ decision: 'upheld', note: '核实', expected_row_version: -1 }, 'expected_row_version'],
  ];
  for (const [body, field] of cases) {
    const error = await failure(writes.prepareResolve(actor, APPEAL, body));
    expect(error).toBeInstanceOf(AdminAppealsWriteFieldsError);
    expect((error as AdminAppealsWriteFieldsError).fields).toEqual([field]);
  }
  const unknown = await failure(
    writes.prepareResolve(actor, 'not-an-appeal-id', {
      decision: 'upheld',
      note: '核实',
      expected_row_version: 0,
    }),
  );
  expect((unknown as AdminAppealsWriteFieldsError).fields).toEqual(['appeal_id']);
  expect(sqls).toEqual([]);
});

it('[AC-B1-03ze#46] resolve: another row_version or a closed appeal is 20902 before the write', async () => {
  const { writes, sqls } = harness((text) =>
    text.includes('from "app"."appeals"') ? [processingRow] : [],
  );
  const stale = await failure(
    writes.prepareResolve(actor, APPEAL, {
      decision: 'upheld',
      note: '核实',
      expected_row_version: 1,
    }),
  );
  expect(stale).toBeInstanceOf(AdminAppealConflictError);
  expect(sqls.some((q) => q.text.startsWith('update') || q.text.includes('UPDATE'))).toBe(false);
});

it('[AC-B1-03ze#33] claim: the update carries status and row_version in its WHERE; 0 rows → 20902, no audit', async () => {
  const { writes, sqls, audits } = harness((text) =>
    text.includes('from "app"."appeals"') ? [{ ...processingRow }] : [],
  );
  const error = await failure(writes.claim(actor, APPEAL, { expected_row_version: 2 }));
  expect(error).toBeInstanceOf(AdminAppealConflictError);
  const update = sqls.find((q) => q.text.includes('UPDATE app.appeals'));
  expect(update?.text).toMatch(/status = 'processing'/);
  expect(update?.text).toMatch(/row_version = \$\d+/);
  expect(update?.params).toContain(2);
  expect(sqls.some((q) => q.text.includes('for update'))).toBe(true);
  expect(audits).toEqual([]);
});

it('[AC-B1-03ze#30] claim: one row updated → a claim row of the new version, audit with the handler before and after', async () => {
  const { writes, audits, sqls } = harness((text) => {
    if (text.includes('UPDATE app.appeals')) return [{ handler_id: ADMIN }];
    if (text.includes('from "app"."appeals"')) return [{ ...processingRow, handler_id: 'other' }];
    return [];
  });
  expect(await writes.claim(actor, APPEAL, { expected_row_version: 2 })).toEqual({
    appeal_id: APPEAL,
  });
  const claimRow = sqls.find((q) => q.text.includes('INSERT INTO app.appeal_claims'));
  expect(claimRow?.params).toEqual(expect.arrayContaining([APP, APPEAL, 3, ADMIN]));
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    action: 'appeal_claim',
    target: APPEAL,
    before: { handler_id: 'other', row_version: 2 },
    after: { handler_id: ADMIN, claimed_at: NOW, row_version: 3 },
  });
});

it('[AC-B1-03ze#64] register: a blank reason is refused before any read', async () => {
  const { writes, sqls } = harness();
  const error = await failure(
    writes.register(actor, {
      target_type: 'account',
      target_id: USER,
      content: '请核查',
      reason: ' \t ',
    }),
  );
  expect((error as AdminAppealsWriteFieldsError).fields).toEqual(['reason']);
  expect(sqls).toEqual([]);
});

it('[AC-B1-03ze#67] register: an order the port does not know as voided is 20001 target_id', async () => {
  const { writes, sqls } = harness();
  const error = await failure(
    writes.register(actor, {
      target_type: 'order',
      target_id: '019a0000-0000-7000-8000-000000000e01',
      content: '请核查',
      reason: '登记',
    }),
  );
  expect((error as AdminAppealsWriteFieldsError).fields).toEqual(['target_id']);
  expect(sqls).toEqual([]);
});

const accountRow = {
  id: APPEAL,
  user_id: USER,
  target_type: 'account',
  target_id: USER,
  prev_risk_state: 'banned',
  status: 'processing',
  handler_id: null,
  row_version: 2,
};

/** A scripted resolve of `appeal`: the CAS update hits one row, the account is appealing. */
function resolveRows(appeal: Record<string, unknown>): Rows {
  return (text) => {
    if (text.includes('UPDATE app.appeals')) return [{ id: APPEAL }];
    if (text.includes('from "app"."appeals"')) return [{ ...appeal }];
    if (text.includes('from "app"."users"')) return [{ id: USER }];
    if (text.includes('from "app"."user_risk_state"')) {
      return [
        {
          state: 'appealing',
          reason: 'r',
          reason_category: 'fraud',
          frozen_until: null,
          row_version: 5,
        },
      ];
    }
    return [];
  };
}

async function resolveWith(
  appeal: Record<string, unknown>,
  decision: 'upheld' | 'revoked',
  reauth: boolean,
) {
  const log: string[] = [];
  const h = harness(resolveRows(appeal), {
    riskState: {
      setRiskState: async (_trx: unknown, input: { state: string }) =>
        void log.push(`setRiskState:${input.state}`),
    } as unknown as RiskStateService,
    restoreAfterUnban: async () => void log.push('restoreAfterUnban'),
    taobaoReauth: async (_trx, scope) => {
      log.push(`taobaoReauth:${scope.appId}:${scope.userId}`);
      return reauth;
    },
  });
  const prepared = await h.writes.prepareResolve(actor, APPEAL, {
    decision,
    note: '核实',
    expected_row_version: 2,
  });
  await prepared.run();
  return { ...h, log };
}

it('[AC-B1-03ze#75] resolve: a revoked ban reads the Taobao binding after the unban; need_reauth follows it', async () => {
  for (const reauth of [true, false]) {
    const { published, log } = await resolveWith(accountRow, 'revoked', reauth);
    expect(log).toEqual([
      'setRiskState:normal',
      'restoreAfterUnban',
      `taobaoReauth:${APP}:${USER}`,
    ]);
    expect(published).toEqual([
      {
        appId: APP,
        name: 'appeal.resolved',
        payload: {
          app_id: APP,
          appeal_id: APPEAL,
          user_id: USER,
          target_type: 'account',
          target_id: USER,
          status: 'revoked',
          need_reauth: reauth,
        },
      },
    ]);
  }
});

it('[AC-B1-03ze#76] resolve: an upheld ban, a revoked freeze and an order appeal carry need_reauth=false without reading bindings', async () => {
  const cases: [Record<string, unknown>, 'upheld' | 'revoked', string[]][] = [
    [accountRow, 'upheld', ['setRiskState:banned']],
    [{ ...accountRow, prev_risk_state: 'frozen' }, 'revoked', ['setRiskState:normal']],
    [processingRow, 'revoked', []],
  ];
  for (const [appeal, decision, expectedLog] of cases) {
    // taobaoReauth answers true: false in the payload proves it was not consulted.
    const { published, log } = await resolveWith(appeal, decision, true);
    expect(log).toEqual(expectedLog);
    expect(published).toHaveLength(1);
    expect((published[0] as { payload: Record<string, unknown> }).payload).toMatchObject({
      status: decision,
      need_reauth: false,
    });
  }
});

it('[AC-B1-03ze#78] register: a blocked request whose appeals were upheld 3 times is 30418, nothing inserted or audited', async () => {
  const BLOCKED = '019a0000-0000-7000-8000-000000000b01';
  const upheld = (n: number) => ({
    id: `019a0000-0000-7000-8000-00000000c00${n}`,
    target_type: 'blocked_request',
    target_id: BLOCKED,
    status: 'upheld',
    prev_risk_state: null,
    created_at: new Date(Date.parse(NOW) - (10 - n) * 86_400_000),
    closed_at: new Date(Date.parse(NOW) - (9 - n) * 86_400_000),
    penalty_started_at: null,
  });
  const { writes, sqls, audits } = harness((text) => {
    if (text.includes('from "app"."risk_hits"')) {
      return [{ request_type: 'withdraw', user_id: USER, related_phone_hmac: null, rows: '1' }];
    }
    if (text.includes('from "app"."appeals"') && text.includes('"prev_risk_state"')) {
      return [upheld(1), upheld(2), upheld(3)];
    }
    return [];
  });
  const error = await failure(
    writes.register(actor, {
      target_type: 'blocked_request',
      target_id: BLOCKED,
      content: '请核查',
      reason: '登记',
    }),
  );
  expect(error).toBeInstanceOf(AdminAppealAttemptsUsedUpError);
  expect(sqls.some((q) => /insert into/i.test(q.text))).toBe(false);
  expect(audits).toEqual([]);
});

// ---- B1-03zn: order registrations share the app's per-order count and lock (BR-ID-36) ----

const ORDER = '019a0000-0000-7000-8000-000000000e02';
const ORDER_LOCK_KEY = `risk.appeals.order:${APP}:${ORDER}`;

function orderAppealRow(n: number, status: string) {
  return {
    id: `019a0000-0000-7000-8000-00000000f00${n}`,
    target_type: 'order',
    target_id: ORDER,
    status,
    prev_risk_state: null,
    created_at: new Date(Date.parse(NOW) - (10 - n) * 86_400_000),
    closed_at: status === 'processing' ? null : new Date(Date.parse(NOW) - (9 - n) * 86_400_000),
    penalty_started_at: null,
  };
}

/** register(order) over scripted rows: `history` answers the count, `processing` the 原单 read. */
function orderHarness(history: readonly Record<string, unknown>[], processing?: string) {
  return harness(
    (text) => {
      if (!text.includes('from "app"."appeals"')) return [];
      if (text.includes('"prev_risk_state"')) return history;
      return processing === undefined ? [] : [{ id: processing }];
    },
    { ports: { voidedOrderOwner: async () => USER } },
  );
}

const registerOrder = { target_type: 'order', target_id: ORDER, content: '请核查', reason: '登记' };

function lockIndex(sqls: readonly { text: string; params: readonly unknown[] }[]): number {
  return sqls.findIndex(
    (q) =>
      q.text.includes('pg_advisory_xact_lock(hashtextextended(') && q.params[0] === ORDER_LOCK_KEY,
  );
}

it('[AC-B1-03zn-UNIT#1] register(order): two upheld and a revoked third appeal → 30418, the count is not restarted, nothing inserted or audited', async () => {
  const { writes, sqls, audits } = orderHarness([
    orderAppealRow(1, 'upheld'),
    orderAppealRow(2, 'upheld'),
    orderAppealRow(3, 'revoked'),
  ]);
  const error = await failure(writes.register(actor, registerOrder));
  expect(error).toBeInstanceOf(AdminAppealAttemptsUsedUpError);
  expect(sqls.some((q) => /insert into/i.test(q.text))).toBe(false);
  expect(audits).toEqual([]);
});

it('[AC-B1-03zn-UNIT#2] register(order): a revoked first appeal still counts; with two on the order a third is registered', async () => {
  const { writes, sqls, audits } = orderHarness([
    orderAppealRow(1, 'revoked'),
    orderAppealRow(2, 'upheld'),
  ]);
  const detail = await writes.register(actor, registerOrder);
  const insert = sqls.find((q) => /insert into app\.appeals/i.test(q.text));
  expect(insert?.params).toContain(ORDER);
  expect(insert?.params).toContain('order');
  expect(detail).toMatchObject({ appeal_id: insert?.params[0] });
  expect(audits.map((a) => a.action)).toEqual(['appeal_register']);
});

it('[AC-B1-03zn-UNIT#3] register(order): the order lock (the app submission key) is taken before the processing read and the count', async () => {
  const { writes, sqls } = orderHarness([orderAppealRow(1, 'upheld')]);
  await writes.register(actor, registerOrder);
  const lock = lockIndex(sqls);
  const processing = sqls.findIndex(
    (q) => q.text.includes('from "app"."appeals"') && !q.text.includes('"prev_risk_state"'),
  );
  const count = sqls.findIndex(
    (q) => q.text.includes('from "app"."appeals"') && q.text.includes('"prev_risk_state"'),
  );
  expect(lock).toBeGreaterThanOrEqual(0);
  expect(sqls.filter((q) => q.text.includes('pg_advisory_xact_lock')).length).toBe(1);
  expect(processing).toBeGreaterThan(lock);
  expect(count).toBeGreaterThan(processing);
});

it('[AC-B1-03zn-UNIT#4] register(order): a processing appeal read behind the lock is returned, nothing counted, inserted or audited', async () => {
  const existing = '019a0000-0000-7000-8000-00000000f009';
  const { writes, sqls, audits } = orderHarness(
    [orderAppealRow(1, 'upheld'), orderAppealRow(2, 'upheld'), orderAppealRow(3, 'revoked')],
    existing,
  );
  expect(await writes.register(actor, registerOrder)).toEqual({ appeal_id: existing });
  expect(lockIndex(sqls)).toBeGreaterThanOrEqual(0);
  expect(sqls.some((q) => q.text.includes('"prev_risk_state"'))).toBe(false);
  expect(sqls.some((q) => /insert into/i.test(q.text))).toBe(false);
  expect(audits).toEqual([]);
});

it('[AC-B1-03zn-UNIT#5] register(blocked_request): no order lock is taken', async () => {
  const BLOCKED = '019a0000-0000-7000-8000-000000000b02';
  const { writes, sqls } = harness((text) =>
    text.includes('from "app"."risk_hits"')
      ? [{ request_type: 'withdraw', user_id: USER, related_phone_hmac: null, rows: '1' }]
      : [],
  );
  await writes.register(actor, {
    target_type: 'blocked_request',
    target_id: BLOCKED,
    content: '请核查',
    reason: '登记',
  });
  expect(sqls.some((q) => q.text.includes('pg_advisory_xact_lock'))).toBe(false);
});
