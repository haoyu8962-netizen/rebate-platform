import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import { entryRow, parents, ready } from '../core/kit.ts';
import { harness, insert, recon } from '../../settlement/ledger-owned/kit.ts';

const h = harness(createTestDatabase);
const PAY_TYPES = ['PAY_RECEIPT', 'PAY_REFUND', 'PAY_ANOMALY', 'PAY_FEE'];
const USER_TYPES = [
  'REBATE_CREDIT',
  'SHARE_CREDIT',
  'REFERRAL_CREDIT',
  'CLAWBACK',
  'SETTLE_ADJUST',
  'WITHDRAW_FREEZE',
  'WITHDRAW_PAID',
  'WITHDRAW_RETURN',
  'WITHDRAW_FEE',
  'TAX_WITHHOLD',
  'REWARD',
  'ADMIN_ADJUST',
  'BAD_DEBT_WRITEOFF',
];
const RECON_TYPES = [
  'union_mismatch',
  'channel_mismatch',
  'ledger_mismatch',
  'platform_restore',
  'month_end_unbalanced',
  'settle_amount_mismatch',
  'settle_missing',
  'appeal_restore',
  'estimate_changed_after_credit',
  'pay_mismatch',
  'pay_anomaly',
];

// 只转译 CHECK 拒绝；连接、权限、外键等夹具错误必须原样暴露。
async function outcome(run: Promise<unknown>) {
  try {
    await run;
    return { code: 'ok' };
  } catch (error) {
    const failure = error as { code?: string; constraint?: string };
    if (failure.code !== '23514') throw error;
    return { code: failure.code, constraint: failure.constraint };
  }
}

function contractTypes(file: string, key: string): string[] {
  const path = new URL(`../../../../../contracts/enums/${file}`, import.meta.url);
  expect(existsSync(path), `前置契约 ${file} 必须存在`).toBe(true);
  const source = readFileSync(path, 'utf8');
  const block =
    new RegExp(`^  ${key}:\\r?\\n([\\s\\S]*?)(?=^  \\w+:|(?![\\s\\S]))`, 'm').exec(source)?.[1] ??
    '';
  const values = [...block.matchAll(/^      ([A-Za-z_]+):/gm)].map((match) => match[1]!);
  expect(values.length, `${file} 的 ${key} 不能缺失或为空`).toBeGreaterThan(0);
  return values;
}

async function checkConstraint(table: string, name: string, values: string[]) {
  const result = await sql<{ validated: boolean; definition: string }>`
    SELECT convalidated AS validated, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = to_regclass(${`app.${table}`}) AND conname = ${name} AND contype = 'c'
  `.execute(h.app);
  expect(result.rows, `${table}.${name} 必须同名保留`).toHaveLength(1);
  expect(result.rows[0]!.validated, `${table}.${name} 必须完成 VALIDATE`).toBe(true);
  const literals = [...result.rows[0]!.definition.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
  expect(literals.sort(), `${table}.${name} 只扩展指定枚举`).toEqual([...values].sort());
}

it('[AC-B2-15i#1] 分录接受四种平台 PAY 类型和原 13 值，拒绝其他值，用户契约保持隔离', async () => {
  await ready(h.app);
  // 这里只验证类型存储；收款科目选择、成对分录与金额规则属于 B2-15c。
  const platform = await parents(h.app, {
    owner_type: 'platform',
    owner_id: 'platform',
    subject: 'PAY_SUSPENSE',
  });
  const user = await parents(h.app);
  for (const ledger_type of [...PAY_TYPES, ...USER_TYPES]) {
    const { account, voucher } = PAY_TYPES.includes(ledger_type) ? platform : user;
    const row = entryRow(account, voucher, {
      ledger_type,
      ...(PAY_TYPES.includes(ledger_type)
        ? { income_type: null, balance_after_fen: null, account_version: null }
        : {}),
    });
    expect(await outcome(insert(h.app, 'ledger_entries', row)), ledger_type).toEqual({
      code: 'ok',
    });
    const stored = await sql`SELECT ledger_type FROM app.ledger_entries
      WHERE app_id = ${row['app_id']} AND voucher_id = ${row['voucher_id']}
        AND ledger_type = ${ledger_type}`.execute(h.app);
    expect(stored.rows).toEqual([{ ledger_type }]);
  }
  for (const ledger_type of [
    '',
    'PAY_OTHER',
    'PAY_RECEIPT_EXTRA',
    'pay_receipt',
    ' PAY_REFUND',
    'PAY_FEE ',
    'PAY_ANOMALY\n',
    'pay_mismatch',
    'INDIRECT_CREDIT',
    `UNKNOWN_${randomUUID()}`,
  ]) {
    const row = entryRow(platform.account, platform.voucher, {
      ledger_type,
      income_type: null,
      balance_after_fen: null,
      account_version: null,
    });
    expect(await outcome(insert(h.app, 'ledger_entries', row)), ledger_type).toEqual({
      code: '23514',
      constraint: 'ledger_entries_ledger_type_check',
    });
  }
  for (const table of ['ledger_entries', 'ledger_entries_default']) {
    await checkConstraint(table, 'ledger_entries_ledger_type_check', [...USER_TYPES, ...PAY_TYPES]);
  }
  const userTypes = contractTypes('fund.yaml', 'ledger_type');
  const payTypes = contractTypes('pay.yaml', 'pay_ledger_type');
  expect(userTypes).toEqual(USER_TYPES);
  expect([...payTypes].sort()).toEqual([...PAY_TYPES].sort());
  expect(payTypes.filter((type) => userTypes.includes(type))).toEqual([]);
  // out_of_scope: 当前没有用户流水查询实现；契约隔离不能替代接口返回结果的隔离测试。
  // TODO(规划/11 §4.3): 插入四种 PAY_* 后调用用户流水接口并断言均不可见 — blocked on 用户流水接口任务。
});

it('[AC-B2-15i#2] R4 接受两种收款差错，原九种仍可存储，未知类型由同名约束拒绝', async () => {
  const presence = await sql<{ present: boolean }>`
    SELECT to_regclass('app.recon_diffs') IS NOT NULL AS present
  `.execute(h.app);
  expect(presence.rows).toEqual([{ present: true }]);
  for (const type of ['pay_mismatch', 'pay_anomaly', ...RECON_TYPES.slice(0, 9)]) {
    const row = recon({ type, source: type.startsWith('pay_') ? 'R4' : 'R3' });
    expect(await outcome(insert(h.app, 'recon_diffs', row)), type).toEqual({ code: 'ok' });
    const stored = await sql`SELECT type, source FROM app.recon_diffs
      WHERE app_id = ${row['app_id']} AND id = ${row['id']}`.execute(h.app);
    expect(stored.rows).toEqual([{ type, source: row['source'] }]);
  }
  for (const type of [
    '',
    'pay_other',
    'PAY_MISMATCH',
    'pay_anomaly_extra',
    ' pay_mismatch',
    'pay_anomaly ',
    'pay_mismatch\n',
    'PAY_RECEIPT',
    `unknown_${randomUUID()}`,
  ]) {
    expect(
      await outcome(insert(h.app, 'recon_diffs', recon({ type, source: 'R4' }))),
      type,
    ).toEqual({ code: '23514', constraint: 'recon_diffs_type_check' });
  }
  // Migration 0136 (B2-04zzlt) added blacklist_after_credit after the 11 values of 0081.
  await checkConstraint('recon_diffs', 'recon_diffs_type_check', [
    ...RECON_TYPES,
    'blacklist_after_credit',
  ]);
});

it('[AC-B2-15i#3] 两个守卫按原名 NOT VALID 重建于新迁移，紧随的 -validate 迁移 VALIDATE，均保留有限超时', () => {
  const directory = new URL('../../../../../db/migrations/', import.meta.url);
  const names = readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/.test(name));
  const load = (name: string) =>
    readFileSync(new URL(name, directory), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--[^\n]*/g, '');
  const split = (source: string) =>
    source
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean);
  const migrations = names
    .map((name) => ({ name, source: load(name) }))
    .filter(({ source }) => /DROP\s+CONSTRAINT\s+ledger_entries_ledger_type_check\b/i.test(source));
  expect(migrations, '新增且仅有一个收款类型扩展迁移，不改 0037 / 0060').toHaveLength(1);
  const migration = migrations[0]!;
  const number = Number(migration.name.slice(0, 4));
  expect(number).toBeGreaterThan(70);
  // squawk constraint-missing-not-valid：NOT VALID 与 VALIDATE 不得同事务，资金表不加例外（先例 0079 / 0080）。
  expect(migration.source, '重建迁移内不得出现 VALIDATE CONSTRAINT').not.toMatch(
    /VALIDATE\s+CONSTRAINT/i,
  );
  const statements = split(migration.source);
  expect(statements[0]).toMatch(/^SET\s+LOCAL\s+lock_timeout\s*=\s*'5s'$/i);
  expect(statements[1]).toMatch(/^SET\s+LOCAL\s+statement_timeout\s*=\s*'60s'$/i);
  expect(statements, '重建迁移只含两条超时与两组 DROP / ADD，无其他 DDL').toHaveLength(6);
  const followerName = `${String(number + 1).padStart(4, '0')}_${migration.name.slice(5, -4)}-validate.sql`;
  expect(names, `紧随的 ${followerName} 必须存在`).toContain(followerName);
  const follower = load(followerName);
  expect(follower, `${followerName} 不得 DROP / ADD CONSTRAINT`).not.toMatch(
    /(?:DROP|ADD)\s+CONSTRAINT/i,
  );
  const validations = split(follower);
  expect(validations[0]).toMatch(/^SET\s+LOCAL\s+lock_timeout\s*=\s*'5s'$/i);
  expect(validations[1]).toMatch(/^SET\s+LOCAL\s+statement_timeout\s*=\s*'60s'$/i);
  expect(validations, `${followerName} 只含两条超时与两条 VALIDATE，无其他 DDL`).toHaveLength(4);
  for (const [table, name, values] of [
    ['ledger_entries', 'ledger_entries_ledger_type_check', [...USER_TYPES, ...PAY_TYPES]],
    ['recon_diffs', 'recon_diffs_type_check', RECON_TYPES],
  ] as const) {
    const prefix = `ALTER\\s+TABLE\\s+app\\.${table}\\s+`;
    const drop = statements.findIndex((statement) =>
      new RegExp(`^${prefix}DROP\\s+CONSTRAINT\\s+${name}$`, 'i').test(statement),
    );
    const add = statements.findIndex((statement) =>
      new RegExp(
        `^${prefix}ADD\\s+CONSTRAINT\\s+${name}\\s+CHECK\\s*\\([\\s\\S]*\\)\\s+NOT\\s+VALID$`,
        'i',
      ).test(statement),
    );
    const validate = validations.findIndex((statement) =>
      new RegExp(`^${prefix}VALIDATE\\s+CONSTRAINT\\s+${name}$`, 'i').test(statement),
    );
    expect(drop, `${name}: DROP`).toBeGreaterThanOrEqual(2);
    expect(add, `${name}: ADD NOT VALID 在 DROP 后`).toBeGreaterThan(drop);
    expect(validate, `${name}: VALIDATE 在紧随迁移的两条超时后`).toBeGreaterThanOrEqual(2);
    expect([...statements[add]!.matchAll(/'([^']*)'/g)].map((match) => match[1]!)).toEqual(values);
  }
});
