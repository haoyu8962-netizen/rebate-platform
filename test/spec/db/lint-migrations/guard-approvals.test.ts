import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { gate, ROOT, run, TIMEOUTS, withFixture } from './kit.ts';

// CT-06d §9.2①：比对既有定义；出现 RAISE EXCEPTION 不代表保护仍然有效。
// 测试只在编排者的隔离容器运行；每组都有 CT-06c 尚未实现的断言。
// CT-06c #18 的 CLI 函数替换预期随实现收紧为退出 1，并包含
// function reject_order_rewrite guards funds or attribution table orders；本轮不改旧文件。
const FILE = '0021_guard-approval.sql';
const APPROVED_FILE = '0020_union-auth-sessions-issuance.sql';
const CLI_TIMEOUT_MS = 60_000;
type Context = { schemaSql: string; migrationsSql: readonly string[]; approved?: boolean };
type Check = (
  file: string,
  sql: string,
  context?: Context,
) => ReturnType<Awaited<ReturnType<typeof gate>>['checkMigration']>;

async function checker(): Promise<Check> {
  return (await gate()).checkMigration as Check;
}

function schemaContext(): Context {
  return {
    schemaSql: readFileSync(join(ROOT, 'db/schema.sql'), 'utf8'),
    migrationsSql: [],
    approved: false,
  };
}

function refused(check: Check, sql: string, context: Context, message: string): void {
  expect(check(FILE, sql, context), sql).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ file: FILE, message: expect.stringContaining(message) }),
    ]),
  );
}

function cliRefused(root: string, message: string): void {
  const result = run(['--root', root, '--squawk', join(root, 'absent-squawk')]);
  expect(result.status, result.stderr + result.stdout).toBe(1);
  expect(result.stderr).toContain(message);
  expect(result.stderr).not.toContain('absent-squawk');
  expect(result.stdout).not.toContain('squawk over');
}

const OBJECTS = [
  {
    kind: 'trigger',
    name: 'order_keys_append_only',
    table: 'order_keys',
    drop: 'DROP TRIGGER order_keys_append_only ON app.order_keys;',
    original:
      'CREATE TRIGGER order_keys_append_only BEFORE DELETE OR UPDATE ON app.order_keys FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();',
    equivalent:
      'CREATE OR REPLACE TRIGGER "order_keys_append_only" BEFORE DELETE OR UPDATE ON "app"."order_keys" FOR EACH ROW EXECUTE FUNCTION "app"."reject_update_delete"();',
    changed:
      'CREATE TRIGGER order_keys_append_only BEFORE UPDATE ON app.order_keys FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();',
  },
  {
    kind: 'constraint',
    name: 'idempotency_keys_scope_key',
    table: 'idempotency_keys',
    drop: 'ALTER TABLE app.idempotency_keys DROP CONSTRAINT idempotency_keys_scope_key;',
    original:
      'ALTER TABLE app.idempotency_keys ADD CONSTRAINT idempotency_keys_scope_key UNIQUE (app_id, subject, method, path, key);',
    equivalent:
      'ALTER TABLE ONLY "app"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_scope_key" UNIQUE (app_id, subject, method, path, key);',
    changed:
      'ALTER TABLE app.idempotency_keys ADD CONSTRAINT idempotency_keys_scope_key UNIQUE (app_id, subject, method, path, key, status);',
  },
  {
    kind: 'index',
    name: 'orders_user_paid_idx',
    table: 'orders',
    drop: 'DROP INDEX app.orders_user_paid_idx;',
    original:
      'CREATE INDEX orders_user_paid_idx ON ONLY app.orders USING btree (app_id, user_id, paid_at DESC, order_id DESC);',
    equivalent:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders_user_paid_idx" ON "app"."orders" (app_id, user_id, paid_at DESC, order_id DESC);',
    changed:
      'CREATE INDEX orders_user_paid_idx ON ONLY app.orders USING btree (app_id, paid_at DESC, order_id DESC);',
  },
  {
    kind: 'index',
    name: 'payout_accounts_current_user_key',
    table: 'payout_accounts',
    drop: 'DROP INDEX app.payout_accounts_current_user_key;',
    original:
      'CREATE UNIQUE INDEX payout_accounts_current_user_key ON app.payout_accounts USING btree (app_id, user_id) WHERE is_current;',
    equivalent:
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "payout_accounts_current_user_key" ON "app"."payout_accounts" (app_id, user_id) WHERE is_current;',
    changed:
      'CREATE INDEX payout_accounts_current_user_key ON app.payout_accounts USING btree (app_id, user_id) WHERE is_current;',
  },
] as const;

it(
  '[AC-CT-06d#1] 审批登记恰含真实 0020 的内容哈希，真实仓库无参数运行通过',
  async () => {
    const module = (await gate()) as Awaited<ReturnType<typeof gate>> & {
      APPROVED_GUARD_CHANGES?: Readonly<Record<string, string>>;
    };
    const bytes = readFileSync(join(ROOT, 'db/migrations', APPROVED_FILE));
    // 先断言导出值，缺少新增导出必须是断言红，不能是 TypeError 或导入失败。
    // F1-02zy (guard-change): CT-25d's 0057 is the second approved migration (orchestrator ruling
    // D10-98 1). Its hash is pinned here; once the file is on disk it must match the pin.
    const ct25d = '0057_invite-rewards-eligibility.sql';
    const ct25dHash = '261a84f2a55dc9e8a65866c6767573d5de027c6bbe4cea3aee6ca3045e41ec89';
    // B1-22e (guard-change): B1-22a's 0071 is the third approved migration (union_accounts
    // alert_stage CHECK widened to d<N>). Same pinning as 0057.
    const b122a = '0071_union-alert-stages.sql';
    const b122aHash = 'b1aafb940438ea1d5a49722e1e759e14beffa9b46a889ca9fda978e790045a22';
    // B1-15t (guard-change): B1-15r's 0077 is the fourth approved migration (payout_accounts
    // details CHECK rebuilt with an anonymized branch). Same pinning as 0057.
    const b115r = '0077_deletion-anonymize.sql';
    const b115rHash = 'd933bc024716bc1fcaa2ac7c7c1bfe9537f76d64225e0effff95d37e6a238113';
    // B2-15h (guard-change): B2-15i's 0081 (ledger_entries ledger_type CHECK + pay_ledger_type,
    // recon_diffs type CHECK + pay_mismatch / pay_anomaly; orchestrator ruling D10-168 ①). Same
    // pinning as 0057.
    const b215i = '0081_ledger-type-pay.sql';
    const b215iHash = 'e0a4df6555607577c01ec7624a30c3d7bef544098783204329ffe8a01705cf2e';
    // B2-15e (guard-change): B2-15e's 0088 (pay_refunds idempotency key rebuilt as UNIQUE (app_id,
    // operator, idempotency_key), nullable note column; orchestrator rulings D10-350 / D10-351 ②,
    // D10-352). Same pinning as 0057.
    const b215e = '0088_pay-refunds-note-idempotency-operator.sql';
    const b215eHash = '8d75300755329c8ebbb06fbf10988279df06958406e0c159ca877cdf54638a82';
    // B2-04rc (guard-change): B2-04rb's 0096 (settle_jobs job CHECK rebuilt NOT VALID with the 0066
    // values plus 'supplement', validated in 0097; orchestrator ruling D10-280 ①). Same pinning as 0057.
    const b204rb = '0096_settle-jobs-supplement.sql';
    const b204rbHash = 'c4451a18cdbac3cd286d2d55fa0322df92c05b8252e53497bb276145e90d189d';
    // B1-04zv (guard-change): 0119 widens the reason CHECK NOT VALID, validated in 0120. Same pinning as 0057.
    const b104zv = '0119_order-sync-pending-row-invalid.sql';
    const b104zvHash = 'f7a549c012b28c7aad6e682194ef8a9b4b978d7ee2088aa70cb6eab6c40abf98';
    expect(module.APPROVED_GUARD_CHANGES).toEqual({
      [APPROVED_FILE]: createHash('sha256').update(bytes).digest('hex'),
      [ct25d]: ct25dHash,
      [b122a]: b122aHash,
      [b115r]: b115rHash,
      [b215i]: b215iHash,
      [b215e]: b215eHash,
      [b204rb]: b204rbHash,
      [b104zv]: b104zvHash,
    });
    const ct25dPath = join(ROOT, 'db/migrations', ct25d);
    if (existsSync(ct25dPath)) {
      expect(createHash('sha256').update(readFileSync(ct25dPath)).digest('hex')).toBe(ct25dHash);
    }
    const b122aPath = join(ROOT, 'db/migrations', b122a);
    if (existsSync(b122aPath)) {
      expect(createHash('sha256').update(readFileSync(b122aPath)).digest('hex')).toBe(b122aHash);
    }
    const b115rPath = join(ROOT, 'db/migrations', b115r);
    if (existsSync(b115rPath)) {
      expect(createHash('sha256').update(readFileSync(b115rPath)).digest('hex')).toBe(b115rHash);
    }
    const result = run([], { cwd: join(ROOT, 'test') });
    expect(result.status, result.stderr + result.stdout).toBe(0);
  },
  CLI_TIMEOUT_MS,
);

it('[AC-CT-06d#25] 同一 ALTER TABLE 的逗号子命令也按 ADD CONSTRAINT 定义比较', async () => {
  const check = await checker();
  const context = schemaContext();
  const original =
    'ALTER TABLE ONLY app.idempotency_keys ADD COLUMN note text, DROP CONSTRAINT IF EXISTS idempotency_keys_scope_key, ADD CONSTRAINT idempotency_keys_scope_key UNIQUE (app_id, subject, method, path, key);';
  expect(check(FILE, original, context)).toEqual([]);
  const changed = original.replace('path, key)', 'path, key, status)');
  expect(check(FILE, changed, { ...context, approved: true })).toEqual([]);
  refused(
    check,
    changed,
    context,
    'constraint idempotency_keys_scope_key on funds or attribution table idempotency_keys recreated with a different definition',
  );
});

it(
  '[AC-CT-06d#2] CLI 审批同时绑定文件名和原始字节，注释变化也使哈希失配',
  () => {
    const sql = readFileSync(join(ROOT, 'db/migrations', APPROVED_FILE), 'utf8');
    const message =
      'function reject_union_auth_session_rewrite guards funds or attribution table union_auth_sessions';
    withFixture({ [APPROVED_FILE]: sql }, (root) => {
      copyFileSync(join(ROOT, 'db/schema.sql'), join(root, 'db/schema.sql'));
      const result = run(['--root', root]);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      writeFileSync(join(root, 'db/migrations', APPROVED_FILE), sql + '\n-- hash changed\n');
      cliRefused(root, message);
    });
    withFixture({ [FILE]: sql }, (root) => {
      copyFileSync(join(ROOT, 'db/schema.sql'), join(root, 'db/schema.sql'));
      cliRefused(root, message);
    });
  },
  CLI_TIMEOUT_MS,
);

it.each(['FUNCTION', 'PROCEDURE'])(
  '[AC-CT-06d#3] CLI 未登记的 %s 替换即使仍抛错或只有死分支抛错也拒绝',
  (kind) => {
    const returns = kind === 'FUNCTION' ? ' RETURNS trigger' : '';
    for (const body of [
      "BEGIN RAISE EXCEPTION 'immutable'; END;",
      "BEGIN IF false THEN RAISE EXCEPTION 'immutable'; END IF; END;",
    ]) {
      const sql = `CREATE OR REPLACE ${kind} app.reject_order_rewrite()${returns} LANGUAGE plpgsql AS $$ ${body} $$;`;
      withFixture({ [FILE]: TIMEOUTS + sql }, (root) => {
        copyFileSync(join(ROOT, 'db/schema.sql'), join(root, 'db/schema.sql'));
        cliRefused(root, 'function reject_order_rewrite guards funds or attribution table orders');
      });
    }
  },
  CLI_TIMEOUT_MS,
);

it('[AC-CT-06d#4] 显式未审批拒绝函数替换，省略审批保持兼容，审批不豁免旧禁止项', async () => {
  const check = await checker();
  const context = schemaContext();
  const approved = { ...context, approved: true };
  const sql =
    "CREATE OR REPLACE FUNCTION app.reject_order_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable'; END; $$;";
  expect(check(FILE, sql, approved)).toEqual([]);
  expect(
    check(FILE, sql, { schemaSql: context.schemaSql, migrationsSql: context.migrationsSql }),
  ).toEqual([]);
  expect(check(FILE, sql.replace('reject_order_rewrite', 'ordinary_fn'), context)).toEqual([]);
  for (const mutation of [
    'DROP FUNCTION app.reject_order_rewrite();',
    'ALTER FUNCTION app.reject_order_rewrite() RENAME TO other_fn;',
    'ALTER TABLE app.orders DISABLE TRIGGER ALL;',
  ])
    expect(check(FILE, mutation, approved).length, mutation).toBeGreaterThan(0);
  refused(
    check,
    sql,
    context,
    'function reject_order_rewrite guards funds or attribution table orders',
  );
});

it.each(OBJECTS)(
  '[AC-CT-06d#5] $kind 定义规范化后相同可重建，定义变化只有登记后可重建',
  async ({ kind, name, table, drop, original, equivalent, changed }) => {
    const check = await checker();
    const context = schemaContext();
    for (const create of [original, equivalent, equivalent.toLowerCase().replaceAll(' ', '\n  ')]) {
      expect(check(FILE, `${drop}\n${create}`, context), create).toEqual([]);
      expect(
        check(
          FILE,
          `${drop.replace(/(TRIGGER|CONSTRAINT|INDEX) /, '$1 IF EXISTS ')}\n${create}`,
          context,
        ),
      ).toEqual([]);
    }
    // 本文件才创建的对象、缺少上下文时维持 CT-06c 的同名重建行为。
    expect(check(FILE, `${drop}\n${changed}`)).toEqual([]);
    expect(
      check(FILE, `${original}\n${drop}\n${changed}`, { schemaSql: '', migrationsSql: [] }),
    ).toEqual([]);
    expect(check(FILE, `${drop}\n${changed}`, { ...context, approved: true })).toEqual([]);
    refused(
      check,
      `${drop}\n${changed}`,
      context,
      `${kind} ${name} on funds or attribution table ${table} recreated with a different definition`,
    );
  },
);

it.each(OBJECTS)(
  '[AC-CT-06d#6] CLI 从真实 schema 识别 $kind 的同名不同定义重建',
  ({ kind, name, table, drop, changed }) => {
    withFixture({ [FILE]: TIMEOUTS + drop + '\n' + changed }, (root) => {
      copyFileSync(join(ROOT, 'db/schema.sql'), join(root, 'db/schema.sql'));
      cliRefused(
        root,
        `${kind} ${name} on funds or attribution table ${table} recreated with a different definition`,
      );
    });
  },
  CLI_TIMEOUT_MS,
);

it.each(OBJECTS)(
  '[AC-CT-06d#7] CLI 缺少 schema 时也从先前迁移识别 $kind 的原定义',
  ({ kind, name, table, drop, original, changed }) => {
    withFixture(
      { '0001_fixture.sql': original, [FILE]: TIMEOUTS + drop + '\n' + changed },
      (root) => {
        cliRefused(
          root,
          `${kind} ${name} on funds or attribution table ${table} recreated with a different definition`,
        );
      },
    );
  },
  CLI_TIMEOUT_MS,
);

it(
  '[AC-CT-06d#8] CLI 同定义触发器重建通过，减少 DELETE 事件必须拒绝',
  () => {
    const trigger = OBJECTS[0];
    withFixture({ [FILE]: TIMEOUTS + trigger.drop + '\n' + trigger.original }, (root) => {
      copyFileSync(join(ROOT, 'db/schema.sql'), join(root, 'db/schema.sql'));
      const result = run(['--root', root]);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      writeFileSync(
        join(root, 'db/migrations', FILE),
        TIMEOUTS + trigger.drop + '\n' + trigger.changed,
      );
      cliRefused(
        root,
        'trigger order_keys_append_only on funds or attribution table order_keys recreated with a different definition',
      );
    });
  },
  CLI_TIMEOUT_MS,
);

it('[AC-CT-06d#26] 不先 DROP 的直接替换也比较 schema 触发器定义，审批与无上下文兼容', async () => {
  const check = await checker();
  const context = schemaContext();
  const trigger = OBJECTS[0];
  const changed = trigger.changed.replace('CREATE TRIGGER', 'CREATE OR REPLACE TRIGGER');
  for (const equivalent of [
    trigger.equivalent,
    trigger.equivalent.toLowerCase().replaceAll(' ', '\n  '),
  ])
    expect(check(FILE, equivalent, context), equivalent).toEqual([]);
  expect(check(FILE, changed, { ...context, approved: true })).toEqual([]);
  expect(check(FILE, changed)).toEqual([]);
  refused(
    check,
    changed,
    context,
    'trigger order_keys_append_only on funds or attribution table order_keys recreated with a different definition',
  );
});

it(
  '[AC-CT-06d#27] CLI 从真实 schema 检查直接替换触发器：同定义放行，减少 DELETE 拒绝',
  () => {
    const trigger = OBJECTS[0];
    withFixture({ [FILE]: TIMEOUTS + trigger.equivalent }, (root) => {
      copyFileSync(join(ROOT, 'db/schema.sql'), join(root, 'db/schema.sql'));
      const result = run(['--root', root]);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      writeFileSync(
        join(root, 'db/migrations', FILE),
        TIMEOUTS + trigger.changed.replace('CREATE TRIGGER', 'CREATE OR REPLACE TRIGGER'),
      );
      cliRefused(
        root,
        'trigger order_keys_append_only on funds or attribution table order_keys recreated with a different definition',
      );
    });
  },
  CLI_TIMEOUT_MS,
);

it.each(['ALTER INDEX app.neutral_guard_idx', 'ALTER INDEX IF EXISTS "app"."neutral_guard_idx"'])(
  '[AC-CT-06d#29] %s 改名须从先前迁移识别资金表归属，不能只看索引名前缀',
  async (head) => {
    const check = await checker();
    // 真实 schema 的资金索引均带表名前缀；以先前迁移提供中性名称的索引。
    const definition = 'CREATE INDEX neutral_guard_idx ON app.orders (order_id);';
    const sql = `${head} RENAME TO renamed_guard_idx;`;
    expect(check(FILE, sql)).toEqual([]);
    expect(
      check(FILE, sql, {
        schemaSql: '',
        migrationsSql: [definition.replace('app.orders', 'app.articles')],
        approved: false,
      }),
    ).toEqual([]);
    for (const approved of [false, true])
      refused(
        check,
        sql,
        { schemaSql: '', migrationsSql: [definition], approved },
        'index neutral_guard_idx on funds or attribution table orders',
      );
  },
);
