import { expect, it } from 'vitest';
import {
  APP,
  CONFIG_KEYS,
  NORMAL,
  endpoints,
  item,
  outcome,
  plan,
  viewer,
  wiringFixture,
  withOpenReads,
} from './kit.ts';

it('[AC-B2-03d#1] AppModule 选择矩阵：local/test/staging × demo/replay/live 与 prod 全模式', async () => {
  const f = wiringFixture();
  f.values.set('demo.rebate_quote_rule', { reserve_bp: 0, self_share_bp: 2000 });
  for (const appEnv of ['local', 'test', 'staging', 'prod'] as const) {
    for (const mode of ['demo', 'replay', 'live'] as const) {
      f.real.mockClear();
      f.demo.mockClear();
      const assembled = f.assembly(appEnv, endpoints([mode, mode, mode]));
      const result = await outcome(assembled.quote);
      expect(result, `${appEnv}/${mode} should start`).toHaveProperty('value');
      const real = appEnv === 'prod' || mode === 'live';
      expect(f.real).toHaveBeenCalledTimes(real ? 1 : 0);
      expect(f.demo).toHaveBeenCalledTimes(real ? 0 : 1);
      const quote = await result.value!.quote(item(), viewer({ userId: 'viewer-l2' }), NORMAL);
      expect(quote).toMatchObject({
        rebateMinFen: real ? 550n : 200n,
        rebateMaxFen: real ? 550n : 200n,
      });
      const ports = await assembled.open();
      f.configValue.mockClear();
      await withOpenReads(
        () => ports.quoteReads.prepare(plan()),
        async () => {
          // B1-05zc (D10-641): neither quoter reads rebate.taobao.compare_rate_ratio_bp any more,
          // so an open pre-reads it for neither (CONFIG_KEYS no longer lists it).
          const expected: readonly string[] = real
            ? CONFIG_KEYS
            : ['demo.rebate_quote_rule', 'tech_fee_bp'];
          expect(f.configValue.mock.calls.map(([appId, key]) => [appId, key]).sort()).toEqual(
            expected.map((key) => [APP, key]).sort(),
          );
          expect(f.configValue.mock.calls.map(([, key]) => key)).not.toContain(
            'rebate.taobao.compare_rate_ratio_bp',
          );
          f.configValue.mockClear();
          expect(await ports.quoter.quote(item(), viewer({ userId: 'viewer-l2' }), NORMAL)).toEqual(
            quote,
          );
          expect(f.configValue).not.toHaveBeenCalled();
        },
      );
    }
  }
});

it('[AC-B2-03d#2] 任意一个平台 live 就选真实报价器，包括非首位端点与混合 replay', async () => {
  const f = wiringFixture();
  for (const modes of [
    ['live', 'demo', 'replay'],
    ['demo', 'live', 'replay'],
    ['replay', 'demo', 'live'],
  ] as const) {
    f.real.mockClear();
    f.demo.mockClear();
    const result = await outcome(f.assembly('staging', endpoints(modes)).quote);
    expect(result).toHaveProperty('value');
    expect(f.real).toHaveBeenCalledTimes(1);
    expect(f.demo).not.toHaveBeenCalled();
    expect((await result.value!.quote(item(), viewer(), NORMAL)).rebateMaxFen).toBe(500n);
  }
});

it('[AC-B2-03d#3] prod 或任一 live 没有 DB 时装配即报缺库，不回退演示；其余环境可装配', async () => {
  const f = wiringFixture();
  for (const appEnv of ['local', 'test', 'staging', 'prod'] as const) {
    for (const mode of ['demo', 'replay', 'live'] as const) {
      f.demo.mockClear();
      const result = await outcome(
        f.assembly(appEnv, endpoints(['demo', 'demo', mode]), false).quote,
      );
      if (appEnv === 'prod' || mode === 'live') {
        expect(result).toHaveProperty('error');
        expect(result.error).toBeInstanceOf(Error);
        expect((result.error as Error).message).toMatch(/database|\bDB\b/iu);
        expect(f.demo).not.toHaveBeenCalled();
      } else {
        expect(result).toHaveProperty('value');
        expect(f.demo).toHaveBeenCalledTimes(1);
      }
    }
  }
});
