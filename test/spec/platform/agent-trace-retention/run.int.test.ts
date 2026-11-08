// B3-08s — worker 维护轮次里的 Agent trace 到期清理（maintenance 第 M 节；BR-ID-30 ①、BR-AI-19、BR-AI-22；编排
// D10-454、D10-971、D10-999）。契约见 ./kit.ts 文件头。「不清」的场景在骨架上本来就成立，所以这些用例都接着验证
// 同一批行随后被删，否则红不起来。
import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import { createPartitionMaintenance } from '../../../../apps/api/src/modules/platform/maintenance/index.ts';
import { createWorkerMaintenance } from '../../../../apps/api/src/modules/platform/maintenance/worker.ts';
import {
  ALL_ENSURED,
  done,
  line,
  memoryLogger,
  reduceLine,
  settableClock,
} from '../maintenance/kit.ts';
import { countRows, holdLock, inWorld, seedRow, setConfig, type World } from '../retention/kit.ts';
import {
  AGENT_TABLES,
  agentLines,
  ancestors,
  AT_FOUR,
  BEFORE_GATE,
  cleanupLines,
  CUTOFF,
  DAY_MS,
  DAYS_KEY,
  expectAgentLeft,
  HALF_PAST_THREE,
  keptOf,
  LOGIN_EXPIRED,
  NEXT_DAY,
  NOW,
  PERSONAL,
  PREVIOUS_DAY,
  seedTrace,
  shift,
  SWITCH_KEY,
  workerAt,
  type AgentTable,
} from './kit.ts';

async function withWorld(scenario: (world: World) => Promise<void>): Promise<void> {
  await inWorld(await createTestDatabase(), scenario);
}

/** 每张表删了 rows(table) 行时本节写的 info 行（0 行的表不写）。 */
function purgedLines(rows: (table: AgentTable) => number): Record<string, unknown>[] {
  return AGENT_TABLES.filter((table) => rows(table) > 0).map((table) =>
    line('info', 'agent_trace_purged', { table, rows: rows(table) }),
  );
}

/** 不论顺序，正好是这些行。 */
function expectSameLines(
  actual: readonly (Record<string, unknown> | string)[],
  expected: readonly Record<string, unknown>[],
): void {
  expect(actual).toHaveLength(expected.length);
  expect(actual).toEqual(expect.arrayContaining([...expected]));
}

const EXPIRED = shift(CUTOFF[190], -1);

it.each(['module', 'worker'] as const)(
  '[AC-B3-08s#7] %s：+08:00 03:00:00.000 起清 agent_*，02:59:59.999 不动；03:00 那轮第 K 节的 login_logs 仍不删，04:00 才删；时钟每轮只读一次',
  async (entry) => {
    await withWorld(async (world) => {
      const { app, maint } = world;
      await seedTrace(app, EXPIRED);
      await seedRow(app, 'login_logs', LOGIN_EXPIRED);
      const clock = settableClock(BEFORE_GATE);
      const { logger, lines } = memoryLogger();
      const options = { db: maint, clock, logger };
      const maintenance =
        entry === 'worker'
          ? createWorkerMaintenance(options)
          : createPartitionMaintenance({ ...options, dayPartitions: true });

      expect((await maintenance.runOnce()).failed).toBe(0);
      await expectAgentLeft(app, () => [EXPIRED]);
      expect(await countRows(app, 'login_logs')).toBe(1n);
      expect(agentLines(lines)).toEqual([]);
      expect(clock.calls()).toBe(1);

      clock.set(NOW);
      expect((await maintenance.runOnce()).failed).toBe(0);
      await expectAgentLeft(app, () => []);
      expect(await countRows(app, 'login_logs')).toBe(1n);
      expect(clock.calls()).toBe(2);

      clock.set(AT_FOUR);
      expect((await maintenance.runOnce()).failed).toBe(0);
      expect(await countRows(app, 'login_logs')).toBe(0n);
      expect(clock.calls()).toBe(3);
    });
  },
  60_000,
);

it('[AC-B3-08s#8] dayPartitions 未开的实例不清 agent_*（与第 K 节同一条件）；同一时刻 worker 实例清掉', async () => {
  await withWorld(async (world) => {
    const { app, maint } = world;
    await seedTrace(app, EXPIRED);
    const { logger, lines } = memoryLogger();
    const plain = createPartitionMaintenance({ db: maint, logger, clock: settableClock(NOW) });
    expect((await plain.runOnce()).failed).toBe(0);
    await expectAgentLeft(app, () => [EXPIRED]);
    expect(agentLines(lines)).toEqual([]);

    const { maintenance } = workerAt(world, NOW);
    expect((await maintenance.runOnce()).failed).toBe(0);
    await expectAgentLeft(app, () => []);
  });
}, 60_000);

/** 2026-10-01 00:00 与 23:59:59.999（+08:00），以及 2026-10-02 00:00（+08:00）。 */
const OCTOBER_FIRST = ['2026-09-30T16:00:00.000Z', '2026-10-01T15:59:59.999Z'];
const OCTOBER_SECOND = '2026-10-01T16:00:00.000Z';

it('[AC-B3-08s#9] 08 细则的例子：2026-10-01 创建的 run 及其会话、消息等在 2027-04-09 那轮保留，2027-04-10 03:00 那轮删除；10-02 的留到下一天', async () => {
  await withWorld(async (world) => {
    const { app } = world;
    for (const at of [...OCTOBER_FIRST, OCTOBER_SECOND]) await seedTrace(app, at);
    const { maintenance, clock } = workerAt(world, PREVIOUS_DAY);

    expect((await maintenance.runOnce()).failed).toBe(0);
    await expectAgentLeft(app, () => [...OCTOBER_FIRST, OCTOBER_SECOND]);

    clock.set(NOW);
    expect((await maintenance.runOnce()).failed).toBe(0);
    await expectAgentLeft(app, () => [OCTOBER_SECOND]);

    clock.set(NEXT_DAY);
    expect((await maintenance.runOnce()).failed).toBe(0);
    await expectAgentLeft(app, () => []);
  });
}, 60_000);

it('[AC-B3-08s#10] 范围：九张 agent_* 表删光；agent_rule_chunks、links（含 agent_session_id / agent_card_id）、devices、articles 一行不动', async () => {
  await withWorld(async (world) => {
    const { app } = world;
    const longAgo = '2025-01-01T00:00:00.000Z';
    const linkId = randomUUID();
    await sql`
      INSERT INTO app.links
        (app_id, link_id, platform, scene, expire_at, agent_session_id, agent_card_id, created_at)
      VALUES ('couli', ${linkId}::uuid, 'demo', 'self', ${longAgo}::timestamptz,
        ${randomUUID()}::uuid, 'c1', ${longAgo}::timestamptz)
    `.execute(app);
    const articleId = randomUUID();
    await sql`
      INSERT INTO app.articles
        (id, app_id, category, title, body, version, status, published_at, notice_closable)
      VALUES (${articleId}, 'couli', 'rule', 'synthetic rule', 'synthetic rule body', 1,
        'published', ${longAgo}::timestamptz, false)
    `.execute(app);
    await sql`
      INSERT INTO app.agent_rule_chunks
        (chunk_id, app_id, article_id, published_version, seq, title, text, created_at)
      VALUES (${randomUUID()}, 'couli', ${articleId}, 1, 0, 'synthetic rule',
        'synthetic rule chunk', ${longAgo}::timestamptz)
    `.execute(app);
    await seedTrace(app, longAgo, { linkId });
    const link = async (): Promise<unknown[]> =>
      (await sql`SELECT * FROM app.links WHERE link_id = ${linkId}::uuid`.execute(app)).rows;
    const before = await link();
    expect(before).toHaveLength(1);

    const { maintenance } = workerAt(world, NOW);
    expect((await maintenance.runOnce()).failed).toBe(0);
    await expectAgentLeft(app, () => []);
    expect(await link()).toEqual(before);
    expect(await countRows(app, 'agent_rule_chunks')).toBe(1n);
    expect(await countRows(app, 'articles')).toBe(1n);
    expect(await countRows(app, 'devices')).toBe(1n);
  });
}, 60_000);

it.each([184, 200] as const)(
  '[AC-B3-08s#11] agent.trace.retention_days 为 %i：按它算截断点；每轮重读，改回 190 下一轮按 190',
  async (days) => {
    await withWorld(async (world) => {
      const { app } = world;
      const times = [shift(CUTOFF[190], -1), CUTOFF[190], shift(CUTOFF[days], -1), CUTOFF[days]];
      for (const at of times) await seedTrace(app, at);
      await setConfig(app, DAYS_KEY, String(days));
      const { maintenance } = workerAt(world, NOW);

      expect((await maintenance.runOnce()).failed).toBe(0);
      const first = keptOf(times, CUTOFF[days]);
      await expectAgentLeft(app, () => first);

      await setConfig(app, DAYS_KEY, '190');
      expect((await maintenance.runOnce()).failed).toBe(0);
      await expectAgentLeft(app, () => keptOf(first, CUTOFF[190]));
    });
  },
  60_000,
);

it.each([null, '"200"', '200.5', 'true', 'null', '{"days":200}', '[200]', '183', '0', '-1', '30'])(
  '[AC-B3-08s#12] agent.trace.retention_days 为 %s（null 即无配置行）不可用：回落 190 天照常清、不记失败',
  async (value) => {
    await withWorld(async (world) => {
      const { app } = world;
      const times = [shift(CUTOFF[190], -1), CUTOFF[190], shift(CUTOFF[184], -1)];
      for (const at of times) await seedTrace(app, at);
      if (value !== null) await setConfig(app, DAYS_KEY, value);
      const { maintenance, lines } = workerAt(world, NOW);

      expect((await maintenance.runOnce()).failed).toBe(0);
      await expectAgentLeft(app, () => keptOf(times, CUTOFF[190]));
      expectSameLines(
        cleanupLines(lines),
        purgedLines(() => 1),
      );
    });
  },
  60_000,
);

it('[AC-B3-08s#13] 高于函数上限的配置值按 36500 天，不回落 190：什么都不删也不记失败；改回 190 后才删', async () => {
  await withWorld(async (world) => {
    const { app } = world;
    await seedTrace(app, EXPIRED);
    await setConfig(app, DAYS_KEY, '99999');
    const { maintenance, lines } = workerAt(world, NOW);

    expect((await maintenance.runOnce()).failed).toBe(0);
    await expectAgentLeft(app, () => [EXPIRED]);
    expect(cleanupLines(lines)).toEqual([]);

    await setConfig(app, DAYS_KEY, '190');
    expect((await maintenance.runOnce()).failed).toBe(0);
    await expectAgentLeft(app, () => []);
  });
}, 60_000);

it('[AC-B3-08s#14] retention.purge.enabled 为 false：03:00 与 04:00 都不清 agent_*，其他维护照常、不写多余日志；改回 true 后清掉', async () => {
  await withWorld(async (world) => {
    const { app } = world;
    await seedTrace(app, EXPIRED);
    await setConfig(app, SWITCH_KEY, 'false');
    const { maintenance, clock, lines } = workerAt(world, NOW);

    const off = await maintenance.runOnce();
    expect(off.failed).toBe(0);
    expect(off.ensured).toHaveLength(ALL_ENSURED);
    await expectAgentLeft(app, () => [EXPIRED]);
    expect(lines.map(reduceLine)).toEqual([done(ALL_ENSURED, 0, 0)]);

    clock.set(AT_FOUR);
    expect((await maintenance.runOnce()).failed).toBe(0);
    await expectAgentLeft(app, () => [EXPIRED]);
    expect(cleanupLines(lines)).toEqual([]);

    await setConfig(app, SWITCH_KEY, 'true');
    expect((await maintenance.runOnce()).failed).toBe(0);
    await expectAgentLeft(app, () => []);
  });
}, 60_000);

it.each(['true', '"false"', '0', 'null'])(
  '[AC-B3-08s#15] retention.purge.enabled 为 %s：不是 false 就算开，03:00 照常清',
  async (value) => {
    await withWorld(async (world) => {
      const { app } = world;
      await seedTrace(app, EXPIRED);
      await setConfig(app, SWITCH_KEY, value);
      const { maintenance } = workerAt(world, NOW);
      expect((await maintenance.runOnce()).failed).toBe(0);
      await expectAgentLeft(app, () => []);
    });
  },
  60_000,
);

it.each([HALF_PAST_THREE, AT_FOUR])(
  '[AC-B3-08s#16] %s 配置读失败：开关未知不清，整轮只记一行 retention_purge_failed（config_items）、failed 为 1；下一轮补上',
  async (instant) => {
    await withWorld(async (world) => {
      const { app, database } = world;
      await seedTrace(app, EXPIRED);
      const { maintenance, lines } = workerAt(world, instant);
      const lock = holdLock(database, (trx) =>
        sql`LOCK TABLE app.config_items IN ACCESS EXCLUSIVE MODE`.execute(trx),
      );
      try {
        await lock.ready;
        expect((await maintenance.runOnce()).failed).toBe(1);
      } finally {
        lock.release();
        await lock.done;
      }
      await expectAgentLeft(app, () => [EXPIRED]);
      expect(cleanupLines(lines)).toEqual([
        line('error', 'retention_purge_failed', { table: 'config_items', sqlstate: '55P03' }),
      ]);

      lines.length = 0;
      expect((await maintenance.runOnce()).failed).toBe(0);
      await expectAgentLeft(app, () => []);
    });
  },
  60_000,
);

it('[AC-B3-08s#17] 父行下还有没到期的子行：父行留着、不算失败，其余到期行照删；子行到期后下一天那轮连父行一起删', async () => {
  await withWorld(async (world) => {
    const { app } = world;
    const old = shift(CUTOFF[190], -DAY_MS);
    for (const fresh of AGENT_TABLES) {
      const times: Partial<Record<AgentTable, string>> = {};
      times[fresh] = CUTOFF[190];
      await seedTrace(app, old, { times });
    }
    const left = (table: AgentTable): string[] =>
      AGENT_TABLES.flatMap((fresh) => {
        if (fresh === table) return [CUTOFF[190]];
        return ancestors(fresh).includes(table) ? [old] : [];
      });
    const { maintenance, clock, lines } = workerAt(world, NOW);

    expect((await maintenance.runOnce()).failed).toBe(0);
    await expectAgentLeft(app, left);
    expectSameLines(
      agentLines(lines),
      purgedLines((table) => AGENT_TABLES.length - left(table).length),
    );

    clock.set(NEXT_DAY);
    lines.length = 0;
    expect((await maintenance.runOnce()).failed).toBe(0);
    await expectAgentLeft(app, () => []);
    expectSameLines(
      agentLines(lines),
      purgedLines((table) => left(table).length),
    );
  });
}, 60_000);

it('[AC-B3-08s#18] 报告形状与计数不变，日志只有表名与删除行数，没有用户编号与文本；没有删除时不多出日志行', async () => {
  await withWorld(async (world) => {
    await seedTrace(world.app, EXPIRED, { shape: 'reported' });
    const { maintenance, lines } = workerAt(world, NOW);

    const report = await maintenance.runOnce();
    expect(Object.keys(report).sort()).toEqual(['defaultRows', 'dropped', 'ensured', 'failed']);
    expect(report).toMatchObject({ dropped: [], defaultRows: [], failed: 0 });
    expect(report.ensured).toHaveLength(ALL_ENSURED);
    const written = lines.map(reduceLine);
    expect(written.at(-1)).toEqual(done(ALL_ENSURED, 0, 0));
    expectSameLines(
      written.slice(0, -1),
      purgedLines(() => 1),
    );
    expect(lines.filter((raw) => PERSONAL.test(raw))).toEqual([]);

    lines.length = 0;
    expect((await maintenance.runOnce()).failed).toBe(0);
    expect(lines.map(reduceLine)).toEqual([done(ALL_ENSURED, 0, 0)]);
  });
}, 60_000);

it('[AC-B3-08s#19] 一张表多于一批（1001 条澄清记录）：同一轮分批删到 0，会话随后删掉，每表只写一行合计', async () => {
  await withWorld(async (world) => {
    const { app } = world;
    const trace = await seedTrace(app, EXPIRED);
    await sql`
      INSERT INTO app.agent_clarify_asks (app_id, session_id, chain_id, slot, created_at)
      SELECT 'couli', ${trace.sessionId}::uuid, 'synthetic-chain-' || n, 'price',
        ${EXPIRED}::timestamptz
      FROM generate_series(1, 1000) AS series(n)
    `.execute(app);
    const { maintenance, lines } = workerAt(world, NOW);

    expect((await maintenance.runOnce()).failed).toBe(0);
    expect(await countRows(app, 'agent_clarify_asks')).toBe(0n);
    await expectAgentLeft(app, () => []);
    expectSameLines(
      agentLines(lines),
      purgedLines((table) => (table === 'agent_clarify_asks' ? 1001 : 1)),
    );
  });
}, 120_000);

it.each(['erased', 'reported'] as const)(
  '[AC-B3-08s#20] %s 的行（注销后已清空文本、用户编号换哈希 / 被举报、点踩成 badcase）没有保留例外：到期同样整行删，分界上的保留',
  async (shape) => {
    await withWorld(async (world) => {
      const { app } = world;
      await seedTrace(app, EXPIRED, { shape });
      await seedTrace(app, CUTOFF[190], { shape });
      const { maintenance, lines } = workerAt(world, NOW);

      expect((await maintenance.runOnce()).failed).toBe(0);
      await expectAgentLeft(app, () => [CUTOFF[190]]);
      expectSameLines(
        agentLines(lines),
        purgedLines(() => 1),
      );
    });
  },
  60_000,
);
