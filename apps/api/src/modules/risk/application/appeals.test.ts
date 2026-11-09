// Unit tests of appealAttempts (CT-26e; BR-ID-36 细则): attempt_no and can_resubmit computed from
// the caller's appeal history only. The SQL runs against PostgreSQL in the rule tests.
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { expect, it, vi } from 'vitest';
import type { Clock, RootLogger } from '../../platform/index.ts';
import type { RateLimitConfigReader } from './rate-limit.ts';
import type { RiskStateService } from './risk-state.ts';
import {
  appealAttempts,
  createAppealsService,
  MAX_APPEAL_ATTEMPTS,
  nextAppealAttempt,
  type AccountRestriction,
  type AppealHistoryRow,
  type AppealOrderReader,
  type AppealOrderTarget,
} from './appeals.ts';

const NOW = new Date('2026-10-23T02:00:00.000Z');
const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a01';

function account(
  n: number,
  status: string,
  prev: 'frozen' | 'banned' = 'banned',
): AppealHistoryRow {
  return {
    id: `0199a3b4-5c6d-7e8f-9a0b-00000000000${n}`,
    target_type: 'account',
    target_id: USER,
    status,
    prev_risk_state: prev,
    created_at: new Date(Date.UTC(2026, 8, n)),
    closed_at: status === 'processing' ? null : new Date(Date.UTC(2026, 8, n, 12)),
  };
}

/** The state was last set before every fixture appeal closed (an upheld appeal restores it). */
const SINCE = new Date(Date.UTC(2026, 7, 1));
const BANNED: AccountRestriction = { state: 'banned', frozen_until: null, changed_at: SINCE };

it('[AC-CT-26e-UNIT#1] attempt_no counts appeals on the same target and penalty from 1', () => {
  const rows = [account(1, 'upheld'), account(2, 'upheld'), account(3, 'processing')];
  const result = appealAttempts([...rows].reverse(), BANNED, NOW);
  expect(rows.map((row) => result.get(row.id)?.attempt_no)).toEqual([1, 2, 3]);
  expect(rows.map((row) => result.get(row.id)?.can_resubmit)).toEqual([false, false, false]);
});

it('[AC-CT-26e-UNIT#2] latest upheld appeal with attempts left on a still-restricted account → can_resubmit', () => {
  const rows = [account(1, 'upheld'), account(2, 'upheld')];
  expect(appealAttempts(rows, BANNED, NOW).get(rows[1]!.id)).toEqual({
    attempt_no: 2,
    can_resubmit: true,
  });
  const frozen = {
    state: 'frozen',
    frozen_until: new Date(NOW.getTime() + 1000),
    changed_at: SINCE,
  } as const;
  const one = [account(1, 'upheld', 'frozen')];
  expect(appealAttempts(one, frozen, NOW).get(one[0]!.id)?.can_resubmit).toBe(true);
});

it('[AC-CT-26e-UNIT#3] the third upheld appeal of one penalty uses up the attempts', () => {
  const rows = [account(1, 'upheld'), account(2, 'upheld'), account(3, 'upheld')];
  const last = appealAttempts(rows, BANNED, NOW).get(rows[2]!.id);
  expect(last).toEqual({ attempt_no: MAX_APPEAL_ATTEMPTS, can_resubmit: false });
});

it('[AC-CT-26e-UNIT#4] no resubmission when the account is no longer restricted', () => {
  const rows = [account(1, 'upheld', 'frozen')];
  const expired = {
    state: 'frozen',
    frozen_until: new Date(NOW.getTime() - 1),
    changed_at: SINCE,
  } as const;
  expect(appealAttempts(rows, expired, NOW).get(rows[0]!.id)?.can_resubmit).toBe(false);
  const normal = { state: 'normal', frozen_until: null, changed_at: SINCE } as const;
  expect(appealAttempts(rows, normal, NOW).get(rows[0]!.id)?.can_resubmit).toBe(false);
  expect(appealAttempts(rows, null, NOW).get(rows[0]!.id)?.can_resubmit).toBe(false);
});

it('[AC-CT-26e-UNIT#5] a revoked appeal or a frozen → banned change starts a new penalty at 1', () => {
  const rows = [
    account(1, 'upheld', 'frozen'),
    account(2, 'upheld', 'frozen'),
    account(3, 'upheld', 'frozen'),
    account(4, 'upheld', 'banned'),
    account(5, 'revoked', 'banned'),
    account(6, 'upheld', 'banned'),
  ];
  const result = appealAttempts(rows, BANNED, NOW);
  expect(rows.map((row) => result.get(row.id)?.attempt_no)).toEqual([1, 2, 3, 1, 2, 1]);
  // Escalated after three upheld appeals on the freeze: the ban is a new penalty.
  const escalated = rows.slice(0, 3);
  expect(appealAttempts(escalated, BANNED, NOW).get(rows[2]!.id)?.can_resubmit).toBe(true);
});

it('[AC-CT-26e-UNIT#6] order appeals count per order and never offer a resubmission yet', () => {
  const order = (n: number, target: string, status: string): AppealHistoryRow => ({
    id: `0199a3b4-5c6d-7e8f-9a0b-10000000000${n}`,
    target_type: 'order',
    target_id: target,
    status,
    prev_risk_state: null,
    created_at: new Date(Date.UTC(2026, 8, n)),
    closed_at: new Date(Date.UTC(2026, 8, n, 12)),
  });
  const rows = [order(1, 'a', 'upheld'), order(2, 'b', 'upheld'), order(3, 'a', 'upheld')];
  const result = appealAttempts(rows, BANNED, NOW);
  expect(rows.map((row) => result.get(row.id))).toEqual([
    { attempt_no: 1, can_resubmit: false },
    { attempt_no: 1, can_resubmit: false },
    { attempt_no: 2, can_resubmit: false },
  ]);
});

it('[AC-CT-26e-UNIT#9] after the third upheld appeal of one penalty can_resubmit is false whatever the current state', () => {
  const rows = [account(1, 'upheld'), account(2, 'upheld'), account(3, 'upheld')];
  // banned → frozen is the same penalty: the attempts stay used up.
  const frozen = { state: 'frozen', frozen_until: null, changed_at: SINCE } as const;
  expect(appealAttempts(rows, frozen, NOW).get(rows[2]!.id)).toEqual({
    attempt_no: 3,
    can_resubmit: false,
  });
  expect(appealAttempts(rows, BANNED, NOW).get(rows[2]!.id)?.can_resubmit).toBe(false);
});

const CLOSED = new Date(Date.UTC(2026, 8, 3, 12));

it('[AC-CT-26e-UNIT#10] nextAppealAttempt is the 30418 rule: above the cap only within one penalty', () => {
  expect(nextAppealAttempt(undefined, 0, 'banned')).toBe(1);
  expect(
    nextAppealAttempt(
      { status: 'upheld', prev_risk_state: 'banned', closed_at: CLOSED },
      3,
      'banned',
    ),
  ).toBe(4);
  expect(
    nextAppealAttempt(
      { status: 'upheld', prev_risk_state: 'banned', closed_at: CLOSED },
      3,
      'frozen',
    ),
  ).toBe(4);
  expect(
    nextAppealAttempt(
      { status: 'upheld', prev_risk_state: 'frozen', closed_at: CLOSED },
      3,
      'banned',
    ),
  ).toBe(1);
  expect(
    nextAppealAttempt(
      { status: 'revoked', prev_risk_state: 'banned', closed_at: CLOSED },
      3,
      'banned',
    ),
  ).toBe(1);
  expect(
    nextAppealAttempt({ status: 'upheld', prev_risk_state: null, closed_at: CLOSED }, 2, null),
  ).toBe(3);
});

// submit on a scripted driver: the user's risk row, no processing appeal, then the history.
function scripted(
  state: string,
  historyRows: readonly AppealHistoryRow[],
  changedAt: Date = SINCE,
  penaltyStartedAt: Date | null = null,
) {
  const statements: string[] = [];
  const compiled: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(query.sql);
      compiled.push(query);
      let rows: readonly unknown[] = [];
      if (query.sql.includes('from "app"."user_risk_state"')) {
        rows = [
          {
            state,
            reason: 'r',
            reason_category: 'other',
            frozen_until: null,
            changed_at: changedAt,
            penalty_started_at: penaltyStartedAt,
          },
        ];
      } else if (query.sql.includes('"status" = $')) {
        rows = [];
      } else if (query.sql.includes('from "app"."appeals"')) {
        rows = historyRows;
      }
      return Promise.resolve({ rows } as unknown as QueryResult<R>);
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const setRiskState = vi.fn(async () => undefined);
  const riskState = {
    readRiskState: vi.fn(),
    setRiskState,
    checkRequest: vi.fn(),
  } as unknown as RiskStateService;
  const service = createAppealsService({
    db,
    clock: { now: () => NOW } as unknown as Clock,
    riskState,
    config: { configValue: vi.fn(async () => null) } as unknown as RateLimitConfigReader,
    logger: { warn: vi.fn() } as unknown as Pick<RootLogger, 'warn'>,
  });
  const submit = () =>
    db.transaction().execute((trx) =>
      service.submit(
        trx,
        { app_id: 'couli', user_id: USER },
        {
          target_type: 'account',
          content: '请复核',
        },
      ),
    );
  return { statements, compiled, setRiskState, submit };
}

it('[AC-CT-26e-UNIT#11] three upheld appeals on the current penalty → 30418, nothing inserted, risk state unchanged', async () => {
  const s = scripted('banned', [account(1, 'upheld'), account(2, 'upheld'), account(3, 'upheld')]);
  expect(await s.submit()).toEqual({ code: 30418 });
  expect(s.statements.some((sql) => sql.startsWith('insert'))).toBe(false);
  expect(s.setRiskState).not.toHaveBeenCalled();
});

it('[AC-CT-26e-UNIT#12] attempts left, or a freeze escalated to a ban → the appeal is created with its attempt_no', async () => {
  const two = scripted('banned', [account(1, 'upheld'), account(2, 'upheld')]);
  const result = await two.submit();
  expect(result.code).toBe(0);
  expect(two.statements.some((sql) => sql.startsWith('insert into "app"."appeals"'))).toBe(true);
  expect(two.setRiskState).toHaveBeenCalledTimes(1);
  const escalated = scripted('banned', [
    account(1, 'upheld', 'frozen'),
    account(2, 'upheld', 'frozen'),
    account(3, 'upheld', 'frozen'),
  ]);
  expect((await escalated.submit()).code).toBe(0);
  expect(escalated.setRiskState).toHaveBeenCalledTimes(1);
});

it('[AC-CT-26e-UNIT#15] a state set after the latest appeal closed is a new penalty: next attempt 1, can_resubmit', () => {
  const upheld = { status: 'upheld', prev_risk_state: 'frozen', closed_at: CLOSED };
  // Restored by the closer at closed_at (or earlier): the same penalty.
  expect(nextAppealAttempt(upheld, 3, 'frozen', CLOSED)).toBe(4);
  // Freeze expired, then frozen again later: a new penalty.
  expect(nextAppealAttempt(upheld, 3, 'frozen', new Date(CLOSED.getTime() + 1))).toBe(1);
  const rows = [
    account(1, 'upheld', 'frozen'),
    account(2, 'upheld', 'frozen'),
    account(3, 'upheld', 'frozen'),
  ];
  const refrozen = {
    state: 'frozen',
    frozen_until: null,
    changed_at: new Date(Date.UTC(2026, 9, 1)),
  } as const;
  expect(appealAttempts(rows, refrozen, NOW).get(rows[2]!.id)).toEqual({
    attempt_no: 3,
    can_resubmit: true,
  });
});

it('[AC-CT-26e-UNIT#16] submit after a new penalty imposed since the third upheld appeal creates the appeal', async () => {
  const later = new Date(Date.UTC(2026, 9, 1));
  const s = scripted(
    'frozen',
    [
      account(1, 'upheld', 'frozen'),
      account(2, 'upheld', 'frozen'),
      account(3, 'upheld', 'frozen'),
    ],
    later,
  );
  expect((await s.submit()).code).toBe(0);
  expect(s.setRiskState).toHaveBeenCalledTimes(1);
});

const PENALTY_A = new Date(Date.UTC(2026, 7, 1));
const PENALTY_B = new Date(Date.UTC(2026, 8, 10));

function onPenalty(n: number, status: string, penalty: Date | null): AppealHistoryRow {
  return { ...account(n, status, 'frozen'), penalty_started_at: penalty };
}

it('[AC-B1-03v-UNIT#1] account appeals count within their own penalty_started_at group', () => {
  const rows = [
    onPenalty(1, 'upheld', PENALTY_A),
    onPenalty(2, 'upheld', PENALTY_A),
    onPenalty(3, 'upheld', PENALTY_A),
    { ...onPenalty(4, 'upheld', PENALTY_B), created_at: new Date(Date.UTC(2026, 8, 11)) },
  ];
  const result = appealAttempts(rows, null, NOW);
  expect(rows.map((row) => result.get(row.id)?.attempt_no)).toEqual([1, 2, 3, 1]);
});

it('[AC-B1-03v-UNIT#2] next attempt against the current penalty: same instant continues, another restarts', () => {
  const latest = onPenalty(3, 'upheld', PENALTY_A);
  expect(nextAppealAttempt(latest, 3, 'frozen', new Date(NOW.getTime()), PENALTY_A)).toBe(4);
  expect(nextAppealAttempt(latest, 3, 'frozen', CLOSED, PENALTY_B)).toBe(1);
  // A stock appeal (no instant) created before the current penalty began is an older penalty.
  const stock = onPenalty(3, 'upheld', null);
  expect(nextAppealAttempt(stock, 3, 'frozen', CLOSED, new Date(Date.UTC(2026, 9, 1)))).toBe(1);
  // Unknown on both sides: the CT-26e approximation (changed_at vs closed_at).
  expect(nextAppealAttempt(stock, 2, 'frozen', CLOSED, null)).toBe(3);
});

it('[AC-B1-03v-UNIT#3] can_resubmit follows the current penalty: an extended freeze keeps the cap, a new penalty frees it', () => {
  const rows = [
    onPenalty(1, 'upheld', PENALTY_A),
    onPenalty(2, 'upheld', PENALTY_A),
    onPenalty(3, 'upheld', PENALTY_A),
  ];
  const extended = {
    state: 'frozen',
    frozen_until: null,
    changed_at: new Date(Date.UTC(2026, 9, 1)),
    penalty_started_at: PENALTY_A,
  } as const;
  expect(appealAttempts(rows, extended, NOW).get(rows[2]!.id)).toEqual({
    attempt_no: 3,
    can_resubmit: false,
  });
  const fresh = { ...extended, penalty_started_at: new Date(Date.UTC(2026, 9, 1)) };
  expect(appealAttempts(rows, fresh, NOW).get(rows[2]!.id)).toEqual({
    attempt_no: 3,
    can_resubmit: true,
  });
});

it('[AC-B1-03v-UNIT#4] submit copies the risk row penalty_started_at into the new appeal', async () => {
  const s = scripted('frozen', [onPenalty(1, 'upheld', PENALTY_A)], SINCE, PENALTY_A);
  expect((await s.submit()).code).toBe(0);
  const insert = s.compiled.find((q) => q.sql.startsWith('insert into "app"."appeals"'))!;
  expect(insert.sql).toContain('"penalty_started_at"');
  expect(insert.parameters).toContainEqual(PENALTY_A);
});

it('[AC-B1-03v-UNIT#5] three upheld appeals of the current penalty → 30418 even after the state was set again (freeze extended)', async () => {
  const s = scripted(
    'frozen',
    [
      onPenalty(1, 'upheld', PENALTY_A),
      onPenalty(2, 'upheld', PENALTY_A),
      onPenalty(3, 'upheld', PENALTY_A),
    ],
    new Date(Date.UTC(2026, 9, 1)),
    PENALTY_A,
  );
  expect(await s.submit()).toEqual({ code: 30418 });
  expect(s.setRiskState).not.toHaveBeenCalled();
});

// ---- B1-03zl: order appeals (BR-ID-36 ②; 编排 D10-1181 ②, D10-1192 ②) ----

const ORDER_A = '0199a3b4-5c6d-7e8f-9a0b-2c2d3e4f5a01';
const ORDER_B = '0199a3b4-5c6d-7e8f-9a0b-2c2d3e4f5a02';
const OTHER_USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a02';

function orderAppeal(n: number, target: string, status: string): AppealHistoryRow {
  return {
    id: `0199a3b4-5c6d-7e8f-9a0b-20000000000${n}`,
    target_type: 'order',
    target_id: target,
    status,
    prev_risk_state: null,
    created_at: new Date(Date.UTC(2026, 8, n)),
    closed_at: status === 'processing' ? null : new Date(Date.UTC(2026, 8, n, 12)),
  };
}

it('[AC-B1-03zl-UNIT#1] an upheld order appeal is resubmittable only while its order is still risk-voided, it is the latest on the order and attempts are left', () => {
  const rows = [orderAppeal(1, ORDER_A, 'upheld'), orderAppeal(2, ORDER_B, 'upheld')];
  const voided = new Set([ORDER_A]);
  const result = appealAttempts(rows, null, NOW, voided);
  expect(result.get(rows[0]!.id)).toEqual({ attempt_no: 1, can_resubmit: true });
  // ORDER_B is no longer VOID + BLACKLIST.
  expect(result.get(rows[1]!.id)).toEqual({ attempt_no: 1, can_resubmit: false });
  // Without the orders port nothing is known to be voided.
  expect(appealAttempts(rows, null, NOW).get(rows[0]!.id)?.can_resubmit).toBe(false);
  // The account's state plays no part.
  expect(appealAttempts(rows, BANNED, NOW, voided).get(rows[0]!.id)?.can_resubmit).toBe(true);
});

it('[AC-B1-03zl-UNIT#2] order can_resubmit: false when not the latest, not upheld, or after the third upheld appeal', () => {
  const voided = new Set([ORDER_A]);
  const two = [orderAppeal(1, ORDER_A, 'upheld'), orderAppeal(2, ORDER_A, 'upheld')];
  const r2 = appealAttempts(two, null, NOW, voided);
  expect(two.map((row) => r2.get(row.id))).toEqual([
    { attempt_no: 1, can_resubmit: false },
    { attempt_no: 2, can_resubmit: true },
  ]);
  const processing = [orderAppeal(1, ORDER_A, 'upheld'), orderAppeal(2, ORDER_A, 'processing')];
  expect(appealAttempts(processing, null, NOW, voided).get(processing[1]!.id)).toEqual({
    attempt_no: 2,
    can_resubmit: false,
  });
  const revoked = [orderAppeal(1, ORDER_A, 'revoked')];
  expect(appealAttempts(revoked, null, NOW, voided).get(revoked[0]!.id)?.can_resubmit).toBe(false);
  const three = [
    orderAppeal(1, ORDER_A, 'upheld'),
    orderAppeal(2, ORDER_A, 'upheld'),
    orderAppeal(3, ORDER_A, 'upheld'),
  ];
  expect(appealAttempts(three, null, NOW, voided).get(three[2]!.id)).toEqual({
    attempt_no: 3,
    can_resubmit: false,
  });
});

interface OrderScript {
  /** The order the port answers (null: unknown). */
  readonly order?: AppealOrderTarget | null;
  /** Answers of the processing-appeal reads, in turn (default: none). */
  readonly processing?: readonly (readonly unknown[])[];
  readonly history?: readonly AppealHistoryRow[];
  /** Whether the insert loses to a concurrent one (ON CONFLICT DO NOTHING returns no row). */
  readonly conflict?: boolean;
  /** Wire no orders port. */
  readonly noPort?: boolean;
}

// submit on a scripted driver for target_type=order: the orders port is a stub.
function orderScripted(script: OrderScript) {
  const compiled: CompiledQuery[] = [];
  const processing = [...(script.processing ?? [])];
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      compiled.push(query);
      let rows: readonly unknown[] = [];
      if (query.sql.startsWith('insert into "app"."appeals"')) {
        rows = script.conflict === true ? [] : [{ id: 'inserted' }];
      } else if (query.sql.includes('from "app"."appeals"') && query.sql.includes('"status" = $')) {
        rows = processing.shift() ?? [];
      } else if (query.sql.includes('from "app"."appeals"')) {
        rows = script.history ?? [];
      }
      return Promise.resolve({ rows } as unknown as QueryResult<R>);
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const setRiskState = vi.fn(async () => undefined);
  const riskState = {
    readRiskState: vi.fn(),
    setRiskState,
    checkRequest: vi.fn(),
  } as unknown as RiskStateService;
  const orderTarget = vi.fn(async () => (script.order === undefined ? null : script.order));
  const reader: AppealOrderReader = {
    orderTarget,
    riskVoidedOrderIds: vi.fn(async () => new Set<string>()),
  };
  const ordersOn = vi.fn(() => reader);
  const service = createAppealsService({
    db,
    clock: { now: () => NOW } as unknown as Clock,
    riskState,
    config: { configValue: vi.fn(async () => null) } as unknown as RateLimitConfigReader,
    logger: { warn: vi.fn() } as unknown as Pick<RootLogger, 'warn'>,
    ...(script.noPort === true ? {} : { ordersOn }),
  });
  const submit = (targetId?: string) =>
    db.transaction().execute((trx) =>
      service.submit(
        trx,
        { app_id: 'couli', user_id: USER },
        {
          target_type: 'order',
          ...(targetId === undefined ? {} : { target_id: targetId }),
          content: '订单返利被作废',
        },
      ),
    );
  const inserts = () => compiled.filter((q) => q.sql.startsWith('insert'));
  return { compiled, setRiskState, orderTarget, ordersOn, submit, inserts };
}

const MINE_VOIDED: AppealOrderTarget = { user_id: USER, risk_voided: true };

it('[AC-B1-03zl-UNIT#3] order target checks: no order_id or not risk-voided → 20001; unknown, malformed or not mine → 30701; nothing written', async () => {
  const none = orderScripted({ order: MINE_VOIDED });
  expect(await none.submit()).toEqual({ code: 20001, fields: ['target_id'] });
  expect(none.orderTarget).not.toHaveBeenCalled();

  const malformed = orderScripted({ order: MINE_VOIDED });
  expect(await malformed.submit('not-an-order')).toEqual({ code: 30701 });
  expect(malformed.orderTarget).not.toHaveBeenCalled();

  for (const order of [
    null,
    { user_id: OTHER_USER, risk_voided: true },
    { user_id: null, risk_voided: true },
  ]) {
    const s = orderScripted({ order });
    expect(await s.submit(ORDER_A)).toEqual({ code: 30701 });
    expect(s.orderTarget).toHaveBeenCalledWith('couli', ORDER_A);
    expect(s.inserts()).toEqual([]);
  }

  const notVoided = orderScripted({ order: { user_id: USER, risk_voided: false } });
  expect(await notVoided.submit(ORDER_A)).toEqual({ code: 20001, fields: ['target_id'] });
  expect(notVoided.inserts()).toEqual([]);
  expect(notVoided.setRiskState).not.toHaveBeenCalled();

  // No orders port wired: an order cannot be judged.
  const unwired = orderScripted({ order: MINE_VOIDED, noPort: true });
  expect((await unwired.submit(ORDER_A)).code).toBe(20001);
  expect(unwired.inserts()).toEqual([]);
});

it('[AC-B1-03zl-UNIT#4] the order_id is matched in lowercase and the port reads on the submission transaction', async () => {
  const s = orderScripted({ order: MINE_VOIDED });
  const result = await s.submit(ORDER_A.toUpperCase());
  expect(result.code).toBe(0);
  expect(s.orderTarget).toHaveBeenCalledWith('couli', ORDER_A);
  expect(s.ordersOn).toHaveBeenCalledTimes(1);
  expect(result.code === 0 && result.data.target_id).toBe(ORDER_A);
});

it('[AC-B1-03zl-UNIT#5] a processing appeal on the order is returned before the count; three upheld → 30418; nothing written', async () => {
  const existing = {
    id: '0199a3b4-5c6d-7e8f-9a0b-200000000009',
    target_type: 'order',
    target_id: ORDER_A,
    status: 'processing',
    content: '原单',
    created_at: new Date(Date.UTC(2026, 8, 9)),
    closed_at: null,
  };
  const used = [
    orderAppeal(1, ORDER_A, 'upheld'),
    orderAppeal(2, ORDER_A, 'upheld'),
    orderAppeal(3, ORDER_A, 'upheld'),
  ];
  const back = orderScripted({
    order: MINE_VOIDED,
    processing: [[existing]],
    history: [...used, { ...existing, prev_risk_state: null }],
  });
  const result = await back.submit(ORDER_A);
  expect(result).toMatchObject({
    code: 0,
    data: { appeal_id: existing.id, status: 'processing', content: '原单', can_resubmit: false },
  });
  expect(back.inserts()).toEqual([]);

  const usedUp = orderScripted({ order: MINE_VOIDED, history: used });
  expect(await usedUp.submit(ORDER_A)).toEqual({ code: 30418 });
  expect(usedUp.inserts()).toEqual([]);
  expect(usedUp.setRiskState).not.toHaveBeenCalled();
});

it('[AC-B1-03zl-UNIT#6] a new order appeal leaves the account risk state alone and inserts on the processing-target conflict guard', async () => {
  const s = orderScripted({
    order: MINE_VOIDED,
    history: [orderAppeal(1, ORDER_A, 'upheld')],
  });
  const result = await s.submit(ORDER_A);
  expect(result).toMatchObject({
    code: 0,
    data: { target_type: 'order', target_id: ORDER_A, status: 'processing', closed_at: null },
  });
  expect(s.setRiskState).not.toHaveBeenCalled();
  const [insert] = s.inserts();
  expect(insert?.sql).toContain(
    'on conflict ("app_id", "target_type", "target_id") where "status" = $',
  );
  expect(insert?.sql).toContain('do nothing');
  expect(insert?.parameters).toContain('order');
  expect(insert?.parameters).toContain(ORDER_A);
  // prev_risk_state and penalty_started_at are null for an order appeal.
  expect(insert?.sql).toContain('"prev_risk_state"');
  expect(insert?.sql).toContain('"penalty_started_at"');
  expect(insert?.parameters.filter((value) => value === null).length).toBeGreaterThanOrEqual(3);
});

it('[AC-B1-03zl-UNIT#7] losing the insert to a concurrent submission returns the winner, nothing else written', async () => {
  const winner = {
    id: '0199a3b4-5c6d-7e8f-9a0b-20000000000a',
    target_type: 'order',
    target_id: ORDER_A,
    status: 'processing',
    content: '并发',
    created_at: NOW,
    closed_at: null,
  };
  const s = orderScripted({
    order: MINE_VOIDED,
    processing: [[], [winner]],
    history: [{ ...winner, prev_risk_state: null }],
    conflict: true,
  });
  const result = await s.submit(ORDER_A);
  expect(result).toMatchObject({ code: 0, data: { appeal_id: winner.id, attempt_no: 1 } });
  expect(s.setRiskState).not.toHaveBeenCalled();

  const gone = orderScripted({ order: MINE_VOIDED, processing: [[], []], conflict: true });
  await expect(gone.submit(ORDER_A)).rejects.toThrow(/gone/);
});

it('[AC-B1-03zl-UNIT#8] order attempt_no counts every appeal on the order, a revoked one included, and never restarts', () => {
  const voided = new Set([ORDER_A]);
  const rows = [
    orderAppeal(1, ORDER_A, 'revoked'),
    orderAppeal(2, ORDER_A, 'upheld'),
    orderAppeal(3, ORDER_B, 'upheld'),
  ];
  const result = appealAttempts(rows, null, NOW, voided);
  expect(rows.map((row) => result.get(row.id))).toEqual([
    { attempt_no: 1, can_resubmit: false },
    // Continues after the revoked one (an account would restart at 1 here).
    { attempt_no: 2, can_resubmit: true },
    { attempt_no: 1, can_resubmit: false },
  ]);
  const third = [
    orderAppeal(1, ORDER_A, 'upheld'),
    orderAppeal(2, ORDER_A, 'revoked'),
    orderAppeal(3, ORDER_A, 'upheld'),
  ];
  expect(appealAttempts(third, null, NOW, voided).get(third[2]!.id)).toEqual({
    attempt_no: 3,
    can_resubmit: false,
  });
});

it('[AC-B1-03zl-UNIT#9] three appeals on the order, the third revoked → 30418; two with one revoked still leaves the third', async () => {
  const usedUp = orderScripted({
    order: MINE_VOIDED,
    history: [
      orderAppeal(1, ORDER_A, 'upheld'),
      orderAppeal(2, ORDER_A, 'upheld'),
      orderAppeal(3, ORDER_A, 'revoked'),
    ],
  });
  expect(await usedUp.submit(ORDER_A)).toEqual({ code: 30418 });
  expect(usedUp.inserts()).toEqual([]);
  expect(usedUp.setRiskState).not.toHaveBeenCalled();

  // Two earlier appeals, one revoked: one attempt is left, so the third is inserted. (Its
  // attempt_no = 3 is #8's appealAttempts rule; the scripted driver's history cannot hold the
  // new row, whose id is generated.)
  const third = orderScripted({
    order: MINE_VOIDED,
    history: [orderAppeal(1, ORDER_A, 'revoked'), orderAppeal(2, ORDER_A, 'upheld')],
  });
  const result = await third.submit(ORDER_A);
  expect(result.code).toBe(0);
  expect(third.inserts()).toHaveLength(1);
});

it('[AC-B1-03zl-UNIT#10] the per-order advisory lock is taken after the target checks and before the appeals are read', async () => {
  const s = orderScripted({ order: MINE_VOIDED, history: [orderAppeal(1, ORDER_A, 'upheld')] });
  expect((await s.submit(ORDER_A)).code).toBe(0);
  const lock = s.compiled.findIndex((q) => q.sql.includes('pg_advisory_xact_lock'));
  const firstAppealRead = s.compiled.findIndex((q) => q.sql.includes('from "app"."appeals"'));
  expect(lock).toBeGreaterThanOrEqual(0);
  expect(lock).toBeLessThan(firstAppealRead);
  expect(s.compiled[lock]!.sql).toContain('hashtextextended(');
  expect(s.compiled[lock]!.parameters).toEqual([`risk.appeals.order:couli:${ORDER_A}`]);
  expect(s.compiled.filter((q) => q.sql.includes('pg_advisory_xact_lock'))).toHaveLength(1);

  // Refused before the lock: an order that is not the caller's takes no lock.
  const other = orderScripted({ order: { user_id: OTHER_USER, risk_voided: true } });
  expect(await other.submit(ORDER_A)).toEqual({ code: 30701 });
  expect(other.compiled.some((q) => q.sql.includes('pg_advisory_xact_lock'))).toBe(false);
});

it('[AC-B1-03zl-UNIT#11] the order count reads every appeal on the order of the app, not only the caller’s', async () => {
  const s = orderScripted({ order: MINE_VOIDED });
  expect((await s.submit(ORDER_A)).code).toBe(0);
  const count = s.compiled.find(
    (q) => q.sql.includes('from "app"."appeals"') && !q.sql.includes('"status" = $'),
  )!;
  expect(count.sql).toContain('"app_id" = $');
  expect(count.sql).toContain('"target_type" = $');
  expect(count.sql).toContain('"target_id" = $');
  expect(count.sql).not.toContain('"user_id" = $');
});
