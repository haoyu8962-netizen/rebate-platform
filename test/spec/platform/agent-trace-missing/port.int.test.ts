// B3-08z: agent's read-only port behind couli_agent_trace_missing_runs, against PostgreSQL (contract:
// ./kit.ts header). The port always runs on a session whose every transaction is READ ONLY, so any
// write or row lock fails in PostgreSQL itself. "Now" is the injected instant only: the database's
// own now() is years before the fixture's times, so a query reading it counts nothing.
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { createAgentDataPurge } from '../../../../apps/api/src/modules/agent/deletion/index.ts';
import { createPgAgentTraceMissingPort } from '../../../../apps/api/src/modules/agent/store/trace-missing/index.ts';
import {
  createAgentTraceMissingCollector,
  createMetricsRegistry,
} from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import { readOnlyUrl } from '../metrics/kit.ts';
import {
  DAY_MS,
  EDGE,
  ENDINGS,
  HOUR_MS,
  METRIC,
  NOW,
  OLD_END,
  RECENT_END,
  byApp,
  cardsOf,
  clockAt,
  insertCard,
  insertRun,
  insertSession,
  missingGauge,
  seedRun,
  shift,
  tableSnapshot,
} from './kit.ts';

async function open() {
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  const readOnly = createDb({ connectionString: readOnlyUrl(database), max: 2 });
  return {
    db,
    readOnly,
    /** The port's result at `instant`, read on the READ ONLY session, as { app_id: runs }. */
    async missing(instant: string = NOW): Promise<Record<string, number>> {
      const port = createPgAgentTraceMissingPort({ db: readOnly });
      return byApp(await port.countMissing(new Date(instant)));
    },
    async close() {
      await destroyDb(readOnly);
      await destroyDb(db);
      await database.drop();
    },
  };
}

it('[AC-B3-08z#1] 只计「结束超过 24 小时、已出卡、没有卡片行」的 run：结束不足 24 小时、有卡片行、没出卡、没结束的都不计', async () => {
  const t = await open();
  try {
    const app = 'trace_rule';
    // Counted: a guest's run and a member's run, both ended over 24 hours ago with cards and no row.
    await seedRun(t.db, app, { endedAt: OLD_END, cardDelivered: true });
    await seedRun(t.db, app, {
      endedAt: shift(NOW, -3 * DAY_MS),
      cardDelivered: true,
      kind: 'member',
    });
    // Not counted: its card rows are there (one or two).
    await seedRun(t.db, app, { endedAt: OLD_END, cardDelivered: true, cards: 1 });
    await seedRun(t.db, app, { endedAt: OLD_END, cardDelivered: true, cards: 2, kind: 'member' });
    // Not counted: no card was emitted, so none is missing.
    await seedRun(t.db, app, { endedAt: OLD_END, cardDelivered: false });
    await seedRun(t.db, app, { endedAt: shift(NOW, -5 * DAY_MS), cardDelivered: false });
    // Not counted: ended 23 hours ago, the trace may still be on its way.
    await seedRun(t.db, app, { endedAt: RECENT_END, cardDelivered: true });
    // Not counted: never ended (accepted ten days ago), with or without the card flag.
    await seedRun(t.db, app, { endedAt: null, cardDelivered: true });
    await seedRun(t.db, app, { endedAt: null, cardDelivered: false });

    expect(await t.missing()).toEqual({ [app]: 2 });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B3-08z#2] 24 小时的边界按注入时钟：恰好结束 24 小时不计、多 1 毫秒计；时钟再走 1 毫秒，前者也计', async () => {
  const t = await open();
  try {
    const app = 'trace_edge';
    await seedRun(t.db, app, { endedAt: EDGE, cardDelivered: true });
    await seedRun(t.db, app, { endedAt: shift(EDGE, -1), cardDelivered: true });

    expect(await t.missing(NOW)).toEqual({ [app]: 1 });
    expect(await t.missing(shift(NOW, 1))).toEqual({ [app]: 2 });
    // Two hours earlier both are within their 24 hours: nothing is counted, and the app is absent.
    expect(await t.missing(shift(NOW, -2 * HOUR_MS))).toEqual({});
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B3-08z#3] 卡片行按 run 认：同一会话里别的 run 有卡片行，不替缺卡片行的 run 兜底；一个 run 有几张卡都只算有', async () => {
  const t = await open();
  try {
    const app = 'trace_same_session';
    const session = await insertSession(t.db, app, 'member');
    const written = await insertRun(t.db, session, {
      endedAt: shift(OLD_END, -HOUR_MS),
      cardDelivered: true,
    });
    await insertCard(t.db, session, written, 'c1');
    await insertCard(t.db, session, written, 'c2');
    // The later run of the same session lost its card rows: counted, whatever its sibling has.
    await insertRun(t.db, session, { endedAt: OLD_END, cardDelivered: true });
    // A third run with one row of its own: not counted.
    const third = await insertRun(t.db, session, { endedAt: OLD_END, cardDelivered: true });
    await insertCard(t.db, session, third, 'c3');

    expect(await t.missing()).toEqual({ [app]: 1 });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B3-08z#4] 已注销的会话不算缺 trace：卡片行骨架还在（data 已清空）不计，注销后卡片没写入也不计；同一 app 的游客会话照计', async () => {
  const t = await open();
  try {
    const app = 'trace_erased';
    // Erased after its cards were written: the rows stay with data '{}' (BR-AI-22).
    const kept = await seedRun(t.db, app, {
      endedAt: shift(NOW, -3 * DAY_MS),
      cardDelivered: true,
      cards: 2,
      kind: 'erased',
    });
    expect(await cardsOf(t.db, kept.runId)).toEqual([
      { data: {}, fallback_text: '内容已删除' },
      { data: {}, fallback_text: '内容已删除' },
    ]);
    // Erased before its cards were written: the trace writer skipped them (B3-08y).
    await seedRun(t.db, app, { endedAt: OLD_END, cardDelivered: true, kind: 'erased' });
    await seedRun(t.db, app, {
      endedAt: shift(NOW, -6 * DAY_MS),
      cardDelivered: true,
      kind: 'erased',
    });
    // A guest session (user_id and user_hash both NULL) is not detached: counted.
    await seedRun(t.db, app, { endedAt: OLD_END, cardDelivered: true, kind: 'guest' });

    expect(await t.missing()).toEqual({ [app]: 1 });

    // An app whose only missing traces are in erased sessions has no element at all.
    await seedRun(t.db, 'trace_erased_only', {
      endedAt: OLD_END,
      cardDelivered: true,
      kind: 'erased',
    });
    expect(await t.missing()).toEqual({ [app]: 1 });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B3-08z#5] 真实注销清理（BR-AI-22）之后不误报：清理前会员缺卡片行的 run 计 1，清理后（会话脱离用户、卡片行骨架还在）不计、该 app 不出现', async () => {
  const t = await open();
  try {
    const app = 'trace_purged';
    const session = await insertSession(t.db, app, 'member');
    const written = await insertRun(t.db, session, {
      endedAt: shift(NOW, -4 * DAY_MS),
      cardDelivered: true,
    });
    await insertCard(t.db, session, written, 'c1');
    await insertRun(t.db, session, { endedAt: shift(NOW, -3 * DAY_MS), cardDelivered: true });
    // Another member of the same app, not erased: still counted afterwards.
    await seedRun(t.db, app, { endedAt: OLD_END, cardDelivered: true, kind: 'member' });

    expect(await t.missing(), 'before the purge').toEqual({ [app]: 2 });

    const purge = createAgentDataPurge({ userHashKey: 'synthetic-b3-08z-user-hash-key' });
    await t.db.transaction().execute((trx) =>
      purge.purgeAgentDataForUser(trx, {
        appId: app,
        userId: session.userId!,
        at: new Date(shift(NOW, -HOUR_MS)),
      }),
    );
    // The skeleton of the card row is still there, its data cleared.
    expect(await cardsOf(t.db, written)).toEqual([{ data: {}, fallback_text: '内容已删除' }]);

    expect(await t.missing(), 'after the purge').toEqual({ [app]: 1 });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B3-08z#6] 按 app_id 分组、互不影响：每个 app 一个元素、各数各的；只有不计的 run 的 app 不出现', async () => {
  const t = await open();
  try {
    for (let n = 0; n < 3; n += 1) {
      await seedRun(t.db, 'trace_app_x', {
        endedAt: shift(OLD_END, -n * HOUR_MS),
        cardDelivered: true,
        kind: n === 0 ? 'member' : 'guest',
      });
    }
    await seedRun(t.db, 'trace_app_y', { endedAt: shift(NOW, -2 * DAY_MS), cardDelivered: true });
    // trace_app_y's runs that do not count.
    await seedRun(t.db, 'trace_app_y', { endedAt: OLD_END, cardDelivered: true, cards: 1 });
    await seedRun(t.db, 'trace_app_y', { endedAt: RECENT_END, cardDelivered: true });
    // trace_app_z: only runs that do not count.
    await seedRun(t.db, 'trace_app_z', { endedAt: OLD_END, cardDelivered: false });
    await seedRun(t.db, 'trace_app_z', { endedAt: OLD_END, cardDelivered: true, cards: 3 });
    await seedRun(t.db, 'trace_app_z', { endedAt: RECENT_END, cardDelivered: true });

    expect(await t.missing()).toEqual({ trace_app_x: 3, trace_app_y: 1 });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B3-08z#7] 只读、只用注入时钟：只读会话可跑、三张表的行前后不变；没有计入的 run 时结果为空；worker registry 以该端口渲染出同样的值', async () => {
  const t = await open();
  try {
    // The session really is read-only: the port cannot write behind the test's back.
    await expect(
      seedRun(t.readOnly, 'trace_ro', { endedAt: OLD_END, cardDelivered: true }),
      'the port session must be read-only',
    ).rejects.toThrow(/read-only/);
    const port = createPgAgentTraceMissingPort({ db: t.readOnly });
    expect(byApp(await port.countMissing(new Date(NOW))), 'no runs at all').toEqual({});

    await seedRun(t.db, 'trace_ro', { endedAt: OLD_END, cardDelivered: true });
    await seedRun(t.db, 'trace_ro', { endedAt: OLD_END, cardDelivered: true, kind: 'member' });
    await seedRun(t.db, 'trace_ro_other', { endedAt: OLD_END, cardDelivered: true });
    await seedRun(t.db, 'trace_ro_other', { endedAt: OLD_END, cardDelivered: true, cards: 1 });
    const before = await tableSnapshot(t.db);

    expect(byApp(await port.countMissing(new Date(NOW)))).toEqual({
      trace_ro: 2,
      trace_ro_other: 1,
    });
    expect(await tableSnapshot(t.db), 'rows unchanged by the read').toEqual(before);

    // An hour after the end by the injected clock: within 24 hours, whatever the database thinks.
    expect(byApp(await port.countMissing(new Date(shift(OLD_END, HOUR_MS))))).toEqual({});

    const registry = createMetricsRegistry({
      entry: 'worker',
      collectAgentTraceMissing: createAgentTraceMissingCollector(port, clockAt(NOW)),
    });
    const text = await registry.render();
    expect(text).toContain(`# TYPE ${METRIC} gauge\n`);
    expect(missingGauge(text)).toEqual({ trace_ro: 2, trace_ro_other: 1 });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B3-08z#12] 结束原因不影响判定：收卡后取消（cancelled、disconnected）、超时（timeout）、服务端出错（server_error）结束超过 24 小时、会话未注销又没有卡片行的 run 照计；同样结束原因但有卡片行、没出卡、不足 24 小时、会话已注销的不计', async () => {
  const t = await open();
  try {
    // One app per ending, so a miss names the ending it dropped; stop is the baseline.
    const endings = Object.values(ENDINGS);
    const expected: Record<string, number> = {};
    const counted: { runId: string; endReason: string; finishReason: string }[] = [];
    for (const ending of endings) {
      const app = `trace_end_${ending.endReason}`;
      expected[app] = 2;
      // Counted: a guest's and a member's run, cards went out, no card row, ended over 24 h ago.
      for (const kind of ['guest', 'member'] as const) {
        const { runId } = await seedRun(t.db, app, {
          endedAt: kind === 'guest' ? OLD_END : shift(NOW, -2 * DAY_MS),
          cardDelivered: true,
          kind,
          ending,
        });
        counted.push({ runId, endReason: ending.endReason, finishReason: ending.finishReason });
      }
      // Not counted, same ending: card rows written (one or two).
      await seedRun(t.db, app, { endedAt: OLD_END, cardDelivered: true, cards: 1, ending });
      await seedRun(t.db, app, {
        endedAt: OLD_END,
        cardDelivered: true,
        cards: 2,
        kind: 'member',
        ending,
      });
      // Not counted, same ending: no card went out; within 24 hours; an erased session.
      await seedRun(t.db, app, { endedAt: OLD_END, cardDelivered: false, ending });
      await seedRun(t.db, app, { endedAt: RECENT_END, cardDelivered: true, ending });
      await seedRun(t.db, app, { endedAt: OLD_END, cardDelivered: true, kind: 'erased', ending });
    }

    // The fixture really wrote these endings, as the stream would.
    const stored = await sql<{ id: string; end_reason: string; finish_reason: string }>`
      SELECT id, end_reason, finish_reason FROM app.agent_runs
      WHERE id = ANY(${counted.map((c) => c.runId)}::uuid[])
    `.execute(t.db);
    const written = stored.rows.map((r) => `${r.id} ${r.end_reason} ${r.finish_reason}`);
    const meant = counted.map((c) => `${c.runId} ${c.endReason} ${c.finishReason}`);
    expect(new Set(written)).toEqual(new Set(meant));
    expect(new Set(counted.map((c) => c.endReason))).toEqual(
      new Set(['stop', 'cancelled', 'disconnected', 'timeout', 'server_error']),
    );

    expect(await t.missing()).toEqual(expected);
  } finally {
    await t.close();
  }
}, 60_000);
