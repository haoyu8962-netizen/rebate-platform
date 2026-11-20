// B2-02x unit tests (no database): recalcBalanceAdminReconDiff's order of work on one transaction
// — the difference row, identity's users lock, the balance row lock, the sums, then the write, the
// 跨零 calls, the member notice and the audit record — and what each refusal leaves out. The stores are replaced; the
// rule tests (test/spec/ledger/admin-recon-balance-recalc/**) run the real ones on PostgreSQL.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { beforeEach, expect, it, vi } from 'vitest';
import { FixedClock, type AuditInput, type EventBus } from '../../platform/index.ts';
import {
  recalcAccountOf,
  recalcBalanceAdminReconDiff,
  type BalanceCorrectedNotice,
  type BalanceRecalcDeps,
  type BalanceRecalcDiffRow,
} from './admin-recon-diff-balance-recalc-use-case.ts';
import type { BalanceRecoveredInput } from './ledger.ts';

const state = vi.hoisted(() => ({
  calls: [] as string[],
  diff: undefined as unknown,
  owner: undefined as string | undefined,
  balances: [] as unknown[],
  sums: { available_fen: 0n, frozen_fen: 0n },
  written: true,
  updates: [] as unknown[],
}));

vi.mock('../infra/recon-diffs-store.ts', async (original) => ({
  ...(await original<object>()),
  lockAdminReconDiff: vi.fn(() => {
    state.calls.push('lockDiff');
    return Promise.resolve(state.diff);
  }),
}));

vi.mock('../infra/balance-recalc-store.ts', () => ({
  userBalanceAccountOwner: vi.fn(() => {
    state.calls.push('owner');
    return Promise.resolve(state.owner);
  }),
  memberEntrySums: vi.fn(() => {
    state.calls.push('sums');
    return Promise.resolve(state.sums);
  }),
}));

vi.mock('../infra/store.ts', async (original) => ({
  ...(await original<object>()),
  lockBalancesByUser: vi.fn(() => {
    state.calls.push('lockBalance');
    return Promise.resolve(state.balances);
  }),
  updateBalance: vi.fn((_trx: unknown, _appId: string, update: unknown) => {
    state.calls.push('update');
    state.updates.push(update);
    return Promise.resolve(state.written);
  }),
}));

const APP = 'app_unit';
const ADMIN = '0199a3b4-5c6d-7e8f-9a0b-0000000000ad';
const DIFF = '0199a3b4-5c6d-7e8f-9a0b-0000000000d1';
const ACCOUNT = '0199a3b4-5c6d-7e8f-9a0b-0000000000c1';
const USER = '0199a3b4-5c6d-7e8f-9a0b-0000000000a1';
const NOW = '2026-11-18T16:30:00.000Z';
const TRX = { marker: 'recalc-trx' } as unknown as Transaction<DB>;

function diffRow(patch: Partial<BalanceRecalcDiffRow> = {}): BalanceRecalcDiffRow {
  return {
    type: 'ledger_mismatch',
    source: 'R3',
    status: 'open',
    ref_type: 'ledger_account',
    ref_id: `01:${ACCOUNT}`,
    ...patch,
  };
}

function balance(available: bigint, frozen: bigint, negativeSince: string | null = null) {
  return {
    app_id: APP,
    account_id: ACCOUNT,
    user_id: USER,
    available_fen: available,
    frozen_fen: frozen,
    version: 9n,
    negative_since: negativeSince,
  };
}

interface Harness {
  readonly deps: BalanceRecalcDeps;
  readonly audits: AuditInput[];
  readonly events: unknown[];
  readonly recovered: BalanceRecoveredInput[];
  readonly notices: BalanceCorrectedNotice[];
  readonly transactions: () => number;
}

function harness(lockedUsers: readonly string[] = [USER]): Harness {
  const audits: AuditInput[] = [];
  const events: unknown[] = [];
  const recovered: BalanceRecoveredInput[] = [];
  const notices: BalanceCorrectedNotice[] = [];
  let transactions = 0;
  const db = {
    transaction: () => ({
      execute: <T>(work: (trx: Transaction<DB>) => Promise<T>) => {
        transactions += 1;
        return work(TRX);
      },
    }),
  } as unknown as Kysely<DB>;
  const eventBus: EventBus = {
    publish: (trx, event) => {
      expect(trx).toBe(TRX);
      state.calls.push('event');
      events.push(event);
      return Promise.resolve({ eventId: 'e1', duplicate: false });
    },
  };
  return {
    deps: {
      db,
      clock: new FixedClock(NOW),
      auditOn: (trx) => {
        expect(trx).toBe(TRX);
        return {
          append: (input) => {
            state.calls.push('audit');
            audits.push(input);
            return Promise.resolve();
          },
        };
      },
      lockUsers: (trx, input) => {
        expect(trx).toBe(TRX);
        expect(input).toEqual({ appId: APP, userIds: [USER] });
        state.calls.push('lockUsers');
        return Promise.resolve(new Set(lockedUsers));
      },
      eventBus,
      balanceRecovered: {
        onRecovered: (trx, input) => {
          expect(trx).toBe(TRX);
          state.calls.push('recovered');
          recovered.push(input);
          return Promise.resolve();
        },
      },
      balanceCorrected: (trx, input) => {
        expect(trx).toBe(TRX);
        state.calls.push('notice');
        notices.push(input);
        return Promise.resolve(true);
      },
    },
    audits,
    events,
    recovered,
    notices,
    transactions: () => transactions,
  };
}

function call(h: Harness, reason = ' 核对无误 ', id = DIFF) {
  return recalcBalanceAdminReconDiff(h.deps, { appId: APP, adminId: ADMIN, ip: '127.0.0.1' }, id, {
    body: { reason },
    traceId: 'trace-1',
  });
}

const NOT_APPLICABLE = {
  status: 400,
  envelope: {
    code: 20001,
    msg: '参数校验失败',
    data: { fields: ['recon_diff_id'] },
    trace_id: 'trace-1',
  },
};

beforeEach(() => {
  state.calls = [];
  state.diff = diffRow();
  state.owner = USER;
  state.balances = [balance(200n, 0n)];
  state.sums = { available_fen: 200n, frozen_fen: 0n };
  state.written = true;
  state.updates = [];
});

it('[AC-B2-02x-UNIT#8] 原因去空白后为空 → 20001 [reason]；id 不是 UUID → 20001 [recon_diff_id]；都不开事务', async () => {
  const h = harness();
  expect(await call(h, ' \t ')).toMatchObject({
    status: 400,
    envelope: { code: 20001, data: { fields: ['reason'] } },
  });
  expect(await call(h, '核对', 'not-a-uuid')).toEqual(NOT_APPLICABLE);
  expect(h.transactions()).toBe(0);
  expect(state.calls).toEqual([]);
});

it('[AC-B2-02x-UNIT#9] 变负：差错单行 → 账户归属 → users 行 → 余额行 → 合计 → CAS 写回 → account.went_negative → 站内信 → 审计，同一事务；应答 before / after 与时钟', async () => {
  state.sums = { available_fen: -300n, frozen_fen: 0n };
  const h = harness();
  const sent = await call(h);
  expect(state.calls).toEqual([
    'lockDiff',
    'owner',
    'lockUsers',
    'lockBalance',
    'sums',
    'update',
    'event',
    'notice',
    'audit',
  ]);
  expect(h.transactions()).toBe(1);
  expect(state.updates).toEqual([
    {
      account_id: ACCOUNT,
      expected_version: 9n,
      available_fen: -300n,
      frozen_fen: 0n,
      version: 10n,
      // NOW is 00:30 on 2026-11-19 at +08:00: the accounting day, not the UTC date.
      negative_since: '2026-11-19',
    },
  ]);
  expect(h.events).toEqual([
    { appId: APP, name: 'account.went_negative', payload: { user_id: USER } },
  ]);
  expect(h.recovered).toEqual([]);
  expect(h.notices).toEqual([
    {
      appId: APP,
      userId: USER,
      reconDiffId: DIFF,
      balanceVersion: 10,
      facts: { before_fen: 200n, after_fen: -300n },
      now: new Date(NOW),
    },
  ]);
  expect(h.audits).toEqual([
    {
      appId: APP,
      actor: ADMIN,
      action: 'recon_diff_balance_recalc',
      target: DIFF,
      before: { available_fen: '200', frozen_fen: '0' },
      after: {
        recon_diff_id: DIFF,
        user_id: USER,
        reason: '核对无误',
        changed: true,
        available_fen: '-300',
        frozen_fen: '0',
      },
      ip: '127.0.0.1',
    },
  ]);
  expect(sent).toEqual({
    status: 200,
    envelope: {
      code: 0,
      msg: '',
      data: {
        user_id: USER,
        before: { available_fen: 200, frozen_fen: 0 },
        after: { available_fen: -300, frozen_fen: 0 },
        changed: true,
        recalculated_at: NOW,
      },
      trace_id: 'trace-1',
    },
  });
});

it('[AC-B2-02x-UNIT#10] 回正：恢复钩子恰调一次（前后 available、会员、账户，来源号 recalc:<差错单>:<重算后版本>），不发事件；站内信一条', async () => {
  state.balances = [balance(-200n, 100n, '2026-10-02')];
  state.sums = { available_fen: 500n, frozen_fen: 100n };
  const h = harness();
  expect(await call(h)).toMatchObject({ status: 200, envelope: { data: { changed: true } } });
  expect(state.calls.slice(-4)).toEqual(['update', 'recovered', 'notice', 'audit']);
  expect(h.recovered).toEqual([
    {
      appId: APP,
      userId: USER,
      accountId: ACCOUNT,
      availableBefore: -200n,
      availableAfter: 500n,
      voucherId: `recalc:${DIFF}:10`,
    },
  ]);
  expect(h.notices).toMatchObject([
    { reconDiffId: DIFF, balanceVersion: 10, facts: { before_fen: -200n, after_fen: 500n } },
  ]);
  expect(h.events).toEqual([]);
  expect(state.updates).toMatchObject([{ negative_since: null, version: 10n }]);
});

it('[AC-B2-02x-UNIT#11] 前后相同：不写余额行、不跨零，审计照写（changed false），应答 200', async () => {
  const h = harness();
  const sent = await call(h);
  expect(state.calls).toEqual(['lockDiff', 'owner', 'lockUsers', 'lockBalance', 'sums', 'audit']);
  expect(h.audits[0]?.after).toMatchObject({ changed: false });
  expect(h.notices).toEqual([]);
  expect(sent).toMatchObject({
    status: 200,
    envelope: {
      data: {
        before: { available_fen: 200, frozen_fen: 0 },
        after: { available_fen: 200, frozen_fen: 0 },
        changed: false,
      },
    },
  });
});

it('[AC-B2-02x-UNIT#12] 合计不能作余额（frozen 为负）：只写拒绝审计后回 20001 [recon_diff_id]，不写余额行、不发事件、不调钩子', async () => {
  state.balances = [balance(-100n, 0n, '2026-10-02')];
  state.sums = { available_fen: 1700n, frozen_fen: -700n };
  const h = harness();
  expect(await call(h)).toEqual(NOT_APPLICABLE);
  expect(state.calls).toEqual(['lockDiff', 'owner', 'lockUsers', 'lockBalance', 'sums', 'audit']);
  expect(h.audits[0]?.after).toMatchObject({ refused: 'frozen_negative', changed: false });
  expect(h.events).toEqual([]);
  expect(h.recovered).toEqual([]);
  expect(h.notices).toEqual([]);
});

it('[AC-B2-02x-UNIT#13] 不适用的差错单：未知单号、类型 / 来源 / 状态不符、不指向会员账户 → 20001 [recon_diff_id]，不加 users 锁、不写审计', async () => {
  const refused: unknown[] = [
    undefined,
    diffRow({ type: 'union_mismatch' }),
    diffRow({ source: 'R1' }),
    diffRow({ status: 'closed' }),
    diffRow({ ref_type: 'voucher' }),
  ];
  for (const row of refused) {
    state.calls = [];
    state.diff = row;
    const h = harness();
    expect(await call(h)).toEqual(NOT_APPLICABLE);
    expect(state.calls).not.toContain('lockUsers');
    expect(h.audits).toEqual([]);
  }
  state.calls = [];
  state.diff = diffRow();
  state.owner = undefined;
  const h = harness();
  expect(await call(h)).toEqual(NOT_APPLICABLE);
  expect(state.calls).toEqual(['lockDiff', 'owner']);
});

it('[AC-B2-02x-UNIT#14] users 行不在本应用、余额行不存在 → 20001 [recon_diff_id]，不读合计、不写审计', async () => {
  const noUser = harness([]);
  expect(await call(noUser)).toEqual(NOT_APPLICABLE);
  expect(state.calls).toEqual(['lockDiff', 'owner', 'lockUsers']);
  state.calls = [];
  state.balances = [{ ...balance(1n, 0n), account_id: '0199a3b4-5c6d-7e8f-9a0b-0000000000c2' }];
  const noRow = harness();
  expect(await call(noRow)).toEqual(NOT_APPLICABLE);
  expect(state.calls).toEqual(['lockDiff', 'owner', 'lockUsers', 'lockBalance']);
  expect([...noUser.audits, ...noRow.audits]).toEqual([]);
});

it('[AC-B2-02x-UNIT#15] CAS 落空 → 抛出（整笔回滚），不发事件、不写站内信、不写审计', async () => {
  state.sums = { available_fen: -300n, frozen_fen: 0n };
  state.written = false;
  const h = harness();
  await expect(call(h)).rejects.toThrow(/changed under its lock/);
  expect(h.events).toEqual([]);
  expect(h.notices).toEqual([]);
  expect(h.audits).toEqual([]);
});

const JSON_MAX = 9_007_199_254_740_991n;

it('[AC-B2-02x-UNIT#21] 应答装不下的值（合计或锁内缓存超出 ±(2^53 − 1)）→ 只写拒绝审计后回 20001 [recon_diff_id]，不写余额行、不跨零、不写站内信；恰好 ±(2^53 − 1) 照常写', async () => {
  const cases = [
    {
      balance: balance(0n, 0n),
      sums: { available_fen: JSON_MAX + 1n, frozen_fen: 0n },
      cause: 'sum_out_of_range',
    },
    {
      balance: balance(0n, 0n),
      sums: { available_fen: -JSON_MAX - 1n, frozen_fen: 0n },
      cause: 'sum_out_of_range',
    },
    {
      balance: balance(0n, 0n),
      sums: { available_fen: 0n, frozen_fen: JSON_MAX + 1n },
      cause: 'sum_out_of_range',
    },
    {
      balance: balance(JSON_MAX + 1n, 0n),
      sums: { available_fen: 10n, frozen_fen: 0n },
      cause: 'cache_out_of_range',
    },
    {
      balance: balance(-5n, JSON_MAX + 1n, '2026-10-02'),
      sums: { available_fen: 10n, frozen_fen: 0n },
      cause: 'cache_out_of_range',
    },
  ];
  for (const c of cases) {
    state.calls = [];
    state.balances = [c.balance];
    state.sums = c.sums;
    const h = harness();
    expect(await call(h), c.cause).toEqual(NOT_APPLICABLE);
    expect(state.calls).toEqual(['lockDiff', 'owner', 'lockUsers', 'lockBalance', 'sums', 'audit']);
    expect(h.audits[0]?.after).toMatchObject({ changed: false, refused: c.cause });
    expect(h.events).toEqual([]);
    expect(h.recovered).toEqual([]);
    expect(h.notices).toEqual([]);
  }

  state.calls = [];
  state.balances = [balance(JSON_MAX, 0n)];
  state.sums = { available_fen: -JSON_MAX, frozen_fen: JSON_MAX };
  const edge = harness();
  expect(await call(edge)).toMatchObject({
    status: 200,
    envelope: {
      data: {
        before: { available_fen: Number(JSON_MAX), frozen_fen: 0 },
        after: { available_fen: -Number(JSON_MAX), frozen_fen: Number(JSON_MAX) },
        changed: true,
      },
    },
  });
  expect(state.updates).toMatchObject([{ available_fen: -JSON_MAX, frozen_fen: JSON_MAX }]);
});

it('[AC-B2-02x-UNIT#22] 只改 frozen（含下调）：写余额行（frozen 写成合计、version + 1），不写站内信；available 与 frozen 同时下调：都写成合计，站内信一条', async () => {
  state.balances = [balance(300n, 500n)];
  state.sums = { available_fen: 300n, frozen_fen: 100n };
  const frozenDown = harness();
  expect(await call(frozenDown)).toMatchObject({
    status: 200,
    envelope: { data: { changed: true } },
  });
  expect(state.updates).toEqual([
    {
      account_id: ACCOUNT,
      expected_version: 9n,
      available_fen: 300n,
      frozen_fen: 100n,
      version: 10n,
      negative_since: null,
    },
  ]);
  expect(frozenDown.notices).toEqual([]);

  state.calls = [];
  state.updates = [];
  state.balances = [balance(900n, 500n)];
  state.sums = { available_fen: 200n, frozen_fen: 0n };
  const bothDown = harness();
  expect(await call(bothDown)).toMatchObject({
    status: 200,
    envelope: { data: { changed: true } },
  });
  expect(state.updates).toMatchObject([{ available_fen: 200n, frozen_fen: 0n, version: 10n }]);
  expect(bothDown.notices).toMatchObject([{ facts: { before_fen: 900n, after_fen: 200n } }]);
});

it('[AC-B2-02x-UNIT#16] recalcAccountOf：只认 {invariant}:{uuid}（恰一个冒号、UUID 转小写），其余为 undefined', () => {
  expect(recalcAccountOf(diffRow({ ref_id: `06:${ACCOUNT.toUpperCase()}` }))).toBe(ACCOUNT);
  expect(recalcAccountOf(diffRow({ status: 'processing' }))).toBe(ACCOUNT);
  for (const ref_id of [ACCOUNT, `:${ACCOUNT}`, '01:not-a-uuid', `01:${ACCOUNT}:extra`, null]) {
    expect(recalcAccountOf(diffRow({ ref_id })), String(ref_id)).toBeUndefined();
  }
  for (const status of ['adjusted', 'written_off', 'closed']) {
    expect(recalcAccountOf(diffRow({ status })), status).toBeUndefined();
  }
});
