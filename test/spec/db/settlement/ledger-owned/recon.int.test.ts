import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import { AT, harness, insert, ready, recon, seedHandler, sqlState } from './kit.ts';

const h = harness(createTestDatabase);

it('[AC-B2-04b#23] 差错单租户、业务键和金额不得为 NULL，重复主键不能覆盖原记录', async () => {
  await ready(h.app);
  for (const field of [
    'id',
    'app_id',
    'type',
    'source',
    'period',
    'ref_type',
    'ref_id',
    'expected_fen',
    'actual_fen',
    'diff_fen',
    'status',
  ]) {
    expect(await sqlState(insert(h.app, 'recon_diffs', recon({ [field]: null }))), field).toBe(
      '23502',
    );
  }
  const row = recon();
  expect(await sqlState(insert(h.app, 'recon_diffs', row))).toBe('ok');
  expect(await sqlState(insert(h.app, 'recon_diffs', recon({ id: row['id'] })))).toBe('23505');
  const stored =
    await sql`SELECT app_id, diff_fen FROM app.recon_diffs WHERE id = ${row['id']}`.execute(h.app);
  expect(stored.rows).toEqual([{ app_id: row['app_id'], diff_fen: 1n }]);
});

it('[AC-B2-04b#6] 应用账号可登记日差错和月差错，保留正负差额与大整数精度', async () => {
  await ready(h.app);
  for (const [period, expected, actual, diff] of [
    ['2032-06-30', 9007199254740993n, 9007199254740992n, 1n],
    ['2032-06', 965800n, 966800n, -1000n],
    ['2032-07-01', -1n, -1n, 0n],
  ] as const) {
    const row = recon({ period, expected_fen: expected, actual_fen: actual, diff_fen: diff });
    expect(await sqlState(insert(h.app, 'recon_diffs', row))).toBe('ok');
    const stored = await sql`SELECT period, expected_fen, actual_fen, diff_fen,
      dedupe_key, resolution, handler_id, closed_at FROM app.recon_diffs
      WHERE id = ${row['id']}`.execute(h.app);
    expect(stored.rows).toEqual([
      {
        period,
        expected_fen: expected,
        actual_fen: actual,
        diff_fen: diff,
        dedupe_key: null,
        resolution: null,
        handler_id: null,
        closed_at: null,
      },
    ]);
  }
});

it('[AC-B2-04b#7] 原业务键拒绝重复，app、类型、周期、引用各自区分差错', async () => {
  await ready(h.app);
  // B2-02zc (D10-2224 B ①): an external type; unresolved ledger_mismatch is pinned elsewhere.
  const row = recon({ type: 'union_mismatch' });
  expect(await sqlState(insert(h.app, 'recon_diffs', row))).toBe('ok');
  expect(await sqlState(insert(h.app, 'recon_diffs', { ...row, id: randomUUID() }))).toBe('23505');
  for (const change of [
    { app_id: `other-${randomUUID()}` },
    { type: 'platform_restore' },
    { period: '2032-07-01' },
    { ref_id: randomUUID() },
  ]) {
    expect(
      await sqlState(insert(h.app, 'recon_diffs', { ...row, ...change, id: randomUUID() })),
    ).toBe('ok');
  }
});

it('[AC-B2-04b#8] 非空 dedupe_key 独立去重，同 app 跨引用仍冲突、其他 app 不冲突', async () => {
  await ready(h.app);
  const row = recon({ dedupe_key: `invariant:${randomUUID()}` });
  expect(await sqlState(insert(h.app, 'recon_diffs', row))).toBe('ok');
  expect(
    await sqlState(
      insert(h.app, 'recon_diffs', {
        ...row,
        id: randomUUID(),
        ref_id: randomUUID(),
        period: '2032-07-01',
      }),
    ),
  ).toBe('23505');
  expect(
    await sqlState(
      insert(h.app, 'recon_diffs', {
        ...row,
        id: randomUUID(),
        app_id: `other-${randomUUID()}`,
      }),
    ),
  ).toBe('ok');
  expect(
    await sqlState(
      insert(h.app, 'recon_diffs', {
        ...row,
        id: randomUUID(),
        ref_id: randomUUID(),
        dedupe_key: `other:${randomUUID()}`,
      }),
    ),
  ).toBe('ok');
});

it('[AC-B2-04b#9] 多条 NULL 去重键允许入库，更新到已占用非空键被数据库拒绝', async () => {
  await ready(h.app);
  const appId = `null-keys-${randomUUID()}`;
  const rows = [recon({ app_id: appId }), recon({ app_id: appId })];
  for (const row of rows) expect(await sqlState(insert(h.app, 'recon_diffs', row))).toBe('ok');
  for (const [index, row] of rows.entries()) {
    expect(
      await sqlState(
        sql`UPDATE app.recon_diffs SET dedupe_key = 'same-key'
      WHERE id = ${row['id']}`.execute(h.app),
      ),
    ).toBe(index === 0 ? 'ok' : '23505');
  }
  const stored = await sql`SELECT dedupe_key FROM app.recon_diffs
    WHERE app_id = ${appId} ORDER BY dedupe_key NULLS LAST`.execute(h.app);
  expect(stored.rows).toEqual([{ dedupe_key: 'same-key' }, { dedupe_key: null }]);
});

it('[AC-B2-04b#10] 并发登记同 dedupe_key 只成功一条，其余收到唯一冲突', async () => {
  await ready(h.app);
  const row = recon({ dedupe_key: `concurrent:${randomUUID()}` });
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      sqlState(
        insert(h.app, 'recon_diffs', {
          ...row,
          id: randomUUID(),
          ref_id: randomUUID(),
        }),
      ),
    ),
  );
  expect(results.sort()).toEqual(['23505', '23505', 'ok']);
  const stored = await sql`SELECT count(*) AS n FROM app.recon_diffs
    WHERE app_id = ${row['app_id']} AND dedupe_key = ${row['dedupe_key']}`.execute(h.app);
  expect(stored.rows).toEqual([{ n: 1n }]);
});

it('[AC-B2-04b#11] 月末三项不平按 app 与月份去重，处置后重跑也不能再登记', async () => {
  await ready(h.app);
  const row = recon({ type: 'month_end_unbalanced', period: '2032-06', ref_type: 'month' });
  const handler = await seedHandler(h.app, row['app_id']);
  expect(await sqlState(insert(h.app, 'recon_diffs', row))).toBe('ok');
  for (const status of ['open', 'processing', 'adjusted']) {
    expect(
      await sqlState(
        sql`UPDATE app.recon_diffs SET status = ${status},
          handler_id = ${status === 'open' ? null : handler},
          closed_at = ${status === 'adjusted' ? AT : null}::timestamptz
      WHERE id = ${row['id']}`.execute(h.app),
      ),
    ).toBe('ok');
    expect(
      await sqlState(
        insert(h.app, 'recon_diffs', {
          ...row,
          id: randomUUID(),
          ref_id: randomUUID(),
          dedupe_key: `rerun:${randomUUID()}`,
        }),
      ),
    ).toBe('23505');
  }
  for (const change of [{ app_id: `other-${randomUUID()}` }, { period: '2032-07' }]) {
    expect(
      await sqlState(insert(h.app, 'recon_diffs', { ...row, ...change, id: randomUUID() })),
    ).toBe('ok');
  }
});

it('[AC-B2-04b#12] 本任务差错类型与状态遵循契约，拒绝未知类型、来源、状态', async () => {
  await ready(h.app);
  // 仅覆盖 refs 内类型；其他 BR 的类型行为不在本任务判定范围。
  for (const [type, source, ref_type, period] of [
    ['ledger_mismatch', 'R3', 'account', '2032-06-30'],
    ['platform_restore', 'R1', 'order', '2032-06-30'],
    ['appeal_restore', 'R3', 'order', '2032-06-30'],
    ['month_end_unbalanced', 'R3', 'month', '2032-06'],
  ]) {
    const row = recon({ type, source, ref_type, period });
    expect(await sqlState(insert(h.app, 'recon_diffs', row)), type).toBe('ok');
  }
  for (const patch of [{ type: 'unknown' }, { source: 'R5' }, { status: 'resolved' }]) {
    expect(await sqlState(insert(h.app, 'recon_diffs', recon(patch)))).toBe('23514');
  }
});

it('[AC-B2-04b#13] 同 app 处理人和显式结案时间可保存，空处理人、空结论允许待处理', async () => {
  await ready(h.app);
  const row = recon();
  const handler = await seedHandler(h.app, row['app_id']);
  expect(await sqlState(insert(h.app, 'recon_diffs', row))).toBe('ok');
  // 本测试直接验证存储能力；step-up 和合法状态迁移由后续命令任务验证。
  for (const status of ['processing', 'adjusted']) {
    expect(
      await sqlState(
        sql`UPDATE app.recon_diffs SET status = ${status},
      handler_id = ${handler}, closed_at = ${status === 'adjusted' ? AT : null}::timestamptz
      WHERE id = ${row['id']}`.execute(h.app),
      ),
    ).toBe('ok');
    const stored = await sql`SELECT status, handler_id,
      closed_at = TIMESTAMPTZ '2032-06-30 16:01:00+00' AS exact_time
      FROM app.recon_diffs WHERE id = ${row['id']}`.execute(h.app);
    expect(stored.rows).toEqual([
      { status, handler_id: handler, exact_time: status === 'adjusted' ? true : null },
    ]);
  }
});

it('[AC-B2-04b#24] 不恢复可直接登记 closed，也可从 open 或 processing 关闭，拒绝未知状态', async () => {
  await ready(h.app);
  // S4 未限定结论编码；JSON 文本夹具兼容 text / jsonb，不规定结论枚举。
  const resolution = JSON.stringify({ reason: '人工核对后决定不恢复' });
  for (const type of ['platform_restore', 'appeal_restore']) {
    for (const status of ['closed', 'open', 'processing']) {
      const row = recon({ type, ref_type: 'order', status });
      const handler = await seedHandler(h.app, row['app_id']);
      expect(
        await sqlState(
          insert(h.app, 'recon_diffs', {
            ...row,
            handler_id: handler,
            closed_at: status === 'closed' ? AT : null,
            resolution: status === 'closed' ? resolution : null,
          }),
        ),
      ).toBe('ok');
      if (status !== 'closed') {
        expect(
          await sqlState(
            sql`UPDATE app.recon_diffs SET status = 'closed', handler_id = ${handler},
              closed_at = ${AT}::timestamptz, resolution = ${resolution}
              WHERE id = ${row['id']}`.execute(h.app),
          ),
        ).toBe('ok');
      }
      expect(
        await sqlState(
          sql`UPDATE app.recon_diffs SET status = 'unknown'
            WHERE id = ${row['id']}`.execute(h.app),
        ),
      ).toBe('23514');
      const stored = await sql<{
        resolution: string;
      }>`SELECT status, handler_id, resolution::text AS resolution,
        closed_at = TIMESTAMPTZ '2032-06-30 16:01:00+00' AS exact_time
        FROM app.recon_diffs WHERE id = ${row['id']}`.execute(h.app);
      expect(stored.rows).toEqual([
        {
          status: 'closed',
          handler_id: handler,
          resolution: expect.any(String),
          exact_time: true,
        },
      ]);
      expect(JSON.parse(stored.rows[0]!.resolution)).toEqual(JSON.parse(resolution));
    }
  }
  expect(await sqlState(insert(h.app, 'recon_diffs', recon({ status: 'unknown' })))).toBe('23514');
});

it('[AC-B2-04b#14] 不存在或跨 app 的处理人不能插入、不能通过更新挂入', async () => {
  await ready(h.app);
  const row = recon();
  const foreign = await seedHandler(h.app, `other-${randomUUID()}`);
  expect(await sqlState(insert(h.app, 'recon_diffs', row))).toBe('ok');
  for (const handler of [randomUUID(), foreign]) {
    expect(await sqlState(insert(h.app, 'recon_diffs', recon({ handler_id: handler })))).toBe(
      '23503',
    );
    expect(
      await sqlState(
        sql`UPDATE app.recon_diffs SET handler_id = ${handler}
      WHERE id = ${row['id']}`.execute(h.app),
      ),
    ).toBe('23503');
  }
  const stored = await sql`SELECT handler_id FROM app.recon_diffs WHERE id = ${row['id']}`.execute(
    h.app,
  );
  expect(stored.rows).toEqual([{ handler_id: null }]);
});
