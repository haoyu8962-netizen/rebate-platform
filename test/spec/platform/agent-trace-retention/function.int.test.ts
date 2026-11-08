// B3-08s — app.delete_expired_agent_traces 的规则（BR-ID-30 ①、BR-AI-19、BR-AI-22）。契约见 ./kit.ts 文件头。
// 每个用例先 requireFunction：缺迁移时以断言失败变红，不去执行不存在的 SQL 函数。
import { randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';

import { sqlState } from '../../db/partitions/kit.ts';
import { holdLock, inWorld, type World } from '../retention/kit.ts';
import {
  AGENT_TABLES,
  ancestors,
  counts,
  CUTOFF,
  DAY_MS,
  everyTable,
  expectAgentLeft,
  NEXT_DAY,
  NOW,
  purge,
  requireFunction,
  seedTrace,
  shift,
  SIGNATURE,
  type AgentTable,
  type Trace,
} from './kit.ts';

async function withWorld(scenario: (world: World) => Promise<void>): Promise<void> {
  await inWorld(await createTestDatabase(), scenario);
}

const ZONES = ['UTC', 'Pacific/Kiritimati', 'America/New_York'];

/** 手算的 190 天截断点：p_now 的 +08:00 日历日 − 190 天，取该日 00:00（+08:00）。 */
const CASES: readonly { readonly now: string; readonly cutoff: string }[] = [
  // 2027-04-10 03:00 → 2026-10-02：08 细则的例子，跨年。
  { now: NOW, cutoff: CUTOFF[190] },
  // 2027-04-09 03:00 → 2026-10-01：例子的前一天那一轮。
  { now: '2027-04-08T19:00:00.000Z', cutoff: '2026-09-30T16:00:00.000Z' },
  // 2026-12-31 23:59:59.999 → 2026-06-24：日界前一毫秒还算当日。
  { now: '2026-12-31T15:59:59.999Z', cutoff: '2026-06-23T16:00:00.000Z' },
  // 2027-01-01 00:00 → 2026-06-25：日界恰到就算下一日。
  { now: '2026-12-31T16:00:00.000Z', cutoff: '2026-06-24T16:00:00.000Z' },
  // 2028-03-01 00:00 → 2027-08-24：减去闰年的 2 月 29 日。
  { now: '2028-02-29T16:00:00.000Z', cutoff: '2027-08-23T16:00:00.000Z' },
];

const LATER_THAN_EVERY_CASE = '2035-01-01T00:00:00.000Z';

it('[AC-B3-08s#1] 九张表：恰等于截断点保留，早一毫秒删；按 +08:00 日历天相减，跨年跨闰年，不看会话时区；p_days 决定截断点', async () => {
  await withWorld(async ({ app, maint }) => {
    await requireFunction(maint);
    for (const zone of ZONES) {
      for (const entry of CASES) {
        const { cutoff } = entry;
        await seedTrace(app, shift(cutoff, -1));
        await seedTrace(app, cutoff);
        await seedTrace(app, shift(cutoff, 1));
        await maint.transaction().execute(async (trx) => {
          await sql`SELECT set_config('TimeZone', ${zone}, true)`.execute(trx);
          expect(await purge(trx, entry.now, 190, 1000), `${zone} ${entry.now}`).toEqual(
            everyTable(1),
          );
          expect(await purge(trx, entry.now, 190, 1000), `${zone} ${entry.now}`).toEqual(
            everyTable(0),
          );
        });
        await expectAgentLeft(app, () => [cutoff, shift(cutoff, 1)]);
        expect(await purge(maint, LATER_THAN_EVERY_CASE, 190, 1000)).toEqual(everyTable(2));
      }
    }
    // 184 与 200 天：截断点随 p_days 移动，不是写死 190。
    for (const days of [184, 200] as const) {
      const cutoff = CUTOFF[days];
      await seedTrace(app, shift(cutoff, -1));
      await seedTrace(app, cutoff);
      expect(await purge(maint, NOW, days, 1000), String(days)).toEqual(everyTable(1));
      await expectAgentLeft(app, () => [cutoff]);
      expect(await purge(maint, LATER_THAN_EVERY_CASE, 190, 1000)).toEqual(everyTable(1));
    }
  });
}, 120_000);

it('[AC-B3-08s#2] 入参为空或越界报错且什么都不删：p_days 低于 184 报 22023；184、36500、批量 1 与 10000 可用', async () => {
  await withWorld(async ({ app, maint }) => {
    await requireFunction(maint);
    const expired = shift(CUTOFF[190], -1);
    await seedTrace(app, expired);
    const inputs: Array<[string | null, number | null, number | null, string]> = [
      [null, 190, 1, '22004'],
      [NOW, null, 1, '22004'],
      [NOW, 190, null, '22004'],
      ['infinity', 190, 1, '22023'],
      ['-infinity', 190, 1, '22023'],
      [NOW, 183, 1, '22023'],
      [NOW, 180, 1, '22023'],
      [NOW, 30, 1, '22023'],
      [NOW, 0, 1, '22023'],
      [NOW, -1, 1, '22023'],
      [NOW, 36501, 1, '22023'],
      [NOW, 2147483647, 1, '22023'],
      [NOW, 190, 0, '22023'],
      [NOW, 190, -1, '22023'],
      [NOW, 190, 10001, '22023'],
    ];
    for (const [now, days, size, code] of inputs) {
      expect(
        await sqlState(purge(maint, now, days, size)),
        `${String(now)} ${String(days)} ${String(size)}`,
      ).toBe(code);
    }
    await expectAgentLeft(app, () => [expired]);

    expect(await purge(maint, NOW, 184, 1)).toEqual(everyTable(1));
    await seedTrace(app, expired);
    expect(await purge(maint, NOW, 190, 10000)).toEqual(everyTable(1));
    await seedTrace(app, '1900-01-01T00:00:00.000Z');
    expect(await purge(maint, NOW, 36500, 10000)).toEqual(everyTable(1));
    await expectAgentLeft(app, () => []);
    // 什么都没删时仍返回九行 0。
    expect(await purge(maint, NOW, 190, 1000)).toEqual(everyTable(0));
  });
}, 60_000);

it('[AC-B3-08s#3] 每张表每次最多删一批，从 created_at 最旧的开始，跨 app_id；未到期的不删', async () => {
  await withWorld(async ({ app, maint }) => {
    await requireFunction(maint);
    const expired = [3, 2, 1].map((days) => shift(CUTOFF[190], -days * DAY_MS));
    for (const [index, at] of expired.entries()) {
      await seedTrace(app, at, { appId: index % 2 === 0 ? 'other-app' : 'couli' });
    }
    await seedTrace(app, CUTOFF[190]);

    expect(await purge(maint, NOW, 190, 1)).toEqual(everyTable(1));
    await expectAgentLeft(app, () => [...expired.slice(1), CUTOFF[190]]);
    expect(await purge(maint, NOW, 190, 2)).toEqual(everyTable(2));
    await expectAgentLeft(app, () => [CUTOFF[190]]);
    expect(await purge(maint, NOW, 190, 2)).toEqual(everyTable(0));
  });
}, 60_000);

it.each(AGENT_TABLES)(
  '[AC-B3-08s#4] %s 的行还没到期：它和它的祖先行保留，不报 23503；其余到期行照删；它到期后下一轮连祖先一起删',
  async (fresh) => {
    await withWorld(async ({ app, maint }) => {
      await requireFunction(maint);
      const old = shift(CUTOFF[190], -DAY_MS);
      const times: Partial<Record<AgentTable, string>> = {};
      times[fresh] = CUTOFF[190];
      await seedTrace(app, old, { times });
      const kept = new Set<AgentTable>([fresh, ...ancestors(fresh)]);

      expect(await purge(maint, NOW, 190, 1000)).toEqual(
        counts((table) => (kept.has(table) ? 0 : 1)),
      );
      await expectAgentLeft(app, (table) =>
        table === fresh ? [CUTOFF[190]] : kept.has(table) ? [old] : [],
      );

      // 后一天那一轮：截断点晚一天，这一行也到期了。
      expect(await purge(maint, NEXT_DAY, 190, 1000)).toEqual(
        counts((table) => (kept.has(table) ? 1 : 0)),
      );
      await expectAgentLeft(app, () => []);
    });
  },
  60_000,
);

interface LockCase {
  readonly label: string;
  /** 被锁住、本次调用必须跳过的行所在的表与它们的祖先。 */
  readonly kept: readonly AgentTable[];
  readonly hold: (trx: Kysely<DB>, trace: Trace) => Promise<unknown>;
}

const LOCKS: readonly LockCase[] = [
  {
    label: 'agent_runs 的行被 FOR UPDATE 锁住',
    kept: ['agent_runs', 'agent_sessions'],
    hold: (trx, trace) =>
      sql`SELECT 1 FROM app.agent_runs WHERE id = ${trace.runId} FOR UPDATE`.execute(trx),
  },
  {
    label: 'agent_messages 的行被 FOR UPDATE 锁住',
    kept: ['agent_messages', 'agent_runs', 'agent_sessions'],
    hold: (trx, trace) =>
      sql`SELECT 1 FROM app.agent_messages WHERE id = ${trace.messageId} FOR UPDATE`.execute(trx),
  },
  {
    label: '写入方给到期的 run 插一条还没提交的工具调用（父行上的 KEY SHARE）',
    kept: ['agent_runs', 'agent_sessions'],
    hold: (trx, trace) =>
      sql`
        INSERT INTO app.agent_tool_calls (id, app_id, run_id, seq, name, status, created_at)
        VALUES (${randomUUID()}, ${trace.appId}, ${trace.runId}, 2, 'synthetic_search', 'ok',
          ${NOW}::timestamptz)
      `.execute(trx),
  },
  {
    label: '写入方给到期的会话插一条还没提交的助手消息（父行上的 KEY SHARE）',
    kept: ['agent_sessions'],
    hold: (trx, trace) =>
      sql`
        INSERT INTO app.agent_messages (id, app_id, session_id, role, created_at, updated_at)
        VALUES (${randomUUID()}, ${trace.appId}, ${trace.sessionId}, 'assistant',
          ${NOW}::timestamptz, ${NOW}::timestamptz)
      `.execute(trx),
  },
];

it.each(LOCKS)(
  '[AC-B3-08s#5] $label：跳过（SKIP LOCKED），不等锁、不报错，父行留着；锁放开后下一次删掉',
  async ({ kept, hold }) => {
    await withWorld(async ({ app, maint, database }) => {
      await requireFunction(maint);
      const expired = shift(CUTOFF[190], -DAY_MS);
      const trace = await seedTrace(app, expired);
      const skipped = new Set<AgentTable>(kept);
      const lock = holdLock(database, (trx) => hold(trx, trace));
      try {
        await lock.ready;
        expect(await purge(maint, NOW, 190, 1000)).toEqual(
          counts((table) => (skipped.has(table) ? 0 : 1)),
        );
      } finally {
        lock.release();
        await lock.done;
      }
      await expectAgentLeft(app, (table) => (skipped.has(table) ? [expired] : []));
      expect(await purge(maint, NOW, 190, 1000)).toEqual(
        counts((table) => (skipped.has(table) ? 1 : 0)),
      );
      await expectAgentLeft(app, () => []);
    });
  },
  60_000,
);

const ACL = ['couli_maint=X/couli_migrator', 'couli_migrator=X/couli_migrator'];

const BUSINESS_ROLES = ['couli_app', 'couli_maint', 'couli_payout', 'couli_readonly'];

/** 函数正文不得引用的表：规则切片、转链、设备、用户、配置，以及账务、订单、审计、提现类表（⑧⑫⑰）。 */
const OFF_LIMITS =
  /\bapp\.(agent_rule_chunks\b|links\b|link_logs\b|devices\b|users\b|config_items\b|orders\b|order_|ledger_|withdrawals|withdraw_|payout_|settle_|commission_|claims|claim_items|audit_logs|blocklist)/;

it('[AC-B3-08s#6] SECURITY DEFINER 函数：一个重载、属主 couli_migrator、search_path 与 lock_timeout 固定、只授 couli_maint；任何业务角色都没有九张表的 DELETE；九张表各有 created_at 单列索引', async () => {
  await withWorld(async ({ app, maint, payout, readonly }) => {
    await requireFunction(maint);
    const expired = shift(CUTOFF[190], -1);
    await seedTrace(app, expired);

    const definition = await sql<{
      owner: string;
      security_definer: boolean;
      result: string;
      settings: string[] | null;
      acl: string[] | null;
      source: string;
    }>`
      SELECT pg_get_userbyid(proowner)::text AS owner, prosecdef AS security_definer,
        pg_get_function_result(oid) AS result, proconfig AS settings, proacl::text[] AS acl,
        prosrc AS source
      FROM pg_proc
      WHERE oid = to_regprocedure(${SIGNATURE})
    `.execute(app);
    const row = definition.rows[0];
    expect(row).toMatchObject({
      owner: 'couli_migrator',
      security_definer: true,
      result: 'TABLE(table_name text, deleted bigint)',
    });
    expect(row?.settings ?? []).toEqual(
      expect.arrayContaining(['search_path=pg_catalog, pg_temp', 'lock_timeout=5s']),
    );
    expect([...(row?.acl ?? [])].sort()).toEqual(ACL);
    const code = (row?.source ?? '').replace(/--[^\n]*/g, '');
    for (const table of AGENT_TABLES) expect(code, table).toContain(`app.${table}`);
    expect(code).not.toMatch(OFF_LIMITS);

    const overloads = await sql<{ n: bigint }>`
      SELECT count(*) AS n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname = 'delete_expired_agent_traces'
    `.execute(app);
    expect(overloads.rows).toEqual([{ n: 1n }]);

    for (const role of [app, payout, readonly]) {
      expect(await sqlState(purge(role, NOW, 190, 1000))).toBe('42501');
    }
    const deletable = await sql<{ role: string; name: string }>`
      SELECT r.role, t.name
      FROM unnest(${BUSINESS_ROLES}::text[]) AS r(role)
      CROSS JOIN unnest(${[...AGENT_TABLES]}::text[]) AS t(name)
      WHERE has_table_privilege(r.role, 'app.' || t.name, 'DELETE,TRUNCATE')
    `.execute(app);
    expect(deletable.rows).toEqual([]);
    for (const table of AGENT_TABLES) {
      expect(
        await sqlState(sql`DELETE FROM ${sql.table(`app.${table}`)}`.execute(maint)),
        table,
      ).toBe('42501');
    }

    const unindexed = await sql<{ name: string }>`
      SELECT t.name
      FROM unnest(${[...AGENT_TABLES]}::text[]) AS t(name)
      WHERE NOT EXISTS (
        SELECT 1
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
        WHERE i.indrelid = ('app.' || t.name)::regclass
          AND i.indnatts = 1 AND i.indexprs IS NULL AND i.indpred IS NULL
          AND a.attname = 'created_at'
      )
    `.execute(app);
    expect(unindexed.rows).toEqual([]);

    await expectAgentLeft(app, () => [expired]);
    expect(await purge(maint, NOW, 190, 1000)).toEqual(everyTable(1));
  });
}, 60_000);
