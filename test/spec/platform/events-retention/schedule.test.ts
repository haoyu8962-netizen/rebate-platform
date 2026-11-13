// CT-13f：通过已接入 worker 的入口验证，不能用未接入的独立 helper 通过规则测试。
import { expect, it } from 'vitest';

import { reduceLine } from '../maintenance/kit.ts';
import { cleanupQueries, ENSURE, fakeDb, NOW, STEPS, stepOf, workerAt } from './kit.ts';

it('[AC-CT-13f#1] 三个删除函数逐个等待完成，先 events 分区、再 DEFAULT、最后去重表；使用同一次注入时钟', async () => {
  const fake = await fakeDb();
  try {
    const run = workerAt(fake.db);
    await run.maintenance.runOnce();
    const calls = cleanupQueries(fake.queries);
    expect(calls.map(stepOf)).toEqual(STEPS);
    expect(calls.map((query) => query.parameters)).toEqual(STEPS.map(() => [new Date(NOW)]));
    expect(run.clock.calls()).toBe(1);
    expect(fake.trace.filter((entry) => !entry.endsWith(ENSURE))).toEqual(
      STEPS.flatMap((step) => [`start:${step}`, `finish:${step}`]),
    );
  } finally {
    await fake.db.destroy();
  }
});

it('[AC-CT-13f#2] +08:00 的 04:00 前不删，当刻删一次；当天后续轮次不重删，跨日后等到下一次 04:00', async () => {
  const fake = await fakeDb();
  try {
    const run = workerAt(fake.db, '2026-10-08T19:59:59.999Z');
    for (const [instant, expectedRuns] of [
      ['2026-10-08T19:59:59.999Z', 0],
      [NOW, 1],
      ['2026-10-08T21:00:00.000Z', 1],
      ['2026-10-09T15:59:59.999Z', 1],
      ['2026-10-09T16:00:00.000Z', 1],
      ['2026-10-09T19:59:59.999Z', 1],
      ['2026-10-09T20:00:00.000Z', 2],
    ] as const) {
      run.clock.set(instant);
      await run.maintenance.runOnce();
      expect(cleanupQueries(fake.queries).map(stepOf), instant).toEqual(
        Array.from({ length: expectedRuns }, () => [...STEPS]).flat(),
      );
    }
  } finally {
    await fake.db.destroy();
  }
});

it('[AC-CT-13f#3] events 预建 +08:00 当日至未来 14 天，跨月跨年；04:00 前也预建', async () => {
  const fake = await fakeDb();
  try {
    // UTC 仍为 12-30，+08:00 已是 12-31 00:00。
    const run = workerAt(fake.db, '2026-12-30T16:00:00.000Z');
    await run.maintenance.runOnce();
    const calls = fake.queries.filter((query) => query.sql.includes(`app.${ENSURE}(`));
    const expected = [
      '2026-12-31',
      ...Array.from({ length: 14 }, (_, i) => `2027-01-${String(i + 1).padStart(2, '0')}`),
    ];
    expect(calls.map((query) => query.parameters)).toEqual(expected.map((day) => [day]));
    expect(cleanupQueries(fake.queries)).toEqual([]);
    expect(run.clock.calls()).toBe(1);
  } finally {
    await fake.db.destroy();
  }
});

it.each([ENSURE, ...STEPS] as const)(
  '[AC-CT-13f#4] %s 失败向调用方抛出原错误，不再执行后续删除步骤',
  async (failedStep) => {
    const fake = await fakeDb();
    try {
      fake.control.fail = failedStep;
      const run = workerAt(fake.db);
      await expect(run.maintenance.runOnce()).rejects.toBe(fake.control.error);
      const expected = failedStep === ENSURE ? [] : STEPS.slice(0, STEPS.indexOf(failedStep) + 1);
      expect(cleanupQueries(fake.queries).map(stepOf)).toEqual(expected);
      expect(fake.trace).not.toContain(`finish:${failedStep}`);
    } finally {
      await fake.db.destroy();
    }
  },
);

it('[AC-CT-13f#5] pino 记录每个已删 events 分区及 DEFAULT、去重表各自的实际删除行数', async () => {
  const fake = await fakeDb();
  try {
    const run = workerAt(fake.db);
    await run.maintenance.runOnce();
    const records = run.lines.map(reduceLine);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 30, table: 'events', partition: 'events_p20260709' }),
        expect.objectContaining({ level: 30, table: 'events', partition: 'events_p20260710' }),
        expect.objectContaining({ level: 30, table: 'events_default', rows: 2 }),
        expect.objectContaining({ level: 30, table: 'event_dedup', rows: 3 }),
      ]),
    );
  } finally {
    await fake.db.destroy();
  }
});

it('[AC-CT-13f#6] worker 以 couli_maint 连接执行清理，误接 couli_app 时在清理之前拒绝', async () => {
  const fake = await fakeDb();
  try {
    fake.control.role = 'couli_app';
    await expect(workerAt(fake.db).maintenance.runOnce()).rejects.toMatchObject({
      code: 'wrong_role',
    });
    expect(cleanupQueries(fake.queries)).toEqual([]);
    fake.control.role = 'couli_maint';
    await workerAt(fake.db).maintenance.runOnce();
    expect(cleanupQueries(fake.queries).map(stepOf)).toEqual(STEPS);
  } finally {
    await fake.db.destroy();
  }
});
