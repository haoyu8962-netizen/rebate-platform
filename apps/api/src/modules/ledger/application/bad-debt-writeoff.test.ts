// B2-12g unit tests (no database): the approval calls risk's linked-accounts marker on the approving
// transaction only when it writes the BAD_DEBT_WRITEOFF voucher, before the audit row; never on a
// CANCELLED candidate or the frozen refusal. The store is replaced; the rule tests run the real one.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { beforeEach, expect, it, vi, type Mock } from 'vitest';
import {
  FixedClock,
  type HandlerResult,
  type Idempotency,
  type IdempotentResponse,
} from '../../platform/index.ts';
import type { BadDebtWriteoffRow } from '../infra/bad-debt-writeoffs-store.ts';
import {
  approveAdminBadDebtWriteoff,
  type AdminBadDebtWriteoffApproveDeps,
  type BadDebtWriteoffPorts,
} from './bad-debt-writeoff.ts';
import type { AccountBalance } from './ledger.ts';
import type { Ledger } from './reverse.ts';

const store = vi.hoisted(() => ({
  row: undefined as unknown,
  status: 'PENDING' as string,
}));

vi.mock('../infra/bad-debt-writeoffs-store.ts', () => ({
  findBadDebtWriteoff: vi.fn(() => Promise.resolve(store.row)),
  lockBadDebtWriteoffStatus: vi.fn(() => Promise.resolve(store.status)),
  cancelBadDebtWriteoff: vi.fn(() => Promise.resolve(1)),
  approveBadDebtWriteoffRow: vi.fn(() => Promise.resolve(1)),
  appsWithUserAccounts: vi.fn(),
  countBadDebtWriteoffs: vi.fn(),
  hasProcessedEvent: vi.fn(),
  insertPendingWriteoff: vi.fn(),
  negativeBalancesDue: vi.fn(),
  pageBadDebtWriteoffs: vi.fn(),
}));

const APP = 'app_unit';
const CANDIDATE = '01900000-0000-7000-8000-00000000000a';
const ACCOUNT = '01900000-0000-7000-8000-00000000000b';
const USER = '01900000-0000-7000-8000-00000000000c';
const ADMIN = '01900000-0000-7000-8000-00000000000d';
const VOUCHER = '01900000-0000-7000-8000-00000000000e';
const TRX = { name: 'the approving transaction' } as unknown as Transaction<DB>;

function candidate(): BadDebtWriteoffRow {
  return {
    id: CANDIDATE,
    app_id: APP,
    account_id: ACCOUNT,
    user_id: USER,
    negative_since: '2026-07-01',
    candidate_fen: 800n,
    status: 'PENDING',
    initiator_id: null,
    approver_id: null,
    approved_at: null,
    voucher_id: null,
    created_at: new Date('2026-10-01T00:00:00.000Z'),
    available_fen: -800n,
    frozen_fen: 0n,
  };
}

interface Harness {
  readonly deps: AdminBadDebtWriteoffApproveDeps;
  readonly calls: string[];
  readonly mark: Mock<BadDebtWriteoffPorts['markLinkedAccounts']>;
}

function harness(
  balance: { available: bigint; frozen: bigint },
  options: { requireNoFrozen?: boolean } = {},
): Harness {
  const calls: string[] = [];
  const mark = vi.fn<BadDebtWriteoffPorts['markLinkedAccounts']>((trx) => {
    expect(trx).toBe(TRX);
    calls.push('mark');
    return Promise.resolve();
  });
  const locked: AccountBalance = {
    app_id: APP,
    account_id: ACCOUNT,
    user_id: USER,
    available_fen: balance.available,
    frozen_fen: balance.frozen,
    version: 1n,
    negative_since: balance.available < 0n ? '2026-07-01' : null,
  };
  const ports: BadDebtWriteoffPorts = {
    thresholds: () => Promise.resolve({ days: 90, minFen: 0n }),
    requireNoFrozen: () => Promise.resolve(options.requireNoFrozen ?? true),
    closingUsers: () => Promise.resolve(new Set<string>()),
    lockUsersForUpdate: () => Promise.resolve(undefined),
    markLinkedAccounts: mark,
  };
  const ledger = {
    lockBalances: () => Promise.resolve([locked]),
    post: () => {
      calls.push('post');
      return Promise.resolve({ kind: 'posted', voucherId: VOUCHER });
    },
  } as unknown as Ledger;
  const idempotency = {
    executeInTransaction: async (
      _request: unknown,
      handler: (trx: Transaction<DB>) => Promise<HandlerResult>,
    ): Promise<IdempotentResponse> => {
      const result = await handler(TRX);
      return { statusCode: result.status, body: result.envelope } as unknown as IdempotentResponse;
    },
  } as unknown as Idempotency;
  return {
    calls,
    mark,
    deps: {
      db: {} as never,
      clock: new FixedClock('2026-10-20T04:00:00.000Z'),
      idempotency,
      ledger,
      auditOn: () => ({
        append: () => {
          calls.push('audit');
          return Promise.resolve();
        },
      }),
      ports,
    },
  };
}

function approveWith(h: Harness) {
  return approveAdminBadDebtWriteoff(h.deps, {
    appId: APP,
    adminId: ADMIN,
    candidateId: CANDIDATE,
    ip: null,
    rawBody: {},
    key: 'k-1',
    traceId: 'trace-1',
  });
}

beforeEach(() => {
  store.row = candidate();
  store.status = 'PENDING';
});

it('[AC-B2-12g#1] 写 BAD_DEBT_WRITEOFF 凭证的批准在同一事务里调用打标端口（被核销用户、候选单 id），先于审计', async () => {
  const h = harness({ available: -800n, frozen: 0n });
  await approveWith(h);
  expect(h.mark).toHaveBeenCalledTimes(1);
  expect(h.mark).toHaveBeenCalledWith(TRX, h.deps.clock, {
    appId: APP,
    sourceUserId: USER,
    sourceRef: CANDIDATE,
  });
  expect(h.calls).toEqual(['post', 'mark', 'audit']);
});

it('[AC-B2-12g#4] 余额已回正转 CANCELLED 时不调用打标端口', async () => {
  const h = harness({ available: 0n, frozen: 0n });
  await approveWith(h);
  expect(h.mark).not.toHaveBeenCalled();
  expect(h.calls).toEqual(['audit']);
});

it('[AC-B2-12g#5] frozen > 0 拒绝批准时不调用打标端口', async () => {
  const h = harness({ available: -800n, frozen: 100n });
  await approveWith(h);
  expect(h.mark).not.toHaveBeenCalled();
  expect(h.calls).toEqual([]);
});

it('[AC-B2-12g#7] 打标端口失败时批准抛出（由所在事务整笔回滚），不写审计', async () => {
  const h = harness({ available: -800n, frozen: 0n });
  h.mark.mockImplementationOnce(() => Promise.reject(new Error('mark failed')));
  await expect(approveWith(h)).rejects.toThrow('mark failed');
  expect(h.calls).toEqual(['post']);
});
