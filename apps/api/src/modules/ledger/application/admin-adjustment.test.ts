// B2-12h unit tests (no database): the duplicate check on a form's linked documents. A recon_diff,
// withdrawal or account_deletion id is a UUID, the same document in either letter case; an `order`
// ref_id is an order_key and is compared as written. A form past the check reaches the member lock,
// which refuses it here with user_id, so nothing beyond the check runs; the rule tests run the rest.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { expect, it, vi, type Mock } from 'vitest';
import {
  FixedClock,
  type HandlerResult,
  type Idempotency,
  type IdempotentResponse,
} from '../../platform/index.ts';
import {
  createAdminAdjustment,
  type AdminAdjustmentCreateDeps,
  type AdminAdjustmentPorts,
  type AdminAdjustmentRef,
  type AdminAdjustmentRefType,
} from './admin-adjustment.ts';
import type { Ledger } from './ledger.ts';

const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a01';
const DOC = '0199a3b4-5c6d-7e8f-9a0b-abcdef012345';
const UUID_TYPES = ['recon_diff', 'withdrawal', 'account_deletion'] as const;

interface Submitted {
  readonly status: number;
  readonly data: unknown;
  readonly lockUsers: Mock;
}

async function submit(refs: readonly AdminAdjustmentRef[]): Promise<Submitted> {
  const lockUsers = vi.fn(() => Promise.resolve(new Set<string>()));
  const idempotency = {
    executeInTransaction: async (
      _request: unknown,
      handler: (trx: Transaction<DB>) => Promise<HandlerResult>,
    ): Promise<IdempotentResponse> => {
      const result = await handler({} as Transaction<DB>);
      return { status: result.status, body: JSON.stringify(result.envelope), source: 'handler' };
    },
  } as unknown as Idempotency;
  const deps: AdminAdjustmentCreateDeps = {
    db: {} as Kysely<DB>,
    clock: new FixedClock(new Date('2026-11-08T00:00:00.000Z')),
    idempotency,
    auditOn: vi.fn(),
    ledger: {} as Ledger,
    ports: { lockUsers } as unknown as AdminAdjustmentPorts,
  };
  const response = await createAdminAdjustment(deps, {
    appId: 'app_unit',
    adminId: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a02',
    ip: null,
    body: {
      kind: 'new',
      userId: USER,
      direction: 'decrease',
      amountFen: 100n,
      reasonCode: 'OTHER',
      refs,
      note: '其他调整',
      contraSubject: 'MKT_EXPENSE',
      contraPlatform: null,
    },
    rawBody: {},
    key: 'unit',
    traceId: 'trace_unit',
  });
  const envelope = JSON.parse(response.body) as { data?: unknown };
  return { status: response.status, data: envelope.data, lockUsers };
}

/** Refused by the duplicate check: 20001 fields=[refs], no reason, the member never locked. */
function expectDuplicate(result: Submitted): void {
  expect(result.status).toBe(400);
  expect(result.data).toEqual({ fields: ['refs'] });
  expect(result.lockUsers).not.toHaveBeenCalled();
}

/** Past the duplicate check: the form went on to the member lock. */
function expectPastCheck(result: Submitted): void {
  expect(result.data).toEqual({ fields: ['user_id'] });
  expect(result.lockUsers).toHaveBeenCalledTimes(1);
}

function ref(type: AdminAdjustmentRefType, id: string): AdminAdjustmentRef {
  return { ref_type: type, ref_id: id };
}

it.each(UUID_TYPES)(
  '[AC-B2-12h#1] %s 同一 UUID 大小写不同出现两次（小写 + 大写、大写 + 小写、小写 + 半大写）→ 重复',
  async (type) => {
    const upper = DOC.toUpperCase();
    const mixed = `${DOC.slice(0, 18).toUpperCase()}${DOC.slice(18)}`;
    expectDuplicate(await submit([ref(type, DOC), ref(type, upper)]));
    expectDuplicate(await submit([ref(type, upper), ref(type, DOC)]));
    expectDuplicate(await submit([ref(type, DOC), ref(type, mixed)]));
  },
);

it.each(UUID_TYPES)('[AC-B2-12h#1] %s 只有一张且写成大写 UUID → 不算重复', async (type) => {
  expectPastCheck(await submit([ref(type, DOC.toUpperCase())]));
});

it('[AC-B2-12h#3] order 单据号区分大小写：只差大小写的两个不算重复，完全相同的算重复', async () => {
  expectPastCheck(await submit([ref('order', 'taobao:AbC1'), ref('order', 'taobao:aBc1')]));
  expectDuplicate(await submit([ref('order', 'taobao:AbC1'), ref('order', 'taobao:AbC1')]));
});

it('[AC-B2-12h#3] 同一串编号落在不同单据类型上不算重复', async () => {
  expectPastCheck(await submit([ref('recon_diff', DOC), ref('withdrawal', DOC.toUpperCase())]));
  expectPastCheck(await submit([ref('order', DOC), ref('recon_diff', DOC.toUpperCase())]));
});
