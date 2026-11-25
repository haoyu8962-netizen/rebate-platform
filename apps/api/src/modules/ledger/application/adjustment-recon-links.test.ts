// B2-17 implementer unit tests (no database): the decisions of adjustment-recon-links.ts and the
// submission's use of the link store (BR-FUND-24 ⑨, §9.3 and §13.3 of the task). The store is an
// in-memory stand-in; the transaction is a recording stand-in that only serves the form's INSERT.
// The rule tests (test/spec/ledger/recon-plan-b) run the same on PostgreSQL.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { expect, it, vi } from 'vitest';
import {
  FixedClock,
  type HandlerResult,
  type Idempotency,
  type IdempotentResponse,
} from '../../platform/index.ts';
import type {
  AdjustmentReconStore,
  LockedReconDiff,
} from '../infra/adjustment-recon-diffs-store.ts';
import {
  createAdminAdjustment,
  type AdminAdjustmentCreateDeps,
  type AdminAdjustmentNewInput,
  type AdminAdjustmentPorts,
} from './admin-adjustment.ts';
import {
  concludedByAdjustment,
  involvedMembers,
  linkedDiffIds,
  personMayLink,
  planBDiffIds,
  planNewFormDiffs,
  writeReversalDiffs,
} from './adjustment-recon-links.ts';
import type { Ledger } from './ledger.ts';

const U1 = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a01';
const U2 = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a02';
const U3 = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a03';
const ADMIN = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5aad';
const D1 = '0199a3b4-5c6d-7e8f-9a0b-d1d1d1d1d1d1';
const D2 = '0199a3b4-5c6d-7e8f-9a0b-d2d2d2d2d2d2';
const D3 = '0199a3b4-5c6d-7e8f-9a0b-d3d3d3d3d3d3';
const AT = new Date('2026-11-26T02:00:00.000Z');

function diff(id: string, status: string, users: readonly string[] | null = null): LockedReconDiff {
  return {
    id,
    source: 'R3',
    type: 'ledger_mismatch',
    status,
    ref_type: 'ledger_account',
    ref_id: `01:${id}`,
    involved_user_ids: users,
  };
}

// ---------------------------------------------------------------------------------------------
// Pure decisions.

it('[AC-B2-17#1] linkedDiffIds：只取格式正确的 recon_diff 单号，转小写、去重、升序（加锁顺序）', () => {
  expect(
    linkedDiffIds([
      { ref_type: 'recon_diff', ref_id: D2.toUpperCase() },
      { ref_type: 'withdrawal', ref_id: D1 },
      { ref_type: 'recon_diff', ref_id: D1 },
      { ref_type: 'recon_diff', ref_id: D2 },
      { ref_type: 'recon_diff', ref_id: 'not-a-uuid' },
    ]),
  ).toEqual([D1, D2]);
  expect(linkedDiffIds([])).toEqual([]);
});

it('[AC-B2-17#8] personMayLink：union_mismatch、channel_mismatch（不论 source）与 R4 都不可由人关联；R3 ledger_mismatch 可以', () => {
  expect(personMayLink({ source: 'R1', type: 'union_mismatch' })).toBe(false);
  expect(personMayLink({ source: 'R2', type: 'channel_mismatch' })).toBe(false);
  expect(personMayLink({ source: 'R3', type: 'union_mismatch' })).toBe(false);
  expect(personMayLink({ source: 'R3', type: 'channel_mismatch' })).toBe(false);
  expect(personMayLink({ source: 'R4', type: 'ledger_mismatch' })).toBe(false);
  expect(personMayLink({ source: 'R3', type: 'ledger_mismatch' })).toBe(true);
});

it('[AC-B2-17#2] involvedMembers：名单为 NULL 或空数组时只算正在调账的会员；否则名单（小写、去重）', () => {
  expect(involvedMembers(null, U1.toUpperCase())).toEqual([U1]);
  expect(involvedMembers([], U1)).toEqual([U1]);
  expect(involvedMembers([U2.toUpperCase(), U1, U2], U3)).toEqual([U2, U1]);
});

it('[AC-B2-17#1] planNewFormDiffs：没有名单的 open / processing 差错单 → adjusted', () => {
  const diffs = new Map([
    [D1, diff(D1, 'open')],
    [D2, diff(D2, 'processing', [])],
  ]);
  expect(planNewFormDiffs([D1, D2], diffs, new Map(), U1)).toEqual({
    ok: true,
    items: [
      { id: D1, write: 'adjusted' },
      { id: D2, write: 'adjusted' },
    ],
  });
});

it('[AC-B2-17#5] planNewFormDiffs：名单 U1、U2，U1 先调 → open 置 processing（processing 不写）；U1 已有未红冲关联时 U2 → adjusted', () => {
  expect(
    planNewFormDiffs([D1], new Map([[D1, diff(D1, 'open', [U1, U2])]]), new Map(), U1),
  ).toEqual({ ok: true, items: [{ id: D1, write: 'processing' }] });
  expect(
    planNewFormDiffs([D1], new Map([[D1, diff(D1, 'processing', [U1, U2])]]), new Map(), U1),
  ).toEqual({ ok: true, items: [{ id: D1, write: 'none' }] });
  const active = new Map([[D1, new Set([U1])]]);
  expect(
    planNewFormDiffs([D1], new Map([[D1, diff(D1, 'processing', [U1, U2])]]), active, U2),
  ).toEqual({ ok: true, items: [{ id: D1, write: 'adjusted' }] });
});

it('[AC-B2-17#6] planNewFormDiffs：名单外的会员照常受理、计入已覆盖，但名单里的人没调完之前仍是 processing', () => {
  const diffs = new Map([[D1, diff(D1, 'processing', [U1, U2])]]);
  expect(planNewFormDiffs([D1], diffs, new Map([[D1, new Set([U1])]]), U3)).toEqual({
    ok: true,
    items: [{ id: D1, write: 'none' }],
  });
  expect(planNewFormDiffs([D1], diffs, new Map([[D1, new Set([U1, U3])]]), U2)).toEqual({
    ok: true,
    items: [{ id: D1, write: 'adjusted' }],
  });
});

it('[AC-B2-17#4] planNewFormDiffs：任一张不在 open / processing → 整单拒绝（20902 recon_diff），不论排第几', () => {
  for (const status of ['adjusted', 'written_off', 'closed']) {
    const diffs = new Map([
      [D1, diff(D1, 'open')],
      [D2, diff(D2, status)],
    ]);
    expect(planNewFormDiffs([D1, D2], diffs, new Map(), U1), status).toEqual({ ok: false });
  }
});

it('[AC-B2-17#7] planNewFormDiffs：本会员在该差错单上已有未红冲关联 → 整单拒绝（不靠唯一索引）', () => {
  const diffs = new Map([
    [D1, diff(D1, 'open')],
    [D2, diff(D2, 'processing', [U1, U2])],
  ]);
  const active = new Map([[D2, new Set([U1])]]);
  expect(planNewFormDiffs([D1, D2], diffs, active, U1.toUpperCase())).toEqual({ ok: false });
});

it('[AC-B2-17#12] writeReversalDiffs：先给原单的未红冲关联写上红冲单号，再对每张差错单做退回（同一个 trx）', async () => {
  const calls: string[] = [];
  const trx = {} as Transaction<DB>;
  const seen: unknown[] = [];
  const store = {
    markLinksReversed: vi.fn((t: unknown) => {
      seen.push(t);
      calls.push('mark');
      return Promise.resolve([D1, D2]);
    }),
    sendBack: vi.fn((t: unknown, input: { id: string }) => {
      seen.push(t);
      calls.push(`back ${input.id}`);
      return Promise.resolve(input.id === D1);
    }),
  } as unknown as AdjustmentReconStore;
  await writeReversalDiffs(store, trx, { appId: 'app', originalId: 'o', reversalId: 'r', at: AT });
  expect(calls).toEqual(['mark', `back ${D1}`, `back ${D2}`]);
  expect(seen.every((t) => t === trx)).toBe(true);
});

// ---------------------------------------------------------------------------------------------
// The submission with an in-memory store.

interface Link {
  adjustId: string;
  diffId: string;
  userId: string;
  reversedBy: string | null;
}

/** An in-memory link store over `diffs`; every call is logged with the transaction it got. */
function memoryStore(
  diffs: Map<string, LockedReconDiff>,
  log: { op: string; trx: unknown }[],
  failures: { insertLinkOn?: string; markAdjustedOn?: string } = {},
): { store: AdjustmentReconStore; links: Link[] } {
  const links: Link[] = [];
  const store: AdjustmentReconStore = {
    lockDiffs(trx, _appId, ids) {
      log.push({ op: `lock ${ids.join(',')}`, trx });
      const found = new Map<string, LockedReconDiff>();
      for (const id of ids) {
        const row = diffs.get(id);
        if (row !== undefined) found.set(id, { ...row });
      }
      return Promise.resolve(found);
    },
    activeLinks(trx, _appId, ids) {
      log.push({ op: 'active', trx });
      const result = new Map<string, Set<string>>();
      for (const link of links) {
        if (link.reversedBy !== null || !ids.includes(link.diffId)) continue;
        result.set(link.diffId, (result.get(link.diffId) ?? new Set()).add(link.userId));
      }
      return Promise.resolve(result);
    },
    linkedDiffIds(trx, _appId, adjustId) {
      log.push({ op: 'linked', trx });
      return Promise.resolve(
        links.filter((l) => l.adjustId === adjustId && l.reversedBy === null).map((l) => l.diffId),
      );
    },
    insertLink(trx, row) {
      log.push({ op: `insertLink ${row.reconDiffId}`, trx });
      if (failures.insertLinkOn === row.reconDiffId) {
        return Promise.reject(new Error('synthetic link failure'));
      }
      links.push({
        adjustId: row.adjustId,
        diffId: row.reconDiffId,
        userId: row.userId,
        reversedBy: null,
      });
      return Promise.resolve();
    },
    markAdjusted(trx, input) {
      log.push({ op: `adjusted ${input.id}`, trx });
      if (failures.markAdjustedOn === input.id) {
        return Promise.reject(new Error('synthetic diff failure'));
      }
      const row = diffs.get(input.id)!;
      if (row.status !== 'open' && row.status !== 'processing') return Promise.resolve(false);
      diffs.set(input.id, { ...row, status: 'adjusted' });
      return Promise.resolve(true);
    },
    markProcessing(trx, input) {
      log.push({ op: `processing ${input.id}`, trx });
      const row = diffs.get(input.id)!;
      if (row.status !== 'open') return Promise.resolve(false);
      diffs.set(input.id, { ...row, status: 'processing' });
      return Promise.resolve(true);
    },
    markLinksReversed(trx, input) {
      log.push({ op: 'markReversed', trx });
      const ids: string[] = [];
      for (const link of links) {
        if (link.adjustId === input.adjustId && link.reversedBy === null) {
          link.reversedBy = input.reversalId;
          ids.push(link.diffId);
        }
      }
      return Promise.resolve(ids.sort());
    },
    sendBack(trx, input) {
      log.push({ op: `sendBack ${input.id}`, trx });
      const row = diffs.get(input.id)!;
      if (row.status !== 'adjusted') return Promise.resolve(false);
      diffs.set(input.id, { ...row, status: 'processing' });
      return Promise.resolve(true);
    },
  };
  return { store, links };
}

/** A transaction stand-in: any builder chain; the form's INSERT returns the values it was given. */
function recordingTrx(log: { op: string; trx: unknown }[]): Transaction<DB> {
  let values: Record<string, unknown> = {};
  const chain: object = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return undefined;
        if (prop === 'values') {
          return (given: Record<string, unknown>) => {
            values = given;
            return chain;
          };
        }
        if (prop === 'executeTakeFirstOrThrow') {
          return () => {
            log.push({ op: 'insertForm', trx: self });
            return Promise.resolve(values);
          };
        }
        return () => chain;
      },
    },
  );
  const self = chain as Transaction<DB>;
  return self;
}

interface Harness {
  readonly deps: AdminAdjustmentCreateDeps;
  readonly log: { op: string; trx: unknown }[];
  readonly trxs: Transaction<DB>[];
  readonly handlerRuns: { count: number };
}

function harness(store: AdjustmentReconStore, log: { op: string; trx: unknown }[]): Harness {
  const trxs: Transaction<DB>[] = [];
  const handlerRuns = { count: 0 };
  const idempotency = {
    executeInTransaction: async (
      _request: unknown,
      handler: (trx: Transaction<DB>) => Promise<HandlerResult>,
    ): Promise<IdempotentResponse> => {
      const trx = recordingTrx(log);
      trxs.push(trx);
      handlerRuns.count += 1;
      const result = await handler(trx);
      return { status: result.status, body: JSON.stringify(result.envelope), source: 'handler' };
    },
  } as unknown as Idempotency;
  const ports = {
    lockUsers: (trx: unknown, input: { userIds: readonly string[] }) => {
      log.push({ op: 'lockUsers', trx });
      return Promise.resolve(new Set(input.userIds));
    },
    userStatus: () => Promise.resolve(new Map()),
    withdrawals: () => Promise.resolve(new Map()),
    deletionOwners: () => Promise.resolve(new Map()),
    orderKeys: () => Promise.resolve(new Set()),
    message: (trx: unknown) => {
      log.push({ op: 'message', trx });
      return Promise.resolve();
    },
  } as unknown as AdminAdjustmentPorts;
  const ledger = {
    lockBalances: (trx: unknown, input: { userIds: readonly string[] }) => {
      log.push({ op: 'lockBalances', trx });
      return Promise.resolve([
        {
          app_id: 'app_unit',
          account_id: '0199a3b4-5c6d-7e8f-9a0b-acacacacacac',
          user_id: input.userIds[0],
          available_fen: 1000n,
          frozen_fen: 0n,
          version: 1n,
          negative_since: null,
        },
      ]);
    },
    post: (trx: unknown) => {
      log.push({ op: 'post', trx });
      return Promise.resolve({ kind: 'posted', voucherId: '0199a3b4-5c6d-7e8f-9a0b-f0f0f0f0f0f0' });
    },
  } as unknown as Ledger;
  const deps: AdminAdjustmentCreateDeps = {
    db: {} as Kysely<DB>,
    clock: new FixedClock(AT),
    idempotency,
    auditOn: (trx) =>
      ({
        append: () => {
          log.push({ op: 'audit', trx });
          return Promise.resolve();
        },
      }) as unknown as ReturnType<AdminAdjustmentCreateDeps['auditOn']>,
    ledger,
    ports,
    reconLinks: store,
  };
  return { deps, log, trxs, handlerRuns };
}

function file(
  h: Harness,
  userId: string,
  diffIds: readonly string[],
  reasonCode: AdminAdjustmentNewInput['reasonCode'],
  direction: 'increase' | 'decrease' = 'decrease',
): Promise<IdempotentResponse> {
  return createAdminAdjustment(h.deps, {
    appId: 'app_unit',
    adminId: ADMIN,
    ip: null,
    body: {
      kind: 'new',
      userId,
      direction,
      amountFen: 120n,
      reasonCode,
      refs: diffIds.map((id) => ({ ref_type: 'recon_diff' as const, ref_id: id })),
      note: '核对后的更正',
      contraSubject: 'COMMISSION_REVENUE',
      contraPlatform: null,
    },
    rawBody: {},
    key: `unit-${userId}-${reasonCode}`,
    traceId: 'trace_unit',
  });
}

it('[AC-B2-17#35] 13.3 第 6 条 (a)：关联两张差错单、第二张写关联行失败 → 整个事务回调抛出；此前的写入（凭证、调账单、第一张的关联与状态）都在同一个 trx 上，没有第二个事务，失败之后没有任何写入（审计、站内信都没发生）', async () => {
  const log: { op: string; trx: unknown }[] = [];
  const diffs = new Map([
    [D1, diff(D1, 'open')],
    [D2, diff(D2, 'open')],
  ]);
  const { store } = memoryStore(diffs, log, { insertLinkOn: D2 });
  const h = harness(store, log);

  await expect(file(h, U1, [D2, D1], 'RECON_FIX')).rejects.toThrow('synthetic link failure');

  expect(h.handlerRuns.count).toBe(1);
  expect(h.trxs).toHaveLength(1);
  const [trx] = h.trxs;
  expect(log.map((entry) => entry.op)).toEqual([
    `lock ${D1},${D2}`,
    'lockUsers',
    'lockBalances',
    'active',
    'post',
    'insertForm',
    `insertLink ${D1}`,
    `adjusted ${D1}`,
    `insertLink ${D2}`,
  ]);
  expect(log.every((entry) => entry.trx === trx)).toBe(true);
});

it('[AC-B2-17#35] 13.3 第 6 条 (a)：第二张差错单的状态写入失败 → 同样整个回调抛出、同一个 trx、之后没有写入', async () => {
  const log: { op: string; trx: unknown }[] = [];
  const diffs = new Map([
    [D1, diff(D1, 'open')],
    [D2, diff(D2, 'processing')],
  ]);
  const { store } = memoryStore(diffs, log, { markAdjustedOn: D2 });
  const h = harness(store, log);

  await expect(file(h, U1, [D1, D2], 'OTHER')).rejects.toThrow('synthetic diff failure');

  expect(h.trxs).toHaveLength(1);
  const ops = log.map((entry) => entry.op);
  expect(ops.slice(-4)).toEqual([
    `insertLink ${D1}`,
    `adjusted ${D1}`,
    `insertLink ${D2}`,
    `adjusted ${D2}`,
  ]);
  expect(ops).not.toContain('audit');
  expect(ops).not.toContain('message');
  expect(log.every((entry) => entry.trx === h.trxs[0])).toBe(true);
});

it('[AC-B2-17#37] 13.3 第 6 条 (b)：名单 U1、U2 的差错单，U1 以 RECON_FIX 调增、U2 以 OTHER 调减提交 → U1 之后 processing、U2 之后 adjusted（已覆盖不看原因码、方向）', async () => {
  const log: { op: string; trx: unknown }[] = [];
  const diffs = new Map([[D1, diff(D1, 'open', [U1, U2])]]);
  const { store, links } = memoryStore(diffs, log);
  const h = harness(store, log);

  const first = await file(h, U1, [D1], 'RECON_FIX', 'increase');
  expect(first.status).toBe(200);
  expect(diffs.get(D1)?.status).toBe('processing');
  expect(log.map((entry) => entry.op)).toContain(`processing ${D1}`);

  const again = await file(h, U1, [D1], 'OTHER');
  expect(again.status).toBe(409);
  expect((JSON.parse(again.body) as { code: number; data: unknown }).data).toEqual({
    resource: 'recon_diff',
  });

  const second = await file(h, U2, [D1], 'OTHER');
  expect(second.status).toBe(200);
  expect(diffs.get(D1)?.status).toBe('adjusted');
  expect(links.map((link) => link.userId)).toEqual([U1, U2]);
});

it('[AC-B2-17#4] 关联的差错单已不在 open / processing → 409 20902 resource=recon_diff，在任何写入之前（没有凭证、调账单、关联行）', async () => {
  const log: { op: string; trx: unknown }[] = [];
  const diffs = new Map([
    [D1, diff(D1, 'open')],
    [D2, diff(D2, 'closed')],
  ]);
  const { store, links } = memoryStore(diffs, log);
  const h = harness(store, log);

  const refused = await file(h, U1, [D1, D2], 'RECON_FIX');
  expect(refused.status).toBe(409);
  expect(JSON.parse(refused.body)).toMatchObject({ code: 20902, data: { resource: 'recon_diff' } });
  const ops = log.map((entry) => entry.op);
  expect(ops).not.toContain('post');
  expect(ops).not.toContain('insertForm');
  expect(links).toEqual([]);
  expect(diffs.get(D1)?.status).toBe('open');
});

it('[AC-B2-17#8] 关联 channel_mismatch 差错单 → 20001 refs adjust_ref_invalid，不写任何东西', async () => {
  const log: { op: string; trx: unknown }[] = [];
  const external = { ...diff(D1, 'open'), source: 'R2', type: 'channel_mismatch' };
  const { store } = memoryStore(new Map([[D1, external]]), log);
  const h = harness(store, log);

  const refused = await file(h, U1, [D1], 'OTHER');
  expect(refused.status).toBe(400);
  expect(JSON.parse(refused.body)).toMatchObject({
    code: 20001,
    data: { fields: ['refs'], reason: 'adjust_ref_invalid' },
  });
  expect(log.map((entry) => entry.op)).toEqual([`lock ${D1}`, 'lockUsers', 'lockBalances']);
});

// ---------------------------------------------------------------------------------------------
// Positive list (task §16.3, D10-3237 (五), D10-3239): only ledger_mismatch takes the plan B steps.

/** A diff of another type, as its own registrar leaves it. */
function special(id: string, type: string, source: string, status: string): LockedReconDiff {
  return { ...diff(id, status), type, source, ref_type: 'order', ref_id: `${type}:${id}` };
}

it('[AC-B2-17#44] concludedByAdjustment / planBDiffIds：只有 ledger_mismatch 走方案 B；platform_restore 等与以后新增的类型都不走', () => {
  expect(concludedByAdjustment({ type: 'ledger_mismatch' })).toBe(true);
  for (const type of [
    'platform_restore',
    'appeal_restore',
    'blacklist_after_credit',
    'settle_amount_mismatch',
    'settle_missing',
    'estimate_changed_after_credit',
    'month_end_unbalanced',
    'some_type_added_later',
  ]) {
    expect(concludedByAdjustment({ type }), type).toBe(false);
  }
  const diffs = new Map([
    [D1, special(D1, 'platform_restore', 'R1', 'open')],
    [D2, diff(D2, 'open')],
    [D3, special(D3, 'appeal_restore', 'R3', 'closed')],
  ]);
  expect(planBDiffIds([D1, D2, D3], diffs)).toEqual([D2]);
  expect(() => planBDiffIds([D1, '0199a3b4-5c6d-7e8f-9a0b-eeeeeeeeeeee'], diffs)).toThrow();
});

it('[AC-B2-17#44] 关联一张 open 的 platform_restore / appeal_restore / blacklist_after_credit → 200；不进 20902 判定、不写关联行、不写状态；同一会员再交一张仍 200', async () => {
  for (const [type, source] of [
    ['platform_restore', 'R1'],
    ['appeal_restore', 'R3'],
    ['blacklist_after_credit', 'R3'],
  ] as const) {
    const log: { op: string; trx: unknown }[] = [];
    const before = special(D1, type, source, 'open');
    const diffs = new Map([[D1, before]]);
    const { store, links } = memoryStore(diffs, log);
    const h = harness(store, log);

    const first = await file(h, U1, [D1], 'OTHER');
    expect(first.status, type).toBe(200);
    const again = await file(h, U1, [D1], 'OTHER');
    expect(again.status, `${type} 再交`).toBe(200);

    expect(links, type).toEqual([]);
    expect(diffs.get(D1), type).toEqual(before);
    const ops = log.map((entry) => entry.op);
    expect(
      ops.filter((op) => /^(insertLink|adjusted|processing) /u.test(op)),
      type,
    ).toEqual([]);
    expect(
      ops.filter((op) => op === 'post'),
      type,
    ).toHaveLength(2);
  }
});

it('[AC-B2-17#45] 关联一张已 closed（或 adjusted）的 platform_restore → 200（只核存在，不看状态），整行不变', async () => {
  for (const status of ['closed', 'adjusted', 'written_off']) {
    const log: { op: string; trx: unknown }[] = [];
    const before = special(D1, 'platform_restore', 'R1', status);
    const diffs = new Map([[D1, before]]);
    const { store, links } = memoryStore(diffs, log);
    const h = harness(store, log);

    const answer = await file(h, U1, [D1], 'OTHER');
    expect(answer.status, status).toBe(200);
    expect(links, status).toEqual([]);
    expect(diffs.get(D1), status).toEqual(before);
  }
});

it('[AC-B2-17#46] 同一请求关联 platform_restore 与 ledger_mismatch → 只有 ledger_mismatch 置 adjusted、有一行关联；红冲后只有它退回 processing', async () => {
  const log: { op: string; trx: unknown }[] = [];
  const other = special(D1, 'platform_restore', 'R1', 'open');
  const diffs = new Map([
    [D1, other],
    [D2, diff(D2, 'open')],
  ]);
  const { store, links } = memoryStore(diffs, log);
  const h = harness(store, log);

  const answer = await file(h, U1, [D1, D2], 'RECON_FIX');
  expect(answer.status).toBe(200);
  expect(diffs.get(D2)?.status).toBe('adjusted');
  expect(diffs.get(D1)).toEqual(other);
  expect(links.map((link) => link.diffId)).toEqual([D2]);
  const ops = log.map((entry) => entry.op);
  expect(ops).toContain(`lock ${D1},${D2}`);
  expect(ops.filter((op) => /^(insertLink|adjusted|processing) /u.test(op))).toEqual([
    `insertLink ${D2}`,
    `adjusted ${D2}`,
  ]);

  // The reversal follows the link rows only.
  await writeReversalDiffs(store, h.trxs[0]!, {
    appId: 'app_unit',
    originalId: links[0]!.adjustId,
    reversalId: '0199a3b4-5c6d-7e8f-9a0b-bbbbbbbbbbbb',
    at: AT,
  });
  expect(diffs.get(D2)?.status).toBe('processing');
  expect(diffs.get(D1)).toEqual(other);
});

it('[AC-B2-17#46] 同一请求里 ledger_mismatch 已结案而另一张 platform_restore open → 仍按 ledger_mismatch 判 20902；反过来 platform_restore 已结案、ledger_mismatch open → 200', async () => {
  {
    const log: { op: string; trx: unknown }[] = [];
    const diffs = new Map([
      [D1, special(D1, 'platform_restore', 'R1', 'open')],
      [D2, diff(D2, 'closed')],
    ]);
    const { store } = memoryStore(diffs, log);
    const refused = await file(harness(store, log), U1, [D1, D2], 'RECON_FIX');
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.body)).toMatchObject({ data: { resource: 'recon_diff' } });
  }
  {
    const log: { op: string; trx: unknown }[] = [];
    const diffs = new Map([
      [D1, special(D1, 'platform_restore', 'R1', 'closed')],
      [D2, diff(D2, 'open')],
    ]);
    const { store } = memoryStore(diffs, log);
    const ok = await file(harness(store, log), U1, [D1, D2], 'RECON_FIX');
    expect(ok.status).toBe(200);
    expect(diffs.get(D2)?.status).toBe('adjusted');
    expect(diffs.get(D1)?.status).toBe('closed');
  }
});
