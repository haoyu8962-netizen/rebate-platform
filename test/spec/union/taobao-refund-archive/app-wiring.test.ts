// B1-04zzu（D10-796 ② 甲）：app.module 把 orders 的只读实现作为 taobaoOwnOrders 交给 UnionModule.forRoot。
// 照 taobao-price-config/wiring.test.ts 的写法：观察 forRoot 收到的选项，在只记语句、不答行的假 Kysely 上调它——
// 是只读的 app.orders 查询（同 app、platform taobao、所问单号），不加锁、不写；空入参不查库、答空集。
// 不连真库、不监听、不联网；数据全部合成。
import { afterEach, expect, it, vi } from 'vitest';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  UnionModule,
  type UnionModuleOptions,
} from '../../../../apps/api/src/modules/union/index.ts';
import { expectOwnOrderRead, recordingDatabase, tradeIdOf } from './kit.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const clock = new FixedClock('2026-11-03T04:05:06.789Z');
const APP = 'synthetic-refund-archive-wiring-app';

it.each(['api', 'worker', 'stream'] as const)(
  '[AC-B1-04zzu#13] %s 入口把 orders 的只读自家淘宝订单查询作为 taobaoOwnOrders 交给 UnionModule.forRoot：只读 app.orders（同 app、淘宝、所问单号），不加锁不写；空入参不查库、答空集',
  async (entry) => {
    const forRoot = vi.spyOn(UnionModule, 'forRoot');
    // As in the existing entry assembly tests: keep decorated controllers out of the spec
    // project's TypeScript compilation.
    const { AppModule } = (await import(
      new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href
    )) as { AppModule: { forEntry(options: object): unknown } };
    AppModule.forEntry({
      entry,
      config: loadConfig({ APP_ENV: 'test' }),
      clock,
      logger: createRootLogger({ level: 'silent', entry, appEnv: 'test' }, { write() {} }),
    });
    expect(forRoot).toHaveBeenCalled();
    const args: readonly unknown[] = forRoot.mock.calls.at(-1) ?? [];
    const options = args[1] as UnionModuleOptions | undefined;
    const read = options?.taobaoOwnOrders;
    expect(read).toBeTypeOf('function');

    const recorded = recordingDatabase();
    try {
      const nos = [tradeIdOf(1), tradeIdOf(50), tradeIdOf(1)];
      const found = await read!(recorded.db, APP, nos);
      expect(found).toBeInstanceOf(Set);
      expect([...found], 'no stored order: nothing found').toEqual([]);
      expectOwnOrderRead(recorded.statements, APP, [tradeIdOf(1), tradeIdOf(50)]);

      const asked = recorded.statements.length;
      const none = await read!(recorded.db, APP, []);
      expect([...none]).toEqual([]);
      expect(recorded.statements, 'an empty question reads nothing').toHaveLength(asked);
    } finally {
      await recorded.db.destroy();
    }
  },
);
