import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import {
  LATER,
  TABLES,
  bill,
  columns,
  harness,
  indexes,
  insert,
  migrationSource,
  parents,
  ready,
  sqlState,
  update,
  type Table,
} from './kit.ts';

const h = harness(createTestDatabase);

it('[AC-B2-04a#1] 八表保留规划 04 §3.2 字段，app_id 非空，金额为 bigint', async () => {
  await ready(h.app);
  const required: Record<Table, string[]> = {
    settle_jobs: [
      'job',
      'platform',
      'run_at',
      'status',
      'processed_count',
      'skipped_count',
      'started_at',
      'finished_at',
    ],
    // 规划 04 §3.2 只给出汇总含义；以下英文列名由本任务固定。
    settle_bills: [
      'bill_id',
      'generation_started_at',
      'generated_at',
      'platform_order_counts',
      'platform_settle_commission_totals',
      'beneficiary_total_fen',
      'platform_retained_fen',
      'error_count',
      'held_count',
    ],
    settle_batches: [
      'batch_id',
      'bill_id',
      'platform',
      'kind',
      'status',
      'settle_mode',
      'scheduled_at',
      'confirmed_by',
      'confirmed_at',
      'cancelled_reason',
      'settle_run_id',
      'order_count',
      'started_at',
      'finished_at',
      'paused_by_switch_at',
      // B2-04zy（D10-726）：本批已入账明细数，入账同事务 +1。
      'credited_count',
    ],
    settle_batch_items: [
      'batch_id',
      'item_type',
      'order_id',
      'user_id',
      'role',
      'beneficiary_credit_id',
      'settle_seq',
      'b_settle_fen',
      'amount_fen',
      'result',
      'skip_reason',
    ],
    beneficiary_credits: [
      'beneficiary_credit_id',
      'order_id',
      'user_id',
      'role',
      'kind',
      'opened_by',
      'opened_ref',
      'origin_ledger_type',
      'origin_sub_type',
      'split_ref',
      'status',
      'closed_by',
      'closed_ref',
      'voucher_id',
      'opened_at',
      'closed_at',
    ],
    settle_adjust_batches: ['batch_id', 'confirmed_by', 'confirmed_at'],
    settle_adjustments: [
      'batch_id',
      'order_id',
      'user_id',
      'role',
      'commission_version',
      'settle_seq',
      'diff_fen',
      'reason',
      'status',
      'approver',
      'decided_at',
    ],
    recon_union: [
      'platform',
      'period',
      'order_key',
      'our_value',
      'union_value',
      'diff_fen',
      'result',
    ],
  };
  for (const table of TABLES) {
    const stored = await columns(h.app, table);
    expect(
      stored.map((c) => c.name),
      table,
    ).toEqual(expect.arrayContaining(required[table]));
    expect(stored).toContainEqual(
      expect.objectContaining({ name: 'app_id', type: 'text', nullable: false }),
    );
    for (const c of stored) {
      if (c.name.endsWith('_fen') || ['our_value', 'union_value'].includes(c.name))
        expect(c.type, `${table}.${c.name}`).toBe('int8');
      if (c.name.endsWith('_at')) {
        expect(c.type, `${table}.${c.name}`).toBe('timestamptz');
        if (!['created_at', 'updated_at'].includes(c.name))
          expect(c.expression, `${table}.${c.name}`).toBeNull();
      }
      if (c.type === 'uuid') expect(c.expression, `${table}.${c.name}`).toBeNull();
    }
  }
  const bills = await columns(h.app, 'settle_bills');
  expect(bills.map((c) => c.name)).not.toContain('status');
  // 义务不另存金额：每次按 booked_base_fen 与净额重算（BR-FUND-04 ⑫）。
  expect(
    (await columns(h.app, 'beneficiary_credits')).filter((c) => c.name.endsWith('_fen')),
  ).toEqual([]);
});

it('[AC-B2-04a#25] couli_app 出账完成时回填六个账单汇总列与完成时刻并原样读回', async () => {
  await ready(h.app);
  const p = await parents(h.app);
  const initial = {
    platform_order_counts: {},
    platform_settle_commission_totals: {},
    beneficiary_total_fen: 0n,
    platform_retained_fen: 0n,
    error_count: 0,
    held_count: 0,
    generated_at: null,
  };
  await insert(h.app, 'settle_bills', bill(p, initial));
  const before = await sql`
    SELECT platform_order_counts, platform_settle_commission_totals,
      beneficiary_total_fen, platform_retained_fen,
      error_count::integer AS error_count, held_count::integer AS held_count, generated_at
    FROM app.settle_bills WHERE app_id = ${p.appId} AND bill_id = '2032-06'
  `.execute(h.app);
  expect(before.rows).toEqual([initial]);
  // 分平台映射用 JSON；其中金额用整数字符串，避免 JSON 数字损失分值精度。
  const platformOrders = { taobao: 3, jd: 2 };
  const platformCommissions = { taobao: '9007199254740993', jd: '200' };
  const totals = {
    platform_order_counts: platformOrders,
    platform_settle_commission_totals: platformCommissions,
    beneficiary_total_fen: 9007199254740000n,
    platform_retained_fen: 1193n,
    error_count: 2,
    held_count: 3,
  };
  expect(
    await sqlState(
      update(
        h.app,
        'settle_bills',
        { app_id: p.appId, bill_id: '2032-06' },
        { ...totals, generated_at: LATER },
      ),
    ),
  ).toBe('ok');
  const stored = await sql`
    SELECT platform_order_counts, platform_settle_commission_totals,
      beneficiary_total_fen, platform_retained_fen,
      error_count::integer AS error_count, held_count::integer AS held_count, generated_at
    FROM app.settle_bills WHERE app_id = ${p.appId} AND bill_id = '2032-06'
  `.execute(h.app);
  expect(stored.rows).toEqual([{ ...totals, generated_at: new Date(LATER) }]);
  // 此账单没有批次明细，暂缓数仍能读回，不能依赖明细推算。
  const details = await sql`SELECT count(*)::integer AS count
    FROM app.settle_batch_items WHERE app_id = ${p.appId}`.execute(h.app);
  expect(details.rows).toEqual([{ count: 0 }]);
});

it('[AC-B2-04a#2] 未执行记录允许结果、确认、关闭信息为空；S8 标记为可空时间列', async () => {
  await ready(h.app);
  for (const [table, names] of [
    ['settle_jobs', ['finished_at']],
    ['settle_bills', ['generated_at']],
    [
      'settle_batches',
      [
        'scheduled_at',
        'confirmed_by',
        'confirmed_at',
        'cancelled_reason',
        'settle_run_id',
        'started_at',
        'finished_at',
        'paused_by_switch_at',
      ],
    ],
    [
      'settle_batch_items',
      ['user_id', 'role', 'beneficiary_credit_id', 'amount_fen', 'result', 'skip_reason'],
    ],
    [
      'beneficiary_credits',
      [
        'origin_ledger_type',
        'origin_sub_type',
        'closed_by',
        'closed_ref',
        'voucher_id',
        'closed_at',
      ],
    ],
    ['settle_adjustments', ['user_id', 'role', 'approver', 'decided_at']],
  ] as const) {
    const stored = await columns(h.app, table);
    for (const name of names)
      expect(stored, `${table}.${name}`).toContainEqual(
        expect.objectContaining({ name, nullable: true }),
      );
  }
  for (const [table, names] of [
    ['settle_jobs', ['job', 'platform', 'run_at', 'status']],
    ['settle_bills', ['bill_id', 'generation_started_at']],
    [
      'settle_batches',
      ['batch_id', 'bill_id', 'platform', 'kind', 'status', 'settle_mode', 'credited_count'],
    ],
    ['settle_batch_items', ['batch_id', 'item_type', 'order_id', 'settle_seq']],
    [
      'beneficiary_credits',
      [
        'beneficiary_credit_id',
        'order_id',
        'user_id',
        'role',
        'kind',
        'opened_by',
        'opened_ref',
        'split_ref',
        'status',
        'opened_at',
      ],
    ],
    [
      'settle_adjustments',
      ['order_id', 'batch_id', 'commission_version', 'settle_seq', 'diff_fen', 'status'],
    ],
  ] as const) {
    const stored = await columns(h.app, table);
    for (const name of names)
      expect(stored, `${table}.${name}`).toContainEqual(
        expect.objectContaining({ name, nullable: false }),
      );
  }
});

it('[AC-B2-04a#3] 名义任务和账单唯一，明细两条部分唯一、open 义务部分唯一', async () => {
  await ready(h.app);
  for (const [table, keys] of [
    ['settle_jobs', ['app_id', 'job', 'platform', 'run_at']],
    ['settle_bills', ['app_id', 'bill_id']],
  ] as const) {
    expect(await indexes(h.app, table)).toContainEqual(
      expect.objectContaining({ keys: [...keys], unique: true, valid: true, predicate: null }),
    );
  }
  for (const [table, keys, predicate] of [
    ['settle_batch_items', ['app_id', 'batch_id', 'order_id'], "item_type='order'"],
    [
      'settle_batch_items',
      ['app_id', 'batch_id', 'beneficiary_credit_id'],
      "item_type='beneficiary'",
    ],
    ['beneficiary_credits', ['app_id', 'order_id', 'user_id', 'role'], "status='open'"],
  ] as const) {
    const matches = (await indexes(h.app, table)).filter(
      (i) => i.unique && i.keys.join(',') === keys.join(','),
    );
    expect(matches, `${table}/${keys.join(',')}`).toHaveLength(1);
    expect(matches[0]?.valid).toBe(true);
    expect(matches[0]?.predicate?.replace(/::text|[()"\s]/g, '')).toBe(predicate);
  }
});

it('[AC-B2-04a#4] 同一迁移创建并授权八表，约束与独立索引具名，不创建打款明细', async () => {
  await ready(h.app);
  const source = migrationSource().replace(/"/g, '');
  const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  expect(source).not.toMatch(/\bpayout_batch_items\b/i);
  for (const table of TABLES) {
    expect(source).toMatch(
      new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?app\\.${table}\\s*\\(`, 'i'),
    );
    expect(source).toMatch(
      new RegExp(
        `GRANT\\s+[^;]+\\bON\\s+(?:TABLE\\s+)?[^;]*\\bapp\\.${table}\\b[^;]*\\bTO\\s+couli_app\\b`,
        'i',
      ),
    );
    const constraints = await sql<{
      name: string;
      kind: string;
      valid: boolean;
    }>`SELECT conname AS name, contype::text AS kind, convalidated AS valid
      FROM pg_constraint WHERE conrelid = to_regclass(${`app.${table}`}) AND contype IN ('p', 'u', 'c', 'f')`.execute(
      h.app,
    );
    expect(
      constraints.rows.some((c) => c.kind === 'p'),
      `${table} 主键`,
    ).toBe(true);
    for (const c of constraints.rows) {
      expect(c.valid, c.name).toBe(true);
      expect(source, c.name).toMatch(new RegExp(`\\bCONSTRAINT\\s+${escape(c.name)}\\s`, 'i'));
    }
    for (const i of await indexes(h.app, table)) {
      if (!i.constraint_backed)
        expect(source, i.name).toMatch(
          new RegExp(
            `\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${escape(i.name)}\\s`,
            'i',
          ),
        );
    }
  }
});

it('[AC-B2-04a#5] 订单引用指 order_keys，明细连接账单批次及义务，所有外键不级联', async () => {
  await ready(h.app);
  const foreign = await sql<{
    table: Table;
    keys: string[];
    target: string;
    target_keys: string[];
    del: string;
    upd: string;
    valid: boolean;
  }>`
    SELECT t.relname AS table,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, pos)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.pos) AS keys,
      c.confrelid::regclass::text AS target,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, pos)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.pos) AS target_keys,
      c.confdeltype::text AS del, c.confupdtype::text AS upd, c.convalidated AS valid
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'app' AND t.relname IN (${sql.join(TABLES)})
  `.execute(h.app);
  for (const table of ['settle_batch_items', 'beneficiary_credits', 'settle_adjustments']) {
    expect(foreign.rows, table).toContainEqual(
      expect.objectContaining({
        table,
        keys: ['app_id', 'order_id'],
        target: 'app.order_keys',
        target_keys: ['app_id', 'order_id'],
        valid: true,
      }),
    );
  }
  for (const [table, column, target] of [
    ['settle_batches', 'bill_id', 'settle_bills'],
    ['settle_batch_items', 'batch_id', 'settle_batches'],
    ['settle_batch_items', 'beneficiary_credit_id', 'beneficiary_credits'],
    ['settle_adjustments', 'batch_id', 'settle_adjust_batches'],
  ]) {
    expect(foreign.rows).toContainEqual(
      expect.objectContaining({
        table,
        keys: expect.arrayContaining(['app_id', column]),
        target: `app.${target}`,
        target_keys: expect.arrayContaining(['app_id', column]),
        valid: true,
      }),
    );
  }
  for (const fk of foreign.rows) {
    expect(['a', 'r']).toContain(fk.del);
    expect(['a', 'r']).toContain(fk.upd);
    expect(fk.target).not.toBe('app.orders');
    expect(fk.valid).toBe(true);
  }
});
