// CT-13k：events 清理某一步失败后当天不记为已完成，同一 worker 同一 +08:00 日的下一轮须重跑三个删除步骤。
// 通过已接入 worker 的入口验证；不连库，沿用 events-retention 的假库与注入时钟。
import { expect, it } from 'vitest';

import { cleanupQueries, fakeDb, NOW, STEPS, stepOf, workerAt } from '../events-retention/kit.ts';

it.each(STEPS)(
  '[AC-CT-13k#1] %s 失败后当天不记为已清理：同日下一轮按序重跑三个删除步骤并成功，再下一轮不重删',
  async (failedStep) => {
    const fake = await fakeDb();
    try {
      // NOW = 10-09 04:00 +08:00；第一轮放在 04:30，后续轮次仍在 10-09 当天。
      const run = workerAt(fake.db, '2026-10-08T20:30:00.000Z');
      expect(new Date('2026-10-08T20:30:00.000Z').getTime()).toBeGreaterThan(
        new Date(NOW).getTime(),
      );

      // 第一轮：注入失败，runOnce 抛出原错误，失败步骤之后的删除不执行。
      fake.control.fail = failedStep;
      await expect(run.maintenance.runOnce()).rejects.toBe(fake.control.error);
      const round1 = cleanupQueries(fake.queries).map(stepOf);
      expect(round1).toEqual(STEPS.slice(0, STEPS.indexOf(failedStep) + 1));
      let seen = fake.queries.length;

      // 第二轮：撤去失败，同一 worker、同一 +08:00 日稍后再跑，三个删除步骤按序全部重跑。
      fake.control.fail = undefined;
      run.clock.set('2026-10-08T21:30:00.000Z'); // 10-09 05:30 +08:00
      await expect(run.maintenance.runOnce()).resolves.toBeDefined();
      const round2 = cleanupQueries(fake.queries.slice(seen));
      expect(round2.map(stepOf)).toEqual([...STEPS]);
      expect(round2.map((query) => query.parameters)).toEqual(
        STEPS.map(() => [new Date('2026-10-08T21:30:00.000Z')]),
      );
      seen = fake.queries.length;

      // 第三轮：同日已成功清理，不再执行任何删除步骤。
      run.clock.set('2026-10-09T15:59:59.999Z'); // 10-09 23:59:59.999 +08:00
      await expect(run.maintenance.runOnce()).resolves.toBeDefined();
      expect(cleanupQueries(fake.queries.slice(seen))).toEqual([]);
    } finally {
      await fake.db.destroy();
    }
  },
);
