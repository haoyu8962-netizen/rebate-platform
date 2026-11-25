import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  LedgerError,
  registerReconDiff,
  registerReconDiffOnce,
  registerReconDiffWriteOnly,
  type RegisterReconDiffInput,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { moveTo } from '../recon-diffs-unresolved/kit.ts';
import { TIMEOUT, close, open, rows, type Harness } from '../recon-diffs/kit.ts';
import {
  REPLAY_AT,
  difference,
  expectOnlyInsert,
  expectOnlyRow,
  expectWriteOnlyConflict,
  reconDiffStatements,
  recordSql,
  replay,
  seed,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-02zf#1] 新插入只返回 inserted=true，落库与旧接口逐字段相同，保留负数、零和注入时刻', async () => {
  const { input, clock } = difference();
  const result = await h.db
    .transaction()
    .execute((trx) => registerReconDiffWriteOnly(trx, input, { clock }));
  expect(result).toStrictEqual({ inserted: true });

  const otherAppId = `${input.appId}-other`;
  const oldRow = await seed(h.db, { input: { ...input, appId: otherAppId }, clock });
  const stored = await rows(h.db, input.appId);
  expect(stored).toHaveLength(1);
  const { id, app_id: appId, ...fields } = stored[0]!;
  const { id: oldId, app_id: oldAppId, ...oldFields } = oldRow;
  expect(fields).toEqual(oldFields);
  expect(oldAppId).toBe(otherAppId);
  expect(appId).toBe(input.appId);
  expect(id).not.toBe(oldId);
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const idInstant = Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
  expect(idInstant).toBe(clock.now().getTime());
  expect(fields).toMatchObject({
    status: 'open',
    handler_id: null,
    closed_at: null,
    expected_fen: input.expectedFen,
    actual_fen: input.actualFen,
    diff_fen: input.diffFen,
    created_at: clock.now(),
    updated_at: clock.now(),
  });
});

it('[AC-B2-02zf#2] 业务键冲突保留原行全部字段，同键换 app 可插入', async () => {
  const original = difference();
  const { input, clock } = original;
  const first = await seed(h.db, original);
  clock.set(REPLAY_AT);
  const candidate = replay(input);
  const conflict = await h.db
    .transaction()
    .execute((trx) => registerReconDiffWriteOnly(trx, candidate, { clock }));
  expect(conflict).toStrictEqual({ inserted: false });
  await expectOnlyRow(h.db, first);

  const otherApp = { ...input, appId: `${input.appId}-other` };
  const separate = await h.db
    .transaction()
    .execute((trx) => registerReconDiffWriteOnly(trx, otherApp, { clock }));
  expect(separate).toStrictEqual({ inserted: true });
  expect(await rows(h.db, otherApp.appId)).toHaveLength(1);
  await expectOnlyRow(h.db, first);
});

it('[AC-B2-02zf#3] dedupe_key 相同但业务键不同，返回 inserted=false 且原行逐字段不变', async () => {
  const original = difference();
  const { input, clock } = original;
  const first = await seed(h.db, original);
  clock.set(REPLAY_AT);
  const candidate = { ...replay(input), refId: randomUUID(), dedupeKey: input.dedupeKey };
  await expectWriteOnlyConflict(h.db, candidate, clock);
  await expectOnlyRow(h.db, first);
});

it('[AC-B2-02zf#4] 月末键相同但 ref_id 和 dedupe_key 不同，返回 inserted=false 且原行逐字段不变', async () => {
  const original = difference({ type: 'month_end_unbalanced', source: 'R4' });
  const { input, clock } = original;
  const first = await seed(h.db, original);
  clock.set(REPLAY_AT);
  const candidate = { ...replay(input), refId: randomUUID() };
  await expectWriteOnlyConflict(h.db, candidate, clock);
  await expectOnlyRow(h.db, first);
});

it('[AC-B2-02zf#5] 非订单 ledger_mismatch 跨期撞未结唯一键，返回 inserted=false 且原行逐字段不变', async () => {
  const original = difference({
    type: 'ledger_mismatch',
    source: 'R3',
    refType: 'ledger_account',
    period: '2032-06-15',
  });
  const { input, clock } = original;
  const first = await seed(h.db, original);
  clock.set(REPLAY_AT);
  const candidate = { ...replay(input), refType: input.refType, period: '2032-06-16' };
  await expectWriteOnlyConflict(h.db, candidate, clock);
  await expectOnlyRow(h.db, first);
});

it.each(['processing', 'adjusted', 'written_off', 'closed'] as const)(
  '[AC-B2-02zf#6] 撞到 %s 的业务键仍返回 inserted=false，保留处理人、结案时间、状态及处置',
  async (status) => {
    const original = difference();
    const { input, clock } = original;
    const first = await seed(h.db, original);
    const before = await h.db.transaction().execute((trx) => moveTo(trx, first, status, REPLAY_AT));
    clock.set('2032-06-17T16:00:00.000Z');
    await expectWriteOnlyConflict(h.db, replay(input), clock);
    await expectOnlyRow(h.db, before);
  },
);

it('[AC-B2-02zf#7] 冲突后同一事务可继续登记另一张差错单并提交', async () => {
  const original = difference();
  const { input, clock } = original;
  const first = await seed(h.db, original);
  const next = { ...replay(input), refId: randomUUID() };
  await h.db.transaction().execute(async (trx) => {
    expect(await registerReconDiffWriteOnly(trx, replay(input), { clock })).toStrictEqual({
      inserted: false,
    });
    expect(await registerReconDiffWriteOnly(trx, next, { clock })).toStrictEqual({
      inserted: true,
    });
  });
  const stored = await rows(h.db, input.appId);
  expect(stored).toHaveLength(2);
  expect(stored.find((row) => row.ref_id === input.refId)).toEqual(first);
  expect(stored.find((row) => row.ref_id === next.refId)).toMatchObject({
    dedupe_key: next.dedupeKey,
    resolution: next.resolution,
  });
});

it('[AC-B2-02zf#11][AC-B2-02zf#13] 同一探针在旧口冲突时看到回读，只写口冲突时只执行同一条 INSERT', async () => {
  const original = difference();
  const { input, clock } = original;
  const first = await seed(h.db, original);
  const probe = recordSql(h.right);
  const candidate = replay(input);

  const old = await probe.db
    .transaction()
    .execute((trx) => registerReconDiffOnce(trx, candidate, { clock }));
  expect(old).toEqual({ inserted: false, row: first });
  const oldStatements = reconDiffStatements(probe.statements);
  expect(oldStatements).toEqual(expect.arrayContaining([expect.stringMatching(/^\s*select\b/i)]));

  probe.statements.length = 0;
  const result = await probe.db
    .transaction()
    .execute((trx) => registerReconDiffWriteOnly(trx, candidate, { clock }));
  expect(result).toStrictEqual({ inserted: false });
  expect(expectOnlyInsert(probe.statements)).toBe(oldStatements[0]);
});

it('[AC-B2-02zf#12] 新插入只执行一条 INSERT，跟随调用方事务回滚', async () => {
  const { input, clock } = difference();
  const probe = recordSql(h.right);
  const abort = new Error('caller rolls back');
  await expect(
    probe.db.transaction().execute(async (trx) => {
      expect(await registerReconDiffWriteOnly(trx, input, { clock })).toStrictEqual({
        inserted: true,
      });
      expectOnlyInsert(probe.statements);
      expect(await rows(trx, input.appId)).toHaveLength(1);
      expect(await rows(h.reader, input.appId)).toHaveLength(0);
      throw abort;
    }),
  ).rejects.toBe(abort);
  expect(await rows(h.db, input.appId)).toHaveLength(0);
});

it.each([
  ['appId 空', { appId: '' }],
  ['type 非枚举', { type: 'unknown_diff' }],
  ['source 非 R1–R4', { source: 'R5' }],
  ['period 形状错误', { period: '2032-6' }],
  ['refType 空', { refType: '' }],
  ['refId 空', { refId: '' }],
  // 自拟数值 12 用于拒绝非 bigint；另测 int64 的两个边界外相邻值。
  ['expectedFen 为 number', { expectedFen: 12 }],
  ['expectedFen 高于 int64', { expectedFen: 9_223_372_036_854_775_808n }],
  ['expectedFen 低于 int64', { expectedFen: -9_223_372_036_854_775_809n }],
  ['actualFen 为 string', { actualFen: '12' }],
  ['actualFen 高于 int64', { actualFen: 9_223_372_036_854_775_808n }],
  ['actualFen 低于 int64', { actualFen: -9_223_372_036_854_775_809n }],
  ['diffFen 为 number', { diffFen: 12 }],
  ['diffFen 高于 int64', { diffFen: 9_223_372_036_854_775_808n }],
  ['diffFen 低于 int64', { diffFen: -9_223_372_036_854_775_809n }],
  ['dedupeKey 空', { dedupeKey: '' }],
  ['resolution 为数组', { resolution: [] }],
  ['resolution 为字符串', { resolution: 'not an object' }],
  ['resolution 带自定义原型', { resolution: new Map() }],
] as const)('[AC-B2-02zf#14] %s：抛 INVALID_INPUT 且无差错单写入', async (_case, overrides) => {
  const { input, clock } = difference();
  const invalid = { ...input, ...overrides } as RegisterReconDiffInput;
  const probe = recordSql(h.right);
  await probe.db.transaction().execute(async (trx) => {
    const result = registerReconDiffWriteOnly(trx, invalid, { clock });
    await expect(result).rejects.toBeInstanceOf(LedgerError);
    await expect(result).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  expect(reconDiffStatements(probe.statements)).toHaveLength(0);
  expect(await rows(h.db, invalid.appId)).toHaveLength(0);
});

it('[AC-B2-02zf#15] ledger 公开导出新旧三个登记函数，新函数可从公开入口登记', async () => {
  expect(typeof registerReconDiff).toBe('function');
  expect(typeof registerReconDiffOnce).toBe('function');
  expect(typeof registerReconDiffWriteOnly).toBe('function');
  const { input, clock } = difference();
  const result = await h.db
    .transaction()
    .execute((trx) => registerReconDiffWriteOnly(trx, input, { clock }));
  expect(result).toStrictEqual({ inserted: true });
});
